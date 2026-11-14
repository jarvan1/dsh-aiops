// Package kube is the agent's read-only Kubernetes access layer. It talks to
// the in-cluster API server over its own REST calls instead of client-go, which
// keeps the binary small and the surface closed to the operations in the
// protocol package.
package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jarvan1/dsh-aiops/agent/internal/protocol"
)

const (
	// DefaultServiceAccountDir is the standard in-cluster credential mount.
	DefaultServiceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"
	// DefaultMaxResponseBytes matches the native provider's default cap.
	DefaultMaxResponseBytes int64 = 2_000_000
	// DefaultRequestTimeout matches the native provider's default deadline.
	DefaultRequestTimeout = 30 * time.Second
)

// Error is a failed read carrying one of the closed protocol error codes.
type Error struct {
	Code    string
	Message string
	// Status is the HTTP status when the failure came from the API server.
	Status int
	Err    error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Err }

// Failure builds an Error with the given code.
func Failure(code, message string) *Error { return &Error{Code: code, Message: message} }

// CodeOf extracts the protocol error code from err, defaulting to unreachable.
func CodeOf(err error) (string, string) {
	var failure *Error
	if errors.As(err, &failure) {
		return failure.Code, failure.Message
	}
	return protocol.CodeUnreachable, messageOf(err)
}

func messageOf(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	if len(message) > 512 {
		message = message[:512]
	}
	return message
}

// Options configures a Client. TokenFile is re-read on every request so a
// projected service-account token rotation is picked up without a restart.
type Options struct {
	BaseURL            *url.URL
	Token              string
	TokenFile          string
	CA                 []byte
	CAFile             string
	InsecureSkipVerify bool
	Timeout            time.Duration
	MaxResponseBytes   int64
	HTTPClient         *http.Client
}

// Client performs bounded, read-only API requests.
type Client struct {
	base             *url.URL
	token            string
	tokenFile        string
	http             *http.Client
	timeout          time.Duration
	maxResponseBytes int64
	mu               sync.Mutex
}

// New builds a Client from explicit options.
func New(options Options) (*Client, error) {
	if options.BaseURL == nil {
		return nil, errors.New("base URL is required")
	}
	if options.BaseURL.Scheme != "https" {
		return nil, fmt.Errorf("Kubernetes API URL must use https, got %q", options.BaseURL.Scheme)
	}
	if options.BaseURL.Host == "" {
		return nil, errors.New("Kubernetes API URL must include a host")
	}
	if options.BaseURL.User != nil {
		return nil, errors.New("Kubernetes API URL must not embed credentials")
	}
	if options.Token == "" && options.TokenFile == "" {
		return nil, errors.New("a service-account token or token file is required")
	}
	if options.MaxResponseBytes <= 0 {
		options.MaxResponseBytes = DefaultMaxResponseBytes
	}
	if options.Timeout <= 0 {
		options.Timeout = DefaultRequestTimeout
	}
	client := &Client{
		base:             options.BaseURL,
		token:            options.Token,
		tokenFile:        options.TokenFile,
		timeout:          options.Timeout,
		maxResponseBytes: options.MaxResponseBytes,
	}
	if options.HTTPClient != nil {
		client.http = options.HTTPClient
		return client, nil
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	switch {
	case options.InsecureSkipVerify:
		tlsConfig.InsecureSkipVerify = true
	case len(options.CA) > 0 || options.CAFile != "":
		pem := options.CA
		if len(pem) == 0 {
			read, err := os.ReadFile(options.CAFile)
			if err != nil {
				return nil, fmt.Errorf("read cluster CA: %w", err)
			}
			pem = read
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("cluster CA does not contain a valid certificate")
		}
		tlsConfig.RootCAs = pool
	}
	client.http = &http.Client{
		Transport: &http.Transport{
			TLSClientConfig:     tlsConfig,
			MaxIdleConns:        8,
			MaxIdleConnsPerHost: 8,
			IdleConnTimeout:     90 * time.Second,
		},
	}
	return client, nil
}

// NewInCluster builds a Client from the pod's service-account mount at
// serviceAccountDir. It also returns the agent's own namespace, which is the
// default namespace for reads that omit one.
func NewInCluster(serviceAccountDir string, maxResponseBytes int64, timeout time.Duration) (*Client, string, error) {
	if strings.TrimSpace(serviceAccountDir) == "" {
		serviceAccountDir = DefaultServiceAccountDir
	}
	host := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST"))
	port := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_PORT_HTTPS"))
	if port == "" {
		port = strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_PORT"))
	}
	if host == "" || port == "" {
		return nil, "", errors.New("KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT are not set; the agent must run inside a cluster")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	base, err := url.Parse("https://" + host + ":" + port)
	if err != nil {
		return nil, "", fmt.Errorf("build Kubernetes API URL: %w", err)
	}
	namespace, err := os.ReadFile(serviceAccountDir + "/namespace")
	if err != nil {
		return nil, "", fmt.Errorf("read service-account namespace: %w", err)
	}
	client, err := New(Options{
		BaseURL:          base,
		TokenFile:        serviceAccountDir + "/token",
		CAFile:           serviceAccountDir + "/ca.crt",
		Timeout:          timeout,
		MaxResponseBytes: maxResponseBytes,
	})
	if err != nil {
		return nil, "", err
	}
	return client, strings.TrimSpace(string(namespace)), nil
}

// Server returns the API server URL without credentials for display.
func (c *Client) Server() string { return c.base.String() }

// Get fetches a JSON object path with query and returns at most
// MaxResponseBytes of the body. The path must be built from validated segments;
// callers never pass user input through verbatim.
func (c *Client) Get(ctx context.Context, path string, query url.Values) ([]byte, error) {
	return c.get(ctx, path, query, "application/json")
}

// GetText fetches a non-JSON path such as a Pod log. The API server negotiates
// the log subresource through its normal content types and answers 406 for an
// explicit text/plain request, so accept anything and read the raw body.
func (c *Client) GetText(ctx context.Context, path string, query url.Values) ([]byte, error) {
	return c.get(ctx, path, query, "*/*")
}

func (c *Client) get(ctx context.Context, path string, query url.Values, accept string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base.String()+path, nil)
	if err != nil {
		return nil, Failure(protocol.CodeInvalidRequest, "build Kubernetes request: "+messageOf(err))
	}
	if len(query) > 0 {
		request.URL.RawQuery = query.Encode()
	}
	token, err := c.resolveToken()
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Authorization", "Bearer "+token)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, c.transportError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, statusError(response.StatusCode, detail)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, c.maxResponseBytes+1))
	if err != nil {
		return nil, c.transportError(err)
	}
	if int64(len(data)) > c.maxResponseBytes {
		return nil, Failure(protocol.CodeResponseTooLarge, fmt.Sprintf("Kubernetes response exceeds %d bytes.", c.maxResponseBytes))
	}
	return data, nil
}

// WithTimeout applies the configured per-request deadline to ctx.
func (c *Client) WithTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, c.timeout)
}

