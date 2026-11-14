package kube

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jarvan1/dsh-aiops/agent/internal/protocol"
)

func newTestExecutor(t *testing.T, handler http.HandlerFunc, maxBytes int64) *Executor {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := New(Options{
		BaseURL:            base,
		Token:              "test-token",
		InsecureSkipVerify: true,
		Timeout:            5 * time.Second,
		MaxResponseBytes:   maxBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	executor, err := NewExecutor(ExecutorOptions{
		Client:           client,
		Namespace:        "agent-ns",
		DefaultTailLines: 50,
		MaxTailLines:     100,
	})
	if err != nil {
		t.Fatal(err)
	}
	return executor
}

func requireCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error code %s, got none", want)
	}
	code, _ := CodeOf(err)
	if code != want {
		t.Fatalf("expected code %s, got %s (%v)", want, code, err)
	}
}

func TestGetReadsOneNamedObject(t *testing.T) {
	var called atomic.Int32
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("missing bearer token, got %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path != "/api/v1/namespaces/payments/pods/api-1" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"kind":"Pod","metadata":{"name":"api-1"}}`))
	}, DefaultMaxResponseBytes)

	data, truncated, err := executor.Execute(context.Background(), protocol.ReadRequest{
		ID: "r1", Op: protocol.OpGet, Resource: "pods", Namespace: "payments", Name: "api-1",
	})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if truncated {
		t.Fatal("a single object cannot be truncated")
	}
	object, ok := data.(map[string]any)
	if !ok || object["kind"] != "Pod" {
		t.Fatalf("unexpected data %#v", data)
	}
	if called.Load() != 1 {
		t.Fatalf("expected one API call, got %d", called.Load())
	}
}

func TestGetDefaultsToAgentNamespace(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/namespaces/agent-ns/pods/api-1" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"kind":"Pod"}`))
	}, DefaultMaxResponseBytes)
	if _, _, err := executor.Execute(context.Background(), protocol.ReadRequest{ID: "r1", Op: protocol.OpGet, Resource: "pod", Name: "api-1"}); err != nil {
		t.Fatalf("get: %v", err)
	}
}

func TestClusterScopedResourceIgnoresNamespace(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/nodes/node-1" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"kind":"Node"}`))
	}, DefaultMaxResponseBytes)
	if _, _, err := executor.Execute(context.Background(), protocol.ReadRequest{
		ID: "r1", Op: protocol.OpGet, Resource: "nodes", Namespace: "payments", Name: "node-1",
	}); err != nil {
		t.Fatalf("get: %v", err)
	}
}

func TestUnsupportedResourceIsRejectedBeforeTheAPICall(t *testing.T) {
	var called atomic.Int32
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
	}, DefaultMaxResponseBytes)
	_, _, err := executor.Execute(context.Background(), protocol.ReadRequest{
		ID: "r1", Op: protocol.OpGet, Resource: "secrets", Name: "admin",
	})
	requireCode(t, err, protocol.CodeUnsupportedResource)
	if called.Load() != 0 {
		t.Fatal("unsupported resources must never reach the API server")
	}
}

func TestInvalidNamespaceIsRejectedBeforeTheAPICall(t *testing.T) {
	var called atomic.Int32
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
	}, DefaultMaxResponseBytes)
	_, _, err := executor.Execute(context.Background(), protocol.ReadRequest{
		ID: "r1", Op: protocol.OpGet, Resource: "pods", Namespace: "Payments/../x", Name: "api-1",
	})
	requireCode(t, err, protocol.CodeInvalidRequest)
	if called.Load() != 0 {
		t.Fatal("invalid names must never reach the API server")
	}
}

