// Package protocol defines the versioned JSON messages exchanged between the
// AIOps server and one cluster agent over a single WebSocket connection.
//
// The surface is deliberately closed: an agent only ever answers the typed
// read operations below. There is no generic verb, path, or kubectl passthrough,
// so a compromised server cannot turn an agent into an arbitrary client.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Version is the protocol major version implemented by this agent. A server
// that offers a different major version is rejected instead of guessed.
const Version = 1

// Closed error-code set. It mirrors the Kubernetes query codes of the
// TypeScript provider, plus busy, which the server maps to unreachable.
const (
	CodeInvalidRequest       = "invalid_request"
	CodeUnsupportedResource  = "unsupported_resource"
	CodeNotFound             = "not_found"
	CodeForbidden            = "forbidden"
	CodeAuthenticationFailed = "authentication_failed"
	CodeTimeout              = "timeout"
	CodeResponseTooLarge     = "response_too_large"
	CodeInvalidResponse      = "invalid_response"
	CodeUnreachable          = "unreachable"
	CodeBusy                 = "busy"
)

// Read operations. The set is closed; anything else is rejected before the
// Kubernetes API is touched.
const (
	OpGet    = "get"
	OpList   = "list"
	OpEvents = "events"
	OpLogs   = "logs"
)

// Capabilities tells the server what this agent can answer without first
// probing the cluster.
type Capabilities struct {
	// Resources lists the canonical names answerable through get/list.
	Resources []string `json:"resources"`
	// Events advertises the dedicated Event window query.
	Events           bool  `json:"events"`
	Logs             bool  `json:"logs"`
	MaxResponseBytes int64 `json:"maxResponseBytes"`
	MaxTailLines     int   `json:"maxTailLines"`
}

// Hello registers one agent connection. Name is the immutable client name and
// is the only cluster identity the server trusts; the connection itself is
// authenticated with the token, never with this field.
type Hello struct {
	Type         string       `json:"type"`
	Protocol     int          `json:"protocol"`
	Name         string       `json:"name"`
	Version      string       `json:"version"`
	Capabilities Capabilities `json:"capabilities"`
}

// NewHello builds the handshake message for the running build.
func NewHello(name, version string, capabilities Capabilities) Hello {
	return Hello{Type: "hello", Protocol: Version, Name: name, Version: version, Capabilities: capabilities}
}

// Heartbeat reports liveness and current load so the server can detect a
// half-open connection and avoid routing to a saturated agent.
type Heartbeat struct {
	Type     string `json:"type"`
	Version  string `json:"version"`
	Inflight int    `json:"inflight"`
}