func (c *Client) resolveToken() (string, error) {
	if c.tokenFile == "" {
		return c.token, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := os.ReadFile(c.tokenFile)
	if err != nil {
		return "", Failure(protocol.CodeAuthenticationFailed, "read service-account token: "+messageOf(err))
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", Failure(protocol.CodeAuthenticationFailed, "service-account token is empty")
	}
	return token, nil
}

func (c *Client) transportError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &Error{Code: protocol.CodeTimeout, Message: fmt.Sprintf("Kubernetes request exceeded %s.", c.timeout), Err: err}
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return &Error{Code: protocol.CodeTimeout, Message: fmt.Sprintf("Kubernetes request exceeded %s.", c.timeout), Err: err}
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return &Error{Code: protocol.CodeAuthenticationFailed, Message: "Kubernetes API TLS certificate is not trusted by the cluster CA.", Err: err}
	}
	return &Error{Code: protocol.CodeUnreachable, Message: "Kubernetes API request failed: " + messageOf(err), Err: err}
}

func statusError(status int, detail []byte) error {
	reason := statusReason(detail)
	message := fmt.Sprintf("Kubernetes API returned HTTP %d.", status)
	if reason != "" {
		message += " " + reason
	}
	code := protocol.CodeUnreachable
	switch {
	case status == http.StatusUnauthorized:
		code = protocol.CodeAuthenticationFailed
		message = "Kubernetes rejected the agent credentials."
	case status == http.StatusForbidden:
		code = protocol.CodeForbidden
		message = "Kubernetes denied the requested read operation." + bracket(reason)
	case status == http.StatusNotFound:
		code = protocol.CodeNotFound
		message = "The requested Kubernetes object was not found." + bracket(reason)
	case status >= 400 && status < 500:
		code = protocol.CodeInvalidRequest
	}
	return &Error{Code: code, Message: message, Status: status}
}

// statusReason extracts the bounded message from a Kubernetes Status body.
func statusReason(body []byte) string {
	var status struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &status); err != nil {
		return ""
	}
	return clamp(status.Message, 240)
}

func bracket(value string) string {
	if value == "" {
		return ""
	}
	return " (" + value + ")"
}

func clamp(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

var (
	namespacePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	objectPattern    = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
)

func validNamespace(namespace string) error {
	if len(namespace) == 0 || len(namespace) > 63 || !namespacePattern.MatchString(namespace) {
		return Failure(protocol.CodeInvalidRequest, "namespace must be a valid DNS label")
	}
	return nil
}

func validObjectName(kind, name string) error {
	if len(name) == 0 || len(name) > 253 || !objectPattern.MatchString(name) {
		return Failure(protocol.CodeInvalidRequest, kind+" must be a valid DNS subdomain name")
	}
	return nil
}

func validContainerName(name string) error {
	if len(name) == 0 || len(name) > 63 || !namespacePattern.MatchString(name) {
		return Failure(protocol.CodeInvalidRequest, "container must be a valid DNS label")
	}
	return nil
}
