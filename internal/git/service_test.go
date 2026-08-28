package git

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatusCommitPushAndNoChangeSync(t *testing.T) {
	root, remote := testRepository(t)
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if status := service.Status(context.Background()); status.State != StateClean {
		t.Fatalf("expected clean repository, got %#v", status)
	}
	writeFile(t, filepath.Join(root, "Note.md"), "local update")
	if status := service.Status(context.Background()); status.State != StateLocalChanges {
		t.Fatalf("expected local changes, got %#v", status)
	}
	if status := service.Sync(context.Background()); status.State != StateSynced {
		t.Fatalf("sync failed: %#v", status)
	}
	count := strings.TrimSpace(runGit(t, remote, "rev-list", "--count", "main"))
	if count != "2" {
		t.Fatalf("expected pushed commit, got %s commits", count)
	}
	if status := service.Sync(context.Background()); status.State != StateSynced {
		t.Fatalf("no-change sync failed: %#v", status)
	}
	if after := strings.TrimSpace(runGit(t, remote, "rev-list", "--count", "main")); after != count {
		t.Fatalf("no-change sync created a commit: before %s after %s", count, after)
	}
}

func TestSyncIntegratesRemoteOnlyChanges(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	writeFile(t, filepath.Join(other, "Remote.md"), "from remote")
	runGit(t, other, "add", "--all")
	runGit(t, other, "commit", "-m", "Remote update")
	runGit(t, other, "push")

	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	status := service.Sync(context.Background())
	if status.State != StateSynced {
		t.Fatalf("remote sync failed: %#v", status)
	}
	if len(status.ReceivedChanges) != 1 || status.ReceivedChanges[0].Kind != "added" || status.ReceivedChanges[0].Path != "Remote.md" {
		t.Fatalf("remote change summary missing or incorrect: %#v", status.ReceivedChanges)
	}
	content, err := os.ReadFile(filepath.Join(root, "Remote.md"))
	if err != nil || string(content) != "from remote" {
		t.Fatalf("remote content not integrated: %q, %v", content, err)
	}
}

func TestSyncSummarizesRemoteRenameWithoutExposingRevisions(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	runGit(t, other, "mv", "Note.md", "Renamed.md")
	runGit(t, other, "commit", "-m", "Rename note")
	runGit(t, other, "push")

	status := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil))).Sync(context.Background())
	if status.State != StateSynced || len(status.ReceivedChanges) != 1 {
		t.Fatalf("rename synchronization failed: %#v", status)
	}
	change := status.ReceivedChanges[0]
	if change.Kind != "moved" || change.FromPath != "Note.md" || change.Path != "Renamed.md" {
		t.Fatalf("remote rename summary incorrect: %#v", change)
	}
}

func TestSyncStopsOnConflictAndPreservesLocalContent(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	writeFile(t, filepath.Join(other, "Note.md"), "remote version")
	runGit(t, other, "add", "--all")
	runGit(t, other, "commit", "-m", "Remote conflict")
	runGit(t, other, "push")
	writeFile(t, filepath.Join(root, "Note.md"), "local version")

	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	status := service.Sync(context.Background())
	if status.State != StateConflict || len(status.ConflictFiles) != 1 || status.ConflictFiles[0] != "Note.md" {
		t.Fatalf("expected conflict, got %#v", status)
	}
	content, err := os.ReadFile(filepath.Join(root, "Note.md"))
	if err != nil || !strings.Contains(string(content), "local version") {
		t.Fatalf("local content was discarded: %q, %v", content, err)
	}
}

func TestFailedRemotePreservesSavedWorkingTree(t *testing.T) {
	root, _ := testRepository(t)
	writeFile(t, filepath.Join(root, "Note.md"), "saved locally")
	runGit(t, root, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing.git"))
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	status := service.Sync(context.Background())
	if status.State != StateSyncFailed {
		t.Fatalf("expected sync failure, got %#v", status)
	}
	content, err := os.ReadFile(filepath.Join(root, "Note.md"))
	if err != nil || string(content) != "saved locally" {
		t.Fatalf("local content was lost: %q, %v", content, err)
	}
}

func TestSyncDoesNotExecuteRepositoryHooks(t *testing.T) {
	root, _ := testRepository(t)
	marker := filepath.Join(t.TempDir(), "hook-executed")
	hook := filepath.Join(root, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch \""+marker+"\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "Note.md"), "safe update")
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if status := service.Sync(context.Background()); status.State != StateSynced {
		t.Fatalf("sync failed: %#v", status)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("repository hook was executed: %v", err)
	}
}

func TestSanitizeOutputRemovesURLCredentials(t *testing.T) {
	value := sanitizeOutput("fatal: https://user:secret@example.test/repo.git failed")
	if strings.Contains(value, "secret") || !strings.Contains(value, "[credentials]") {
		t.Fatalf("credentials were not sanitized: %q", value)
	}
}

func TestCloneExistingRepository(t *testing.T) {
	_, remote := testRepository(t)
	base := t.TempDir()
	result, err := Clone(context.Background(), base, remote, "main", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if result.Branch != "main" || filepath.Dir(result.Path) != base {
		t.Fatalf("unexpected clone result: %#v", result)
	}
	content, err := os.ReadFile(filepath.Join(result.Path, "Note.md"))
	if err != nil || string(content) != "initial" {
		t.Fatalf("cloned content missing: %q, %v", content, err)
	}
}

func testRepository(t *testing.T) (string, string) {
	t.Helper()
	base := t.TempDir()
	remote := filepath.Join(base, "remote.git")
	root := filepath.Join(base, "working")
	run(t, "git", "init", "--bare", "--initial-branch=main", remote)
	run(t, "git", "init", "--initial-branch=main", root)
	configureIdentity(t, root)
	writeFile(t, filepath.Join(root, "Note.md"), "initial")
	runGit(t, root, "add", "--all")
	runGit(t, root, "commit", "-m", "Initial")
	runGit(t, root, "remote", "add", "origin", remote)
	runGit(t, root, "push", "--set-upstream", "origin", "main")
	return root, remote
}

func configureIdentity(t *testing.T, root string) {
	t.Helper()
	runGit(t, root, "config", "user.name", "Test User")
	runGit(t, root, "config", "user.email", "test@example.test")
}

func writeFile(t *testing.T, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func runGit(t *testing.T, root string, arguments ...string) string {
	t.Helper()
	return run(t, "git", append([]string{"-C", root}, arguments...)...)
}

func run(t *testing.T, name string, arguments ...string) string {
	t.Helper()
	command := exec.Command(name, arguments...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v failed: %v\n%s", name, arguments, err, output)
	}
	return string(output)
}
