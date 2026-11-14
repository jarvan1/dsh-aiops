// Package config parses the agent's flags and environment. The token is only
// read from a file so it never appears in a process listing or pod spec.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jarvan1/dsh-aiops/agent/internal/kube"
)

// ErrHelp is returned when the caller asked for usage.
var ErrHelp = flag.ErrHelp

// Config is the resolved agent configuration.
type Config struct {
	Server            string
	Name              string
	TokenFile         string
	MaxResponseBytes  int64
	MaxTailLines      int
	DefaultTailLines  int
	Concurrency       int
	Heartbeat         time.Duration
	RequestTimeout    time.Duration
	LogLevel          string
	ServiceAccountDir string
	ShowVersion       bool
}

// Parse resolves flags over environment defaults. getenv is injected so tests
// do not mutate the process environment.
func Parse(args []string, getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	config := Config{
		Server:            strings.TrimSpace(getenv("AIOPS_AGENT_SERVER")),
		Name:              strings.TrimSpace(getenv("AIOPS_AGENT_NAME")),
		TokenFile:         strings.TrimSpace(getenv("AIOPS_AGENT_TOKEN_FILE")),
		MaxResponseBytes:  2_000_000,
		MaxTailLines:      2_000,
		DefaultTailLines:  200,
		Concurrency:       4,
		Heartbeat:         15 * time.Second,
		RequestTimeout:    30 * time.Second,
		LogLevel:          "info",
		ServiceAccountDir: kube.DefaultServiceAccountDir,
	}
	set := flag.NewFlagSet("aiops-agent", flag.ContinueOnError)
	set.SetOutput(io.Discard)
	set.StringVar(&config.Server, "server", config.Server, "AIOps server WebSocket URL (wss://host/api/aiops/agent)")
	set.StringVar(&config.Name, "name", config.Name, "immutable client name that identifies this cluster")
	set.StringVar(&config.TokenFile, "token-file", config.TokenFile, "path to the token file created by the server")
	set.Int64Var(&config.MaxResponseBytes, "max-response-bytes", config.MaxResponseBytes, "maximum Kubernetes response body size")
	set.IntVar(&config.MaxTailLines, "max-tail-lines", config.MaxTailLines, "maximum log lines per request")
	set.IntVar(&config.DefaultTailLines, "default-tail-lines", config.DefaultTailLines, "log lines when the request omits tailLines")
	set.IntVar(&config.Concurrency, "concurrency", config.Concurrency, "maximum concurrent read requests")
	set.DurationVar(&config.Heartbeat, "heartbeat", config.Heartbeat, "heartbeat interval")
	set.DurationVar(&config.RequestTimeout, "request-timeout", config.RequestTimeout, "per-read Kubernetes API deadline")
	set.StringVar(&config.ServiceAccountDir, "service-account-dir", config.ServiceAccountDir, "service-account credential mount (override only for a local run)")
	set.StringVar(&config.LogLevel, "log-level", config.LogLevel, "debug, info, warn, or error")
	set.BoolVar(&config.ShowVersion, "version", false, "print the agent version and exit")
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return Config{}, ErrHelp
		}
		return Config{}, err
	}
	if set.NArg() > 0 {
		return Config{}, fmt.Errorf("unexpected argument %q", set.Arg(0))
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

// Validate rejects values that would make the agent unsafe or unusable.
func (c Config) Validate() error {
	if c.ShowVersion {
		return nil
	}
	if c.Server == "" {
		return errors.New("--server or AIOPS_AGENT_SERVER is required")
	}
	parsed, err := url.Parse(c.Server)
	if err != nil {
		return fmt.Errorf("--server is not a URL: %w", err)
	}
	if parsed.Scheme != "wss" && parsed.Scheme != "ws" {
		return errors.New("--server must use wss (or ws for a local test server)")
	}
	if parsed.Host == "" {
		return errors.New("--server must include a host")
	}
	if parsed.User != nil {
		return errors.New("--server must not embed credentials; the token is read from --token-file")
	}
	if c.Name == "" {
		return errors.New("--name or AIOPS_AGENT_NAME is required")
	}
	if c.TokenFile == "" {
		return errors.New("--token-file or AIOPS_AGENT_TOKEN_FILE is required")
	}
	if c.MaxResponseBytes <= 0 {
		return errors.New("--max-response-bytes must be positive")
	}
	if c.MaxTailLines <= 0 || c.DefaultTailLines <= 0 {
		return errors.New("log line limits must be positive")
	}
	if c.DefaultTailLines > c.MaxTailLines {
		return errors.New("--default-tail-lines must not exceed --max-tail-lines")
	}
	if c.Concurrency <= 0 || c.Concurrency > 64 {
		return errors.New("--concurrency must be between 1 and 64")
	}
	if c.Heartbeat < time.Second || c.Heartbeat > 5*time.Minute {
		return errors.New("--heartbeat must be between 1s and 5m")
	}
	if c.RequestTimeout < time.Second || c.RequestTimeout > 5*time.Minute {
		return errors.New("--request-timeout must be between 1s and 5m")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return errors.New("--log-level must be debug, info, warn, or error")
	}
	return nil
}

// LoadToken reads and trims the token file. The value is never logged.
func LoadToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read token file: %w", err)
	}
	token := strings.TrimSpace(string(data))
	if len(token) < 16 {
		return "", errors.New("token file is empty or too short")
	}
	if strings.ContainsAny(token, " \t\r\n") {
		return "", errors.New("token file must contain exactly one token without whitespace")
	}
	return token, nil
}
