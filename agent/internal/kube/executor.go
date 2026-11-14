package kube

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jarvan1/dsh-aiops/agent/internal/protocol"
)

const (
	// DefaultDefaultTailLines and DefaultMaxTailLines mirror the native
	// provider's log bounds.
	DefaultDefaultTailLines = 200
	DefaultMaxTailLines     = 2_000
)

// ExecutorOptions configures an Executor.
type ExecutorOptions struct {
	Client           *Client
	Namespace        string
	DefaultTailLines int
	MaxTailLines     int
}

// Executor turns one protocol read request into one bounded API call. It is
// safe for concurrent use; all state is immutable after construction.
type Executor struct {
	client           *Client
	namespace        string
	defaultTailLines int
	maxTailLines     int
}

// NewExecutor validates and builds an Executor.
func NewExecutor(options ExecutorOptions) (*Executor, error) {
	if options.Client == nil {
		return nil, Failure(protocol.CodeInvalidRequest, "Kubernetes client is required")
	}
	if err := validNamespace(options.Namespace); err != nil {
		return nil, err
	}
	if options.DefaultTailLines <= 0 {
		options.DefaultTailLines = DefaultDefaultTailLines
	}
	if options.MaxTailLines <= 0 {
		options.MaxTailLines = DefaultMaxTailLines
	}
	if options.DefaultTailLines > options.MaxTailLines {
		options.DefaultTailLines = options.MaxTailLines
	}
	return &Executor{
		client:           options.Client,
		namespace:        options.Namespace,
		defaultTailLines: options.DefaultTailLines,
		maxTailLines:     options.MaxTailLines,
	}, nil
}

// MaxTailLines reports the configured log line cap.
func (e *Executor) MaxTailLines() int { return e.maxTailLines }

// Execute answers one read request. The returned data is the Kubernetes JSON
// object for get/list/events and the log text for logs.
func (e *Executor) Execute(ctx context.Context, request protocol.ReadRequest) (data any, truncated bool, err error) {
	if err := request.Validate(); err != nil {
		return nil, false, Failure(protocol.CodeInvalidRequest, err.Error())
	}
	ctx, cancel := e.client.WithTimeout(ctx)
	defer cancel()
	switch request.Op {
	case protocol.OpGet:
		return e.readObject(ctx, request, true)
	case protocol.OpList:
		return e.readObject(ctx, request, false)
	case protocol.OpEvents:
		return e.readEvents(ctx, request)
	case protocol.OpLogs:
		return e.readLogs(ctx, request)
	default:
		return nil, false, Failure(protocol.CodeInvalidRequest, "unsupported read operation")
	}
}

func (e *Executor) readObject(ctx context.Context, request protocol.ReadRequest, named bool) (any, bool, error) {
	resource, ok := Lookup(request.Resource)
	if !ok {
		return nil, false, Failure(protocol.CodeUnsupportedResource, "resource is not in the agent allowlist: "+clamp(request.Resource, 64))
	}
	path, err := e.resourcePath(resource, request.Namespace)
	if err != nil {
		return nil, false, err
	}
	query := url.Values{}
	if named {
		if err := validObjectName("name", request.Name); err != nil {
			return nil, false, err
		}
		path += "/" + request.Name
	} else if err := addSelectors(query, request); err != nil {
		return nil, false, err
	}
	raw, err := e.client.Get(ctx, path, query)
	if err != nil {
		return nil, false, err
	}
	var object map[string]any

	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, false, Failure(protocol.CodeInvalidResponse, "Kubernetes returned invalid JSON.")
	}
	return object, !named && hasMore(object), nil
}

