// Command aiops-agent connects one Kubernetes cluster to the AIOps server and
// answers bounded, read-only queries. It only dials out and never listens.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"syscall"

	"github.com/jarvan1/dsh-aiops/agent/internal/agent"
	"github.com/jarvan1/dsh-aiops/agent/internal/config"
	"github.com/jarvan1/dsh-aiops/agent/internal/kube"
	"github.com/jarvan1/dsh-aiops/agent/internal/protocol"
)

// version is set at build time with -ldflags "-X main.version=<tag>".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("agent stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run() error {
	settings, err := config.Parse(os.Args[1:], os.Getenv)
	if err != nil {
		if errors.Is(err, config.ErrHelp) {
			usage()
			return nil
		}
		return err
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel(settings.LogLevel)})))
	if settings.ShowVersion {
		fmt.Printf("aiops-agent %s (protocol %d)\n", version, protocol.Version)
		return nil
	}

	token, err := config.LoadToken(settings.TokenFile)
	if err != nil {
		return err
	}
	target, err := url.Parse(settings.Server)
	if err != nil {
		return fmt.Errorf("parse server URL: %w", err)
	}
	client, namespace, err := kube.NewInCluster(settings.ServiceAccountDir, settings.MaxResponseBytes, settings.RequestTimeout)
	if err != nil {
		return err
	}
	executor, err := kube.NewExecutor(kube.ExecutorOptions{
		Client:           client,
		Namespace:        namespace,
		DefaultTailLines: settings.DefaultTailLines,
		MaxTailLines:     settings.MaxTailLines,
	})
	if err != nil {
		return err
	}

	logger := slog.Default()
	logger.Info("starting aiops agent",
		"name", settings.Name,
		"version", version,
		"server", target.Redacted(),
		"namespace", namespace,
		"kubernetes", client.Server(),
	)
	runner, err := agent.New(agent.Options{
		URL:     target,
		Token:   token,
		Name:    settings.Name,
		Version: version,
		Capabilities: protocol.Capabilities{
			Resources:        kube.CapabilityResources(),
			Events:           true,
			Logs:             true,
			MaxResponseBytes: settings.MaxResponseBytes,
			MaxTailLines:     settings.MaxTailLines,
		},
		Executor:    executor,
		Heartbeat:   settings.Heartbeat,
		Concurrency: settings.Concurrency,
	})
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := runner.Run(ctx); err != nil {
		return err
	}
	logger.Info("agent shutdown complete")
	return nil
}

func logLevel(name string) slog.Level {
	switch name {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `aiops-agent %s — connect one Kubernetes cluster to DSH AIOps

Usage:
  aiops-agent --server <wss-url> --name <client-name> --token-file <path>

Required:
  --server        AIOps server WebSocket URL, for example wss://aiops.example.com/api/aiops/agent
  --name          Immutable client name that identifies this cluster (DNS label)
  --token-file    File containing the token issued for this client; never pass a token on the command line

Optional:
  --max-response-bytes  Kubernetes response cap (default 2000000)
  --max-tail-lines      Log line cap per request (default 2000)
  --default-tail-lines  Log lines when a request omits tailLines (default 200)
  --concurrency         Concurrent reads (default 4, max 64)
  --heartbeat           Heartbeat interval (default 15s)
  --request-timeout     Per-read Kubernetes deadline (default 30s)
  --service-account-dir Credential mount to read (defaults to the in-cluster mount; override only for a local run)
  --log-level           debug, info, warn, or error (default info)
  --version             Print the version and exit
  --help                Print this help and exit

Environment defaults: AIOPS_AGENT_SERVER, AIOPS_AGENT_NAME, AIOPS_AGENT_TOKEN_FILE.
`, version)
}
