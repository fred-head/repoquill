package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBootstrapCommandReturnsSecretOnlyToOperatorOutput(t *testing.T) {
	t.Setenv("REPOQUILL_AUTH_MODE", "local")
	t.Setenv("REPOQUILL_AUTH_METADATA", filepath.Join(t.TempDir(), "auth.db"))
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	originalStdout := os.Stdout
	os.Stdout = write
	commandErr := runAuthCommand(context.Background(), logger, []string{"auth", "bootstrap-token"})
	os.Stdout = originalStdout
	if closeErr := write.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	output, readErr := io.ReadAll(read)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if commandErr != nil {
		t.Fatal(commandErr)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) != 3 || len(lines[1]) < 40 {
		t.Fatalf("unexpected operator output: %q", output)
	}
	if strings.Contains(logs.String(), lines[1]) {
		t.Fatal("bootstrap token was written to structured logs")
	}
}

func TestAuthCommandRejectsUnknownAndDisabledBootstrap(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := runAuthCommand(context.Background(), logger, []string{"auth", "unknown"}); err == nil {
		t.Fatal("unknown auth command was accepted")
	}
	t.Setenv("REPOQUILL_AUTH_MODE", "disabled")
	t.Setenv("REPOQUILL_AUTH_METADATA", filepath.Join(t.TempDir(), "auth.db"))
	if err := runAuthCommand(context.Background(), logger, []string{"auth", "bootstrap-token"}); err == nil {
		t.Fatal("bootstrap token was generated with authentication disabled")
	}
}