func TestStatusMapping(t *testing.T) {
	cases := map[int]string{
		http.StatusUnauthorized:        protocol.CodeAuthenticationFailed,
		http.StatusForbidden:           protocol.CodeForbidden,
		http.StatusNotFound:            protocol.CodeNotFound,
		http.StatusBadRequest:          protocol.CodeInvalidRequest,
		http.StatusInternalServerError: protocol.CodeUnreachable,
	}
	for status, want := range cases {
		t.Run(http.StatusText(status), func(t *testing.T) {
			executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"detail"}`))
			}, DefaultMaxResponseBytes)
			_, _, err := executor.Execute(context.Background(), protocol.ReadRequest{ID: "r1", Op: protocol.OpGet, Resource: "pods", Name: "api-1"})
			requireCode(t, err, want)
		})
	}
}

func TestListBoundsTheResponseAndReportsContinuation(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("labelSelector") != "app=api" {
			t.Errorf("unexpected labelSelector %q", query.Get("labelSelector"))
		}
		if query.Get("fieldSelector") != "metadata.namespace=payments" {
			t.Errorf("unexpected fieldSelector %q", query.Get("fieldSelector"))
		}
		if r.URL.Path != "/api/v1/namespaces/payments/pods" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"kind":"PodList","metadata":{"continue":"next"},"items":[]}`))
	}, DefaultMaxResponseBytes)
	_, truncated, err := executor.Execute(context.Background(), protocol.ReadRequest{
		ID: "r1", Op: protocol.OpList, Resource: "pods", Namespace: "payments",
		LabelSelector: " app=api ", FieldSelector: "metadata.namespace=payments",
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !truncated {
		t.Fatal("a continuation token must be reported as truncated")
	}
}

func TestOversizedResponseIsRejected(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 200)))
	}, 64)
	_, _, err := executor.Execute(context.Background(), protocol.ReadRequest{ID: "r1", Op: protocol.OpGet, Resource: "pods", Name: "api-1"})
	requireCode(t, err, protocol.CodeResponseTooLarge)
}

func TestInvalidJSONIsReported(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	}, DefaultMaxResponseBytes)
	_, _, err := executor.Execute(context.Background(), protocol.ReadRequest{ID: "r1", Op: protocol.OpGet, Resource: "pods", Name: "api-1"})
	requireCode(t, err, protocol.CodeInvalidResponse)
}

