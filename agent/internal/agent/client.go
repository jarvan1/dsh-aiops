// Package agent implements the outbound WebSocket loop that connects one
// cluster to the AIOps server. The agent dials the server, identifies itself,
// and answers bounded read requests; the server never dials into the cluster.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/jarvan1/dsh-aiops/agent/internal/kube"
	"github.com/jarvan1/dsh-aiops/agent/internal/protocol"
)

const (
	maxInboundBytes = 1 << 20
	writeTimeout    = 10 * time.Second
	// handshakeTimeout bounds hello → welcome so a server that accepts the
	// upgrade but never answers does not hold the session open.
	handshakeTimeout = 10 * time.Second
)

// ErrUnauthorized means the server rejected the agent token. Retrying cannot
// help until an operator installs a valid token, so Run returns it.
var ErrUnauthorized = errors.New("agent token was rejected by the server")

// ErrIncompatible means the server and agent do not share a protocol version
// or the server sent a message this agent cannot honor. Run returns it.
var ErrIncompatible = errors.New("server and agent are incompatible")

// DialFunc opens the WebSocket. It exists so tests can point the agent at a
// local server without changing production behavior.
type DialFunc func(ctx context.Context, target string, header http.Header) (*websocket.Conn, *http.Response, error)

// Options configures a Client.
type Options struct {
	URL          *url.URL
	Token        string
	Name         string
	Version      string
	Capabilities protocol.Capabilities
	Executor     *kube.Executor
	Heartbeat    time.Duration
	Concurrency  int
	MinBackoff   time.Duration
	MaxBackoff   time.Duration
	Dial         DialFunc
	Logger       *slog.Logger
}

// Client is one agent process. Run reconnects until the context is cancelled.
type Client struct {
	url          string
	token        string
	name         string
	version      string
	capabilities protocol.Capabilities
	executor     *kube.Executor
	heartbeat    time.Duration
	concurrency  int32
	minBackoff   time.Duration
	maxBackoff   time.Duration
	dial         DialFunc
	logger       *slog.Logger
	inflight     atomic.Int32
	draining     atomic.Bool
}

// New validates options and builds a Client.
func New(options Options) (*Client, error) {
	if options.URL == nil {
		return nil, errors.New("server URL is required")
	}
	if options.URL.Scheme != "wss" && options.URL.Scheme != "ws" {
		return nil, fmt.Errorf("server URL must use ws or wss, got %q", options.URL.Scheme)
	}
	if options.URL.Host == "" {
		return nil, errors.New("server URL must include a host")
	}
	if options.URL.User != nil {
		return nil, errors.New("server URL must not embed credentials; use --token-file")
	}
	if strings.TrimSpace(options.Token) == "" {
		return nil, errors.New("agent token is required")
	}
	if !namePattern.MatchString(options.Name) || len(options.Name) > 63 {
		return nil, errors.New("client name must be a DNS label of at most 63 characters")
	}
	if options.Executor == nil {
		return nil, errors.New("Kubernetes executor is required")
	}
	if options.Version == "" {
		options.Version = "dev"
	}
	if options.Heartbeat <= 0 {
		options.Heartbeat = 15 * time.Second
	}
	if options.Concurrency <= 0 {
		options.Concurrency = 4
	}
	if options.MinBackoff <= 0 {
		options.MinBackoff = time.Second
	}
	if options.MaxBackoff < options.MinBackoff {
		options.MaxBackoff = 60 * time.Second
	}
	if options.Dial == nil {
		dialer := &websocket.Dialer{HandshakeTimeout: handshakeTimeout, Proxy: http.ProxyFromEnvironment}
		options.Dial = dialer.DialContext
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Client{
		url:          options.URL.String(),
		token:        options.Token,
		name:         options.Name,
		version:      options.Version,
		capabilities: options.Capabilities,
		executor:     options.Executor,
		heartbeat:    options.Heartbeat,
		concurrency:  int32(options.Concurrency),
		minBackoff:   options.MinBackoff,
		maxBackoff:   options.MaxBackoff,
		dial:         options.Dial,
		logger:       options.Logger,
	}, nil
}

// Run keeps one connection alive until ctx is cancelled, reconnecting with
// capped exponential backoff. It returns only on shutdown or a fatal error.
func (c *Client) Run(ctx context.Context) error {
	backoff := c.minBackoff
	for {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrUnauthorized) || errors.Is(err, ErrIncompatible) {
			return err
		}
		if time.Since(started) > 30*time.Second {
			backoff = c.minBackoff
		}
		c.logger.Warn("agent connection lost", "error", err.Error(), "retryIn", backoff.String())
		timer := time.NewTimer(jitter(backoff))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		backoff *= 2
		if backoff > c.maxBackoff {
			backoff = c.maxBackoff
		}
	}
}

