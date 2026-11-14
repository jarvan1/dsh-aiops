package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/jarvan1/dsh-aiops/agent/internal/kube"
	"github.com/jarvan1/dsh-aiops/agent/internal/protocol"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func newTestExecutor(t *testing.T) *kube.Executor {
	t.Helper()
	base, err := url.Parse("https://kubernetes.test")
	if err != nil {
		t.Fatal(err)
	}
	client, err := kube.New(kube.Options{
		BaseURL: base,
		Token:   "cluster-token",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"kind":"Pod","metadata":{"name":"api-1"}}`)),
				Request:    request,
			}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	executor, err := kube.NewExecutor(kube.ExecutorOptions{Client: client, Namespace: "payments"})
	if err != nil {
		t.Fatal(err)
	}
	return executor
}

type wsServer struct {
	server      *httptest.Server
	connections atomic.Int32
}

func newWSServer(t *testing.T, handler func(conn *websocket.Conn, request *http.Request)) *wsServer {
	t.Helper()
	created := &wsServer{}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	created.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		created.connections.Add(1)
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		handler(conn, r)
	}))
	t.Cleanup(created.server.Close)
	return created
}

func wsURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Scheme = "ws"
	return parsed
}

func readMessage(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read message: %v", err)
	}
	var message map[string]any
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatalf("decode message: %v", err)
	}
	return message
}

// nextOfType skips heartbeats so tests stay independent of keepalive timing.
func nextOfType(t *testing.T, conn *websocket.Conn, want string) map[string]any {
	t.Helper()
	for attempt := 0; attempt < 10; attempt++ {
		message := readMessage(t, conn)
		if message["type"] == want {
			return message
		}
	}
	t.Fatalf("no %q message arrived", want)
	return nil
}

func writeMessage(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	if err := conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(value); err != nil {
		t.Fatalf("write message: %v", err)
	}
}

func welcome(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	writeMessage(t, conn, map[string]any{"type": "welcome", "protocol": protocol.Version, "clientId": "cli_01"})
}

func runAgent(t *testing.T, target *url.URL, executor *kube.Executor) (context.CancelFunc, <-chan error) {
	t.Helper()
	client, err := New(Options{
		URL:         target,
		Token:       "secret-token",
		Name:        "prod-east",
		Version:     "test",
		Executor:    executor,
		Heartbeat:   10 * time.Second,
		Concurrency: 2,
		MinBackoff:  10 * time.Millisecond,
		MaxBackoff:  20 * time.Millisecond,
		Capabilities: protocol.Capabilities{
			Resources: []string{"pods"}, Logs: true, MaxResponseBytes: kube.DefaultMaxResponseBytes, MaxTailLines: 100,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	return cancel, done
}

func TestHandshakeAuthenticatesAndAnswersReads(t *testing.T) {
	results := make(chan map[string]any, 1)
	server := newWSServer(t, func(conn *websocket.Conn, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer secret-token" {
			t.Errorf("unexpected authorization header %q", got)
		}
		if got := request.Header.Get("User-Agent"); got != "dsh-aiops-agent/test" {
			t.Errorf("unexpected user agent %q", got)
		}
		hello := readMessage(t, conn)
		if hello["type"] != "hello" || hello["name"] != "prod-east" || hello["protocol"] != float64(protocol.Version) {
			t.Errorf("unexpected hello %#v", hello)
		}
		capabilities := hello["capabilities"].(map[string]any)
		if capabilities["logs"] != true {
			t.Errorf("hello did not advertise logs: %#v", capabilities)
		}
		welcome(t, conn)
		writeMessage(t, conn, map[string]any{"type": "read", "id": "r1", "op": "get", "resource": "pods", "name": "api-1"})
		results <- nextOfType(t, conn, "result")
	})

	cancel, done := runAgent(t, wsURL(t, server.server.URL), newTestExecutor(t))
	defer cancel()
	result := <-results
	if result["id"] != "r1" || result["ok"] != true {
		t.Fatalf("unexpected result %#v", result)
	}
	if result["data"].(map[string]any)["kind"] != "Pod" {
		t.Fatalf("unexpected data %#v", result["data"])
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("expected clean shutdown, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not stop after cancellation")
	}
}

func TestProbeUpgradeDrainAndResume(t *testing.T) {
	finished := make(chan struct{})
	server := newWSServer(t, func(conn *websocket.Conn, request *http.Request) {
		defer close(finished)
		readMessage(t, conn) // hello
		welcome(t, conn)

		writeMessage(t, conn, map[string]any{"type": "probe", "id": "p1"})
		probe := nextOfType(t, conn, "result")
		if probe["ok"] != true {
			t.Errorf("probe failed: %#v", probe)
		}
		if probe["data"].(map[string]any)["name"] != "prod-east" {
			t.Errorf("unexpected probe data %#v", probe["data"])
		}

		writeMessage(t, conn, map[string]any{"type": "upgrade", "id": "u1", "targetVersion": "9.9.9"})
		upgrade := nextOfType(t, conn, "result")
		if upgrade["ok"] != false || upgrade["code"] != protocol.CodeInvalidRequest {
			t.Errorf("self-upgrade must be refused: %#v", upgrade)
		}

		writeMessage(t, conn, map[string]any{"type": "drain"})
		writeMessage(t, conn, map[string]any{"type": "read", "id": "r2", "op": "get", "resource": "pods", "name": "api-1"})
		drained := nextOfType(t, conn, "result")
		if drained["code"] != protocol.CodeBusy {
			t.Errorf("draining agent must answer busy: %#v", drained)
		}

		writeMessage(t, conn, map[string]any{"type": "resume"})
		writeMessage(t, conn, map[string]any{"type": "read", "id": "r3", "op": "get", "resource": "pods", "name": "api-1"})
		resumed := nextOfType(t, conn, "result")
		if resumed["ok"] != true {
			t.Errorf("resumed agent must answer reads: %#v", resumed)
		}
	})

	cancel, done := runAgent(t, wsURL(t, server.server.URL), newTestExecutor(t))
	defer cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not answer probe, upgrade, drain, and resume")
	}
	cancel()
	<-done
}

func TestHeartbeatsReachTheServer(t *testing.T) {
	beats := make(chan map[string]any, 1)
	server := newWSServer(t, func(conn *websocket.Conn, request *http.Request) {
		readMessage(t, conn)
		welcome(t, conn)
		beats <- nextOfType(t, conn, "heartbeat")
		// Hold the connection until the test stops the agent.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	client, err := New(Options{
		URL: wsURL(t, server.server.URL), Token: "secret-token", Name: "prod-east",
		Version: "test", Executor: newTestExecutor(t), Heartbeat: time.Second, MinBackoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	defer cancel()
	select {
	case beat := <-beats:
		if beat["type"] != "heartbeat" {
			t.Fatalf("unexpected heartbeat %#v", beat)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no heartbeat arrived")
	}
	cancel()
	<-done
}

func TestUnauthorizedTokenIsFatal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	client, err := New(Options{
		URL: wsURL(t, server.URL), Token: "bad-token", Name: "prod-east",
		Version: "test", Executor: newTestExecutor(t), MinBackoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = client.Run(ctx)
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized, got %v", err)
	}
}

func TestProtocolMismatchIsFatal(t *testing.T) {
	server := newWSServer(t, func(conn *websocket.Conn, request *http.Request) {
		readMessage(t, conn)
		writeMessage(t, conn, map[string]any{"type": "welcome", "protocol": 99, "clientId": "cli_01"})
	})
	client, err := New(Options{
		URL: wsURL(t, server.server.URL), Token: "secret-token", Name: "prod-east",
		Version: "test", Executor: newTestExecutor(t), MinBackoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Run(ctx); !errors.Is(err, ErrIncompatible) {
		t.Fatalf("expected ErrIncompatible, got %v", err)
	}
}

func TestMalformedServerMessageIsFatal(t *testing.T) {
	server := newWSServer(t, func(conn *websocket.Conn, request *http.Request) {
		readMessage(t, conn)
		welcome(t, conn)
		writeMessage(t, conn, map[string]any{"type": "read", "op": "get", "resource": "pods"})
	})
	client, err := New(Options{
		URL: wsURL(t, server.server.URL), Token: "secret-token", Name: "prod-east",
		Version: "test", Executor: newTestExecutor(t), MinBackoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Run(ctx); !errors.Is(err, ErrIncompatible) {
		t.Fatalf("expected ErrIncompatible, got %v", err)
	}
}

func TestAgentReconnectsAfterTheServerCloses(t *testing.T) {
	results := make(chan map[string]any, 1)
	var server *wsServer
	server = newWSServer(t, func(conn *websocket.Conn, request *http.Request) {
		readMessage(t, conn)
		welcome(t, conn)
		if server.connections.Load() == 1 {
			return // drop the first connection
		}
		writeMessage(t, conn, map[string]any{"type": "read", "id": "r7", "op": "get", "resource": "pods", "name": "api-1"})
		results <- nextOfType(t, conn, "result")
	})
	cancel, done := runAgent(t, wsURL(t, server.server.URL), newTestExecutor(t))
	defer cancel()
	select {
	case result := <-results:
		if result["id"] != "r7" || result["ok"] != true {
			t.Fatalf("unexpected result after reconnect %#v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not reconnect")
	}
	if server.connections.Load() < 2 {
		t.Fatalf("expected at least two connections, got %d", server.connections.Load())
	}
	cancel()
	<-done
}