func TestEventsSortsAndFiltersByWindow(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/namespaces/agent-ns/events" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"kind":"EventList","items":[
			{"metadata":{"name":"b"},"firstTimestamp":"2026-11-14T10:02:00Z","lastTimestamp":"2026-11-14T10:03:00Z"},
			{"metadata":{"name":"a"},"firstTimestamp":"2026-11-14T10:00:00Z","lastTimestamp":"2026-11-14T10:01:00Z"},
			{"metadata":{"name":"c"},"firstTimestamp":"2026-11-14T09:00:00Z","lastTimestamp":"2026-11-14T09:01:00Z"}
		]}`))
	}, DefaultMaxResponseBytes)
	data, _, err := executor.Execute(context.Background(), protocol.ReadRequest{
		ID: "r1", Op: protocol.OpEvents, SinceTime: "2026-11-14T09:30:00Z", UntilTime: "2026-11-14T10:30:00Z",
	})
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	items := data.(map[string]any)["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("expected two events in the window, got %d", len(items))
	}
	first := items[0].(map[string]any)["metadata"].(map[string]any)["name"]
	second := items[1].(map[string]any)["metadata"].(map[string]any)["name"]
	if first != "a" || second != "b" {
		t.Fatalf("events were not sorted chronologically: %v, %v", first, second)
	}
}

func TestLogsClampTailLinesAndFilterUpperBound(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if r.URL.Path != "/api/v1/namespaces/payments/pods/api-1/log" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		// The API server answers 406 for an explicit text/plain Accept on the
		// log subresource, so the agent must accept any media type.
		if accept := r.Header.Get("Accept"); accept != "*/*" {
			t.Errorf("unexpected log Accept header %q", accept)
		}
		if query.Get("tailLines") != "100" {
			t.Errorf("tailLines was not clamped: %q", query.Get("tailLines"))
		}
		if query.Get("timestamps") != "true" {
			t.Errorf("untilTime must enable timestamps: %q", query.Get("timestamps"))
		}
		if query.Get("sinceSeconds") != "900" {
			t.Errorf("unexpected sinceSeconds %q", query.Get("sinceSeconds"))
		}
		if query.Get("previous") != "true" {
			t.Errorf("previous was not forwarded: %q", query.Get("previous"))
		}
		if query.Get("container") != "api" {
			t.Errorf("unexpected container %q", query.Get("container"))
		}
		_, _ = w.Write([]byte("2026-11-14T10:00:00.000000000Z first\n2026-11-14T10:05:00.000000000Z second\n2026-11-14T10:10:00.000000000Z third\n"))
	}, DefaultMaxResponseBytes)
	tail := 500
	timestamps := true
	data, _, err := executor.Execute(context.Background(), protocol.ReadRequest{
		ID: "r1", Op: protocol.OpLogs, Namespace: "payments", Pod: "api-1", Container: "api",
		Previous: true, TailLines: &tail, Since: "15m", UntilTime: "2026-11-14T10:06:00Z", Timestamps: &timestamps,
	})
	if err != nil {
		t.Fatalf("logs: %v", err)
	}
	output := data.(string)
	if strings.Contains(output, "third") {
		t.Fatalf("untilTime did not filter later lines: %q", output)
	}
	if !strings.Contains(output, "first") || !strings.Contains(output, "second") {
		t.Fatalf("untilTime dropped lines it should keep: %q", output)
	}
}

func TestLogsUseDefaultTailLines(t *testing.T) {
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("tailLines") != "50" {
			t.Errorf("unexpected default tailLines %q", r.URL.Query().Get("tailLines"))
		}
		_, _ = w.Write([]byte("line\n"))
	}, DefaultMaxResponseBytes)
	if _, _, err := executor.Execute(context.Background(), protocol.ReadRequest{ID: "r1", Op: protocol.OpLogs, Pod: "api-1"}); err != nil {
		t.Fatalf("logs: %v", err)
	}
}

func TestInvalidSinceIsRejectedBeforeTheAPICall(t *testing.T) {
	var called atomic.Int32
	executor := newTestExecutor(t, func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
	}, DefaultMaxResponseBytes)
	_, _, err := executor.Execute(context.Background(), protocol.ReadRequest{ID: "r1", Op: protocol.OpLogs, Pod: "api-1", Since: "15 minutes"})
	requireCode(t, err, protocol.CodeInvalidRequest)
	if called.Load() != 0 {
		t.Fatal("invalid durations must never reach the API server")
	}
}

func TestRequestDeadlineIsReportedAsTimeout(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, err := New(Options{
		BaseURL: base, Token: "test-token", InsecureSkipVerify: true,
		Timeout: 20 * time.Millisecond, MaxResponseBytes: DefaultMaxResponseBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	executor, err := NewExecutor(ExecutorOptions{Client: client, Namespace: "agent-ns"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = executor.Execute(context.Background(), protocol.ReadRequest{ID: "r1", Op: protocol.OpGet, Resource: "pods", Name: "api-1"})
	requireCode(t, err, protocol.CodeTimeout)
}

func TestNewRejectsInsecureBaseURL(t *testing.T) {
	base, _ := url.Parse("http://kubernetes.test")
	_, err := New(Options{BaseURL: base, Token: "test-token"})
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("expected https requirement, got %v", err)
	}
}

func TestNewRequiresAToken(t *testing.T) {
	base, _ := url.Parse("https://kubernetes.test")
	_, err := New(Options{BaseURL: base})
	if err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("expected token requirement, got %v", err)
	}
}

func TestCapabilityResourcesAreCanonical(t *testing.T) {
	resources := CapabilityResources()
	if len(resources) != 14 {
		t.Fatalf("expected 14 canonical resources, got %d: %v", len(resources), resources)
	}
	seen := map[string]bool{}
	for index, resource := range resources {
		if seen[resource] {
			t.Fatalf("duplicate capability %q", resource)
		}
		seen[resource] = true
		if index > 0 && resources[index-1] > resource {
			t.Fatalf("capabilities are not sorted: %v", resources)
		}
	}
}

func TestErrorCodeFallsBackToUnreachable(t *testing.T) {
	code, _ := CodeOf(errors.New("boom"))
	if code != protocol.CodeUnreachable {
		t.Fatalf("unexpected fallback code %s", code)
	}
}