func (c *Client) session(ctx context.Context) error {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.token)
	header.Set("User-Agent", "dsh-aiops-agent/"+c.version)
	ws, response, err := c.dial(ctx, c.url, header)
	if err != nil {
		if response != nil && (response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden) {
			return fmt.Errorf("%w: HTTP %d", ErrUnauthorized, response.StatusCode)
		}
		return fmt.Errorf("dial server: %w", err)
	}
	defer ws.Close()
	ws.SetReadLimit(maxInboundBytes)

	out := &connection{ws: ws}
	if err := out.write(protocol.NewHello(c.name, c.version, c.capabilities)); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	ws.SetReadDeadline(time.Now().Add(handshakeTimeout))
	_, raw, err := ws.ReadMessage()
	if err != nil {
		return fmt.Errorf("read welcome: %w", err)
	}
	message, err := protocol.DecodeServer(raw)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrIncompatible, err)
	}
	welcome, ok := message.(protocol.Welcome)
	if !ok {
		return fmt.Errorf("%w: expected welcome, got %T", ErrIncompatible, message)
	}
	if welcome.DesiredVersion != "" && welcome.DesiredVersion != c.version {
		c.logger.Info("server reports a different desired version", "desired", welcome.DesiredVersion, "running", c.version)
	}
	c.logger.Info("agent connected", "clientId", welcome.ClientID, "name", c.name, "version", c.version)

	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	ws.SetReadDeadline(time.Now().Add(c.readWindow()))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(c.readWindow())) })
	go c.keepalive(sessionCtx, out)
	// Closing the socket is what unblocks ReadMessage during shutdown; the
	// read deadline alone would delay a SIGTERM by a full heartbeat window.
	go func() {
		<-sessionCtx.Done()
		_ = ws.Close()
	}()
	return c.readLoop(sessionCtx, ws, out)
}

func (c *Client) readLoop(ctx context.Context, ws *websocket.Conn, out *connection) error {
	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return err
		}
		if err := ws.SetReadDeadline(time.Now().Add(c.readWindow())); err != nil {
			return err
		}
		message, err := protocol.DecodeServer(raw)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrIncompatible, err)
		}
		switch typed := message.(type) {
		case protocol.ReadRequest:
			c.dispatch(ctx, typed, out)
		case protocol.Probe:
			if err := out.write(protocol.Result{Type: "result", ID: typed.ID, OK: true, Data: protocol.ProbeData{
				Name: c.name, Version: c.version, Protocol: protocol.Version, Capabilities: c.capabilities,
			}}); err != nil {
				return err
			}
		case protocol.Upgrade:
			// Path A: the agent never replaces itself. The rollout system
			// applies the new image and the old pod is drained instead.
			if err := out.write(protocol.ErrorResult(typed.ID, protocol.CodeInvalidRequest, "self-upgrade is disabled; apply the rollout out of band")); err != nil {
				return err
			}
		case protocol.Drain:
			c.draining.Store(true)
			c.logger.Info("agent draining", "inflight", c.inflight.Load())
		case protocol.Resume:
			c.draining.Store(false)
			c.logger.Info("agent resumed")
		case protocol.ServerError:
			return fmt.Errorf("server reported %s: %s", typed.Code, typed.Message)
		default:
			return fmt.Errorf("%w: unexpected message %T", ErrIncompatible, message)
		}
	}
}

func (c *Client) dispatch(ctx context.Context, request protocol.ReadRequest, out *connection) {
	if c.draining.Load() {
		if err := out.write(protocol.ErrorResult(request.ID, protocol.CodeBusy, "agent is draining")); err != nil {
			c.logger.Warn("send busy result failed", "error", err.Error())
		}
		return
	}
	if c.inflight.Add(1) > c.concurrency {
		c.inflight.Add(-1)
		if err := out.write(protocol.ErrorResult(request.ID, protocol.CodeBusy, "agent read concurrency is exhausted")); err != nil {
			c.logger.Warn("send busy result failed", "error", err.Error())
		}
		return
	}
	go func() {
		defer c.inflight.Add(-1)
		result := c.execute(ctx, request)
		if writeErr := out.write(result); writeErr != nil {
			c.logger.Warn("send result failed", "id", request.ID, "error", writeErr.Error())
		}
	}()
}

// execute runs one read and converts its outcome to a result. A panic is
// turned into a typed error so one bad response cannot take down the agent and
// every other in-flight read with it.
func (c *Client) execute(ctx context.Context, request protocol.ReadRequest) (result protocol.Result) {
	defer func() {
		if recovered := recover(); recovered != nil {
			c.logger.Error("read handler panicked", "id", request.ID, "panic", fmt.Sprint(recovered))
			result = protocol.ErrorResult(request.ID, protocol.CodeInvalidResponse, "agent failed to complete the read")
		}
	}()
	data, truncated, err := c.executor.Execute(ctx, request)
	if err != nil {
		code, message := kube.CodeOf(err)
		return protocol.ErrorResult(request.ID, code, message)
	}
	return protocol.Result{Type: "result", ID: request.ID, OK: true, Data: data, Truncated: truncated}
}

func (c *Client) keepalive(ctx context.Context, out *connection) {
	pingEvery := c.heartbeat / 2
	if pingEvery < time.Second {
		pingEvery = time.Second
	}
	beat := time.NewTicker(c.heartbeat)
	defer beat.Stop()
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-beat.C:
			if err := out.write(protocol.Heartbeat{Type: "heartbeat", Version: c.version, Inflight: int(c.inflight.Load())}); err != nil {
				c.logger.Warn("send heartbeat failed", "error", err.Error())
				return
			}
		case <-ping.C:
			if err := out.ping(); err != nil {
				c.logger.Warn("send ping failed", "error", err.Error())
				return
			}
		}
	}
}

// readWindow is how long the agent tolerates silence. A server that stops
// answering pings is treated as gone and the connection is rebuilt.
func (c *Client) readWindow() time.Duration {
	window := c.heartbeat * 3
	if window < 5*time.Second {
		window = 5 * time.Second
	}
	return window
}

// connection serializes writes; gorilla permits one concurrent writer.
type connection struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *connection) write(message any) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ws.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	return c.ws.WriteMessage(websocket.TextMessage, data)
}

func (c *connection) ping() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout))
}

func jitter(duration time.Duration) time.Duration {
	half := duration / 2
	if half <= 0 {
		return duration
	}
	return half + time.Duration(rand.Int63n(int64(half)))
}

var namePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