func (e *Executor) readEvents(ctx context.Context, request protocol.ReadRequest) (any, bool, error) {
	namespace := e.namespaceOrDefault(request.Namespace)
	if err := validNamespace(namespace); err != nil {
		return nil, false, err
	}
	query := url.Values{}
	if err := addSelectors(query, request); err != nil {
		return nil, false, err
	}
	raw, err := e.client.Get(ctx, "/api/v1/namespaces/"+namespace+"/events", query)
	if err != nil {
		return nil, false, err
	}
	var list map[string]any
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, false, Failure(protocol.CodeInvalidResponse, "Kubernetes returned invalid JSON.")
	}
	items, ok := list["items"].([]any)
	if !ok {
		return nil, false, Failure(protocol.CodeInvalidResponse, "Kubernetes Event response has no items array.")
	}
	since, until, err := protocol.ParseWindow(request.SinceTime, request.UntilTime)
	if err != nil {
		return nil, false, Failure(protocol.CodeInvalidRequest, err.Error())
	}
	sorted := make([]any, len(items))
	copy(sorted, items)
	sort.SliceStable(sorted, func(left, right int) bool {
		return eventStart(sorted[left]) < eventStart(sorted[right])
	})
	if since != nil || until != nil {
		filtered := make([]any, 0, len(sorted))
		for _, item := range sorted {
			if eventOverlaps(item, since, until) {
				filtered = append(filtered, item)
			}
		}
		sorted = filtered
	}
	list["items"] = sorted
	return list, hasMore(list), nil
}

func (e *Executor) readLogs(ctx context.Context, request protocol.ReadRequest) (any, bool, error) {
	namespace := e.namespaceOrDefault(request.Namespace)
	if err := validNamespace(namespace); err != nil {
		return nil, false, err
	}
	if err := validObjectName("pod", request.Pod); err != nil {
		return nil, false, err
	}
	if request.Container != "" {
		if err := validContainerName(request.Container); err != nil {
			return nil, false, err
		}
	}
	sinceSeconds, err := parseSince(request.Since)
	if err != nil {
		return nil, false, err
	}
	tailLines := e.defaultTailLines
	if request.TailLines != nil {
		tailLines = *request.TailLines
	}
	if tailLines > e.maxTailLines {
		tailLines = e.maxTailLines
	}
	timestamps := request.UntilTime != ""
	if request.Timestamps != nil {
		timestamps = *request.Timestamps
	}
	if request.UntilTime != "" && !timestamps {
		return nil, false, Failure(protocol.CodeInvalidRequest, "untilTime requires timestamps to be enabled")
	}
	query := url.Values{
		"tailLines":  {strconv.Itoa(tailLines)},
		"timestamps": {strconv.FormatBool(timestamps)},
	}
	if request.Container != "" {
		query.Set("container", request.Container)
	}
	if request.Previous {
		query.Set("previous", "true")
	}
	if sinceSeconds > 0 {
		query.Set("sinceSeconds", strconv.FormatInt(sinceSeconds, 10))
	}
	if request.SinceTime != "" {
		query.Set("sinceTime", request.SinceTime)
	}
	raw, err := e.client.GetText(ctx, "/api/v1/namespaces/"+namespace+"/pods/"+request.Pod+"/log", query)
	if err != nil {
		return nil, false, err
	}
	output := string(raw)
	if request.UntilTime != "" {
		output = filterLogUntil(output, request.UntilTime)
	}
	return output, false, nil
}

func (e *Executor) namespaceOrDefault(namespace string) string {
	if strings.TrimSpace(namespace) == "" {
		return e.namespace
	}
	return strings.TrimSpace(namespace)
}

// resourcePath returns the collection path for resource. Namespaced resources
// default to the agent's own namespace, matching the native provider's
// context-default behavior.
func (e *Executor) resourcePath(resource Resource, namespace string) (string, error) {
	if !resource.Namespaced {
		return resource.APIPath + "/" + resource.Plural, nil
	}
	namespace = e.namespaceOrDefault(namespace)
	if err := validNamespace(namespace); err != nil {
		return "", err
	}
	return resource.APIPath + "/namespaces/" + namespace + "/" + resource.Plural, nil
}

