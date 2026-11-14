package protocol

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDecodeWelcome(t *testing.T) {
	message, err := DecodeServer([]byte(`{"type":"welcome","protocol":1,"clientId":"cli_01"}`))
	if err != nil {
		t.Fatalf("decode welcome: %v", err)
	}
	welcome, ok := message.(Welcome)
	if !ok || welcome.ClientID != "cli_01" {
		t.Fatalf("unexpected message %#v", message)
	}
}

func TestDecodeWelcomeRejectsWrongProtocol(t *testing.T) {
	_, err := DecodeServer([]byte(`{"type":"welcome","protocol":2,"clientId":"cli_01"}`))
	if err == nil || !strings.Contains(err.Error(), "protocol") {
		t.Fatalf("expected protocol mismatch, got %v", err)
	}
}

func TestDecodeWelcomeRequiresClientID(t *testing.T) {
	_, err := DecodeServer([]byte(`{"type":"welcome","protocol":1}`))
	if err == nil || !strings.Contains(err.Error(), "clientId") {
		t.Fatalf("expected missing clientId error, got %v", err)
	}
}

func TestDecodeRejectsUnknownType(t *testing.T) {
	_, err := DecodeServer([]byte(`{"type":"exec","id":"r1"}`))
	if !errors.Is(err, ErrUnsupportedMessage) {
		t.Fatalf("expected unsupported message, got %v", err)
	}
}

func TestDecodeReadValidatesEnvelope(t *testing.T) {
	cases := map[string]string{
		"missing id":          `{"type":"read","op":"get","resource":"pods","name":"api-1"}`,
		"bad id":              `{"type":"read","id":"has space","op":"get","resource":"pods","name":"api-1"}`,
		"unsupported op":      `{"type":"read","id":"r1","op":"exec","resource":"pods"}`,
		"get without name":    `{"type":"read","id":"r1","op":"get","resource":"pods"}`,
		"list without kind":   `{"type":"read","id":"r1","op":"list"}`,
		"logs without pod":    `{"type":"read","id":"r1","op":"logs"}`,
		"since and sinceTime": `{"type":"read","id":"r1","op":"logs","pod":"p","since":"15m","sinceTime":"2026-11-14T10:00:00Z"}`,
		"until without ts":    `{"type":"read","id":"r1","op":"logs","pod":"p","untilTime":"2026-11-14T10:00:00Z","timestamps":false}`,
		"zero tail":           `{"type":"read","id":"r1","op":"logs","pod":"p","tailLines":0}`,
		"bad sinceTime":       `{"type":"read","id":"r1","op":"events","sinceTime":"yesterday"}`,
		"reversed window":     `{"type":"read","id":"r1","op":"events","sinceTime":"2026-11-14T11:00:00Z","untilTime":"2026-11-14T10:00:00Z"}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeServer([]byte(raw)); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestDecodeReadAcceptsBoundedRequest(t *testing.T) {
	message, err := DecodeServer([]byte(`{"type":"read","id":"r1","op":"logs","pod":"api-1","namespace":"payments","tailLines":100,"timestamps":true}`))
	if err != nil {
		t.Fatalf("decode read: %v", err)
	}
	request, ok := message.(ReadRequest)
	if !ok || request.Pod != "api-1" || request.TailLines == nil || *request.TailLines != 100 {
		t.Fatalf("unexpected request %#v", message)
	}
}

func TestHelloRoundTrip(t *testing.T) {
	raw, err := json.Marshal(NewHello("prod-east", "1.2.3", Capabilities{Resources: []string{"pods"}, Logs: true}))
	if err != nil {
		t.Fatal(err)
	}
	var decoded Hello
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Type != "hello" || decoded.Protocol != Version || decoded.Name != "prod-east" || !decoded.Capabilities.Logs {
		t.Fatalf("unexpected hello %#v", decoded)
	}
}

func TestErrorResultIsBounded(t *testing.T) {
	result := ErrorResult("r1", CodeBusy, strings.Repeat("x", 2000))
	if len(result.Message) != 512 || result.OK || result.Code != CodeBusy {
		t.Fatalf("unexpected result %#v", result)
	}
}

func TestParseWindow(t *testing.T) {
	since, until, err := ParseWindow("2026-11-14T10:00:00+08:00", "")
	if err != nil {
		t.Fatal(err)
	}
	if since == nil || since.Format("2006-01-02T15:04:05Z07:00") != "2026-11-14T02:00:00Z" {
		t.Fatalf("since was not normalized to UTC: %v", since)
	}
	if until != nil {
		t.Fatalf("empty untilTime must stay unbounded, got %v", until)
	}
	if _, _, err := ParseWindow("", "not-a-time"); err == nil {
		t.Fatal("expected invalid untilTime error")
	}
}
