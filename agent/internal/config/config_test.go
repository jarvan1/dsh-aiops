package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func environment(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestParseUsesEnvironmentDefaults(t *testing.T) {
	config, err := Parse(nil, environment(map[string]string{
		"AIOPS_AGENT_SERVER":     "wss://aiops.example.com/api/aiops/agent",
		"AIOPS_AGENT_NAME":       "prod-east",
		"AIOPS_AGENT_TOKEN_FILE": "/var/run/aiops/token",
	}))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if config.Server != "wss://aiops.example.com/api/aiops/agent" || config.Name != "prod-east" || config.TokenFile != "/var/run/aiops/token" {
		t.Fatalf("environment defaults were not applied: %#v", config)
	}
	if config.Concurrency != 4 || config.Heartbeat != 15*time.Second {
		t.Fatalf("unexpected defaults: %#v", config)
	}
}

func TestFlagsOverrideEnvironment(t *testing.T) {
	config, err := Parse([]string{"--name", "prod-west", "--concurrency", "8", "--heartbeat", "30s"}, environment(map[string]string{
		"AIOPS_AGENT_SERVER":     "wss://aiops.example.com/api/aiops/agent",
		"AIOPS_AGENT_NAME":       "prod-east",
		"AIOPS_AGENT_TOKEN_FILE": "/var/run/aiops/token",
	}))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if config.Name != "prod-west" || config.Concurrency != 8 || config.Heartbeat != 30*time.Second {
		t.Fatalf("flags did not override environment: %#v", config)
	}
}

func TestParseRejectsMissingRequiredValues(t *testing.T) {
	cases := map[string]map[string]string{
		"server":     {"AIOPS_AGENT_NAME": "prod", "AIOPS_AGENT_TOKEN_FILE": "/token"},
		"name":       {"AIOPS_AGENT_SERVER": "wss://aiops.example.com", "AIOPS_AGENT_TOKEN_FILE": "/token"},
		"token file": {"AIOPS_AGENT_SERVER": "wss://aiops.example.com", "AIOPS_AGENT_NAME": "prod"},
	}
	for name, env := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(nil, environment(env)); err == nil {
				t.Fatal("expected a validation error")
			}
		})
	}
}

func TestParseRejectsUnsafeServerURLs(t *testing.T) {
	base := map[string]string{"AIOPS_AGENT_NAME": "prod", "AIOPS_AGENT_TOKEN_FILE": "/token"}
	for _, server := range []string{
		"http://aiops.example.com/api/aiops/agent",
		"wss://user:password@aiops.example.com/api/aiops/agent",
		"wss:///api/aiops/agent",
	} {
		env := map[string]string{"AIOPS_AGENT_SERVER": server}
		for key, value := range base {
			env[key] = value
		}
		if _, err := Parse(nil, environment(env)); err == nil {
			t.Fatalf("expected %q to be rejected", server)
		}
	}
}

func TestParseRejectsOutOfRangeBounds(t *testing.T) {
	base := []string{"--server", "wss://aiops.example.com", "--name", "prod", "--token-file", "/token"}
	for _, extra := range [][]string{
		{"--concurrency", "0"},
		{"--concurrency", "65"},
		{"--heartbeat", "100ms"},
		{"--request-timeout", "10m"},
		{"--default-tail-lines", "3000"},
		{"--max-response-bytes", "0"},
		{"--log-level", "verbose"},
	} {
		if _, err := Parse(append(base, extra...), environment(nil)); err == nil {
			t.Fatalf("expected %v to be rejected", extra)
		}
	}
}

func TestVersionNeedsNoServer(t *testing.T) {
	config, err := Parse([]string{"--version"}, environment(nil))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !config.ShowVersion {
		t.Fatal("version flag was not recorded")
	}
}

func TestLoadTokenTrimsAndValidates(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "token")
	if err := os.WriteFile(path, []byte("aiopsc_0123456789abcdef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	token, err := LoadToken(path)
	if err != nil {
		t.Fatalf("load token: %v", err)
	}
	if token != "aiopsc_0123456789abcdef" {
		t.Fatalf("token was not trimmed: %q", token)
	}

	if err := os.WriteFile(path, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadToken(path); err == nil {
		t.Fatal("expected a short token to be rejected")
	}
	if err := os.WriteFile(path, []byte("aiopsc_0123456789abcdef extra"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadToken(path); err == nil || !strings.Contains(err.Error(), "whitespace") {
		t.Fatalf("expected a whitespace error, got %v", err)
	}
	if _, err := LoadToken(filepath.Join(directory, "missing")); err == nil {
		t.Fatal("expected a missing file error")
	}
}