func addSelectors(query url.Values, request protocol.ReadRequest) error {
	if err := addSelector(query, "labelSelector", request.LabelSelector); err != nil {
		return err
	}
	return addSelector(query, "fieldSelector", request.FieldSelector)
}

func addSelector(query url.Values, name, value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) > 1024 {
		return Failure(protocol.CodeInvalidRequest, name+" exceeds 1024 characters")
	}
	query.Set(name, trimmed)
	return nil
}

var sincePattern = regexp.MustCompile(`^(\d+)(s|m|h|d)$`)

// parseSince mirrors the provider's accepted relative durations.
func parseSince(value string) (int64, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, nil
	}
	match := sincePattern.FindStringSubmatch(trimmed)
	if match == nil {
		return 0, Failure(protocol.CodeInvalidRequest, "since must be a Kubernetes duration such as 30s, 15m, 2h, or 1d")
	}
	amount, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil || amount <= 0 {
		return 0, Failure(protocol.CodeInvalidRequest, "since duration is out of range")
	}
	multiplier := map[string]int64{"s": 1, "m": 60, "h": 3_600, "d": 86_400}[match[2]]
	return amount * multiplier, nil
}

func hasMore(list map[string]any) bool {
	metadata, ok := list["metadata"].(map[string]any)
	if !ok {
		return false
	}
	continuation, ok := metadata["continue"].(string)
	return ok && continuation != ""
}

func eventStart(value any) int64 {
	event, ok := value.(map[string]any)
	if !ok {
		return 0
	}
	metadata, _ := event["metadata"].(map[string]any)
	var creation any
	if metadata != nil {
		creation = metadata["creationTimestamp"]
	}
	return firstTimestamp(event["firstTimestamp"], creation, event["eventTime"])
}

func eventOverlaps(value any, since, until *time.Time) bool {
	event, ok := value.(map[string]any)
	if !ok {
		return false
	}
	metadata, _ := event["metadata"].(map[string]any)
	series, _ := event["series"].(map[string]any)
	var creation, lastObserved any
	if metadata != nil {
		creation = metadata["creationTimestamp"]
	}
	if series != nil {
		lastObserved = series["lastObservedTime"]
	}
	start := firstTimestamp(event["firstTimestamp"], creation, event["eventTime"])
	end := firstTimestamp(lastObserved, event["lastTimestamp"], event["eventTime"], start)
	if start == 0 || end == 0 {
		return false
	}
	if since != nil && end < since.UnixMilli() {
		return false
	}
	if until != nil && start > until.UnixMilli() {
		return false
	}
	return true
}

// firstTimestamp returns the first parsable value as epoch milliseconds.
func firstTimestamp(values ...any) int64 {
	for _, value := range values {
		switch typed := value.(type) {
		case int64:
			return typed
		case float64:
			return int64(typed)
		case string:
			if typed == "" {
				continue
			}
			parsed, err := time.Parse(time.RFC3339Nano, typed)
			if err == nil {
				return parsed.UnixMilli()
			}
		}
	}
	return 0
}

// filterLogUntil keeps only lines whose leading timestamp is at or before
// untilTime, mirroring the provider's local upper-bound filter.
func filterLogUntil(output, untilTime string) string {
	until, err := time.Parse(time.RFC3339, strings.TrimSpace(untilTime))
	if err != nil {
		return output
	}
	var builder strings.Builder
	remaining := output
	for remaining != "" {
		line := remaining
		next := ""
		if index := strings.IndexByte(remaining, '\n'); index >= 0 {
			line = remaining[:index+1]
			next = remaining[index+1:]
		}
		remaining = next
		separator := strings.IndexByte(line, ' ')
		if separator <= 0 {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, line[:separator])
		if err == nil && !parsed.After(until) {
			builder.WriteString(line)
		}
	}
	return builder.String()
}