// Result answers one read or probe request. Data is the raw Kubernetes JSON
// object for get/list/events, a string for logs, and a small object for probe.
type Result struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	OK        bool   `json:"ok"`
	Data      any    `json:"data,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
}

// ErrorResult builds a failed Result with a bounded message.
func ErrorResult(id, code, message string) Result {
	return Result{Type: "result", ID: id, OK: false, Code: code, Message: clamp(message, 512)}
}

// ProbeData is the probe Result payload: it lets the server render a
// connection row without a second round trip.
type ProbeData struct {
	Name         string       `json:"name"`
	Version      string       `json:"version"`
	Protocol     int          `json:"protocol"`
	Capabilities Capabilities `json:"capabilities"`
}

// Welcome is the server's answer to Hello.
type Welcome struct {
	Type           string `json:"type"`
	Protocol       int    `json:"protocol"`
	ClientID       string `json:"clientId"`
	DesiredVersion string `json:"desiredVersion,omitempty"`
}

// ReadRequest is one bounded read. Exactly which fields are required depends
// on Op; Validate enforces that before the executor runs.
type ReadRequest struct {
	Type          string `json:"type"`
	ID            string `json:"id"`
	Op            string `json:"op"`
	Resource      string `json:"resource,omitempty"`
	Namespace     string `json:"namespace,omitempty"`
	Name          string `json:"name,omitempty"`
	LabelSelector string `json:"labelSelector,omitempty"`
	FieldSelector string `json:"fieldSelector,omitempty"`
	SinceTime     string `json:"sinceTime,omitempty"`
	UntilTime     string `json:"untilTime,omitempty"`
	Pod           string `json:"pod,omitempty"`
	Container     string `json:"container,omitempty"`
	Previous      bool   `json:"previous,omitempty"`
	TailLines     *int   `json:"tailLines,omitempty"`
	Since         string `json:"since,omitempty"`
	Timestamps    *bool  `json:"timestamps,omitempty"`
}

// Probe asks the agent to describe itself and its capabilities.
type Probe struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// Upgrade asks the agent to move to TargetVersion. Path A agents answer that
// self-upgrade is disabled and let the operator's rollout apply the change.
type Upgrade struct {
	Type          string `json:"type"`
	ID            string `json:"id"`
	TargetVersion string `json:"targetVersion"`
}

// Drain asks the agent to stop accepting new reads while in-flight reads
// finish, so a rolling upgrade can retire it without failing a diagnosis.
type Drain struct {
	Type string `json:"type"`
}

// Resume reverses Drain.
type Resume struct {
	Type string `json:"type"`
}

// ServerError reports a fatal or request-level problem the agent must surface.
type ServerError struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServerMessage is any message the server may send after the handshake.
type ServerMessage interface{ serverMessage() }

func (Welcome) serverMessage()     {}
func (ReadRequest) serverMessage() {}
func (Probe) serverMessage()       {}
func (Upgrade) serverMessage()     {}
func (Drain) serverMessage()       {}
func (Resume) serverMessage()      {}
func (ServerError) serverMessage() {}

// ErrUnsupportedMessage marks a well-formed but unknown message type. The
// agent closes the connection rather than silently ignoring it, because an
// unknown request would otherwise leave a request id unanswered.
var ErrUnsupportedMessage = errors.New("unsupported server message type")

// DecodeServer parses one server message by its type tag.
func DecodeServer(raw []byte) (ServerMessage, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return nil, fmt.Errorf("decode message: %w", err)
	}
	switch head.Type {
	case "welcome":
		var message Welcome
		if err := json.Unmarshal(raw, &message); err != nil {
			return nil, fmt.Errorf("decode welcome: %w", err)
		}
		if message.Protocol != Version {
			return nil, fmt.Errorf("server protocol %d is not supported by agent protocol %d", message.Protocol, Version)
		}
		if strings.TrimSpace(message.ClientID) == "" {
			return nil, errors.New("welcome is missing clientId")
		}
		return message, nil
	case "read":
		var message ReadRequest
		if err := json.Unmarshal(raw, &message); err != nil {
			return nil, fmt.Errorf("decode read: %w", err)
		}
		if err := message.Validate(); err != nil {
			return nil, err
		}
		return message, nil
	case "probe":
		var message Probe
		if err := json.Unmarshal(raw, &message); err != nil {
			return nil, fmt.Errorf("decode probe: %w", err)
		}
		if err := validID(message.ID); err != nil {
			return nil, err
		}
		return message, nil
	case "upgrade":
		var message Upgrade
		if err := json.Unmarshal(raw, &message); err != nil {
			return nil, fmt.Errorf("decode upgrade: %w", err)
		}
		if err := validID(message.ID); err != nil {
			return nil, err
		}
		return message, nil
	case "drain":
		return Drain{Type: "drain"}, nil
	case "resume":
		return Resume{Type: "resume"}, nil
	case "error":
		var message ServerError
		if err := json.Unmarshal(raw, &message); err != nil {
			return nil, fmt.Errorf("decode error: %w", err)
		}
		return message, nil
	default:
		return nil, fmt.Errorf("%w %q", ErrUnsupportedMessage, head.Type)
	}
}

// Validate checks the envelope and the fields the selected operation needs.
// Resource allowlisting and value bounds remain the executor's job.
func (r ReadRequest) Validate() error {
	if err := validID(r.ID); err != nil {
		return err
	}
	switch r.Op {
	case OpGet:
		if err := validToken("resource", r.Resource, 64); err != nil {
			return err
		}
		return validToken("name", r.Name, 253)
	case OpList:
		return validToken("resource", r.Resource, 64)
	case OpEvents:
		return validateSelectors(r)
	case OpLogs:
		if err := validToken("pod", r.Pod, 253); err != nil {
			return err
		}
		if r.Container != "" {
			if err := validToken("container", r.Container, 253); err != nil {
				return err
			}
		}
		if r.Since != "" && r.SinceTime != "" {
			return errors.New("since and sinceTime are mutually exclusive")
		}
		if r.UntilTime != "" && r.Timestamps != nil && !*r.Timestamps {
			return errors.New("untilTime requires timestamps to be enabled")
		}
		if r.TailLines != nil && *r.TailLines <= 0 {
			return errors.New("tailLines must be a positive integer")
		}
		return validateWindow(r)
	default:
		return fmt.Errorf("unsupported read operation %q", r.Op)
	}
}

func validateSelectors(r ReadRequest) error {
	if len(r.LabelSelector) > 1024 {
		return errors.New("labelSelector exceeds 1024 characters")
	}
	if len(r.FieldSelector) > 1024 {
		return errors.New("fieldSelector exceeds 1024 characters")
	}
	return validateWindow(r)
}

func validateWindow(r ReadRequest) error {
	since, until, err := ParseWindow(r.SinceTime, r.UntilTime)
	if err != nil {
		return err
	}
	if since != nil && until != nil && since.After(*until) {
		return errors.New("sinceTime must not be after untilTime")
	}
	return nil
}

// ParseWindow normalizes an optional absolute occurrence window. Returned
// times are UTC; nil means unbounded on that side.
func ParseWindow(sinceTime, untilTime string) (*time.Time, *time.Time, error) {
	parse := func(name, value string) (*time.Time, error) {
		if strings.TrimSpace(value) == "" {
			return nil, nil
		}
		parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("%s must be a valid RFC3339 timestamp", name)
		}
		utc := parsed.UTC()
		return &utc, nil
	}
	since, err := parse("sinceTime", sinceTime)
	if err != nil {
		return nil, nil, err
	}
	until, err := parse("untilTime", untilTime)
	if err != nil {
		return nil, nil, err
	}
	return since, until, nil
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func validID(id string) error {
	if !idPattern.MatchString(id) {
		return errors.New("request id must be 1..128 characters of [A-Za-z0-9._:-]")
	}
	return nil
}

func validToken(name, value string, limit int) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("%s is required", name)
	}
	if len(trimmed) > limit {
		return fmt.Errorf("%s exceeds %d characters", name, limit)
	}
	return nil
}

func clamp(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
