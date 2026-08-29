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

func TestGuidedMarkdownConflictResolutionPreservesVersionsAndPushesDecision(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	writeFile(t, filepath.Join(other, "Note.md"), "other version\n")
	runGit(t, other, "add", "--all")
	runGit(t, other, "commit", "-m", "Other update")
	runGit(t, other, "push")
	writeFile(t, filepath.Join(root, "Note.md"), "your version\n")

	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if status := service.Sync(context.Background()); status.State != StateConflict {
		t.Fatalf("expected conflict, got %#v", status)
	}
	if status := service.Status(context.Background()); status.State != StateConflict || status.Branch != "main" {
		t.Fatalf("persisted conflict status became unavailable: %#v", status)
	}
	overview, err := service.Conflicts(context.Background())
	if err != nil || len(overview.Items) != 1 {
		t.Fatalf("conflict overview unavailable: %#v %v", overview, err)
	}
	item := overview.Items[0]
	if item.Kind != "markdown" || item.YourContent != "your version\n" || item.OtherContent != "other version\n" {
		t.Fatalf("versions were not presented with user-facing ownership: %#v", item)
	}
	result, err := service.ResolveConflicts(context.Background(), ConflictResolution{Token: overview.Token, Decisions: []ConflictDecision{{Path: "Note.md", Action: "edit_combined", Content: "combined result\n"}}})
	if err != nil || result.State != StateSynced || result.SafetyPoint == "" {
		t.Fatalf("resolution failed: %#v %v", result, err)
	}
	verification := filepath.Join(t.TempDir(), "verification")
	run(t, "git", "clone", remote, verification)
	content, err := os.ReadFile(filepath.Join(verification, "Note.md"))
	if err != nil || string(content) != "combined result\n" {
		t.Fatalf("resolved content was not pushed: %q %v", content, err)
	}
	if strings.TrimSpace(runGit(t, root, "show-ref", "refs/repoquill/recovery/"+result.SafetyPoint)) == "" {
		t.Fatal("durable recovery reference was not created")
	}
}

func TestGuidedConflictResolutionRejectsStaleReview(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	writeFile(t, filepath.Join(other, "Note.md"), "other\n")
	runGit(t, other, "add", "--all")
	runGit(t, other, "commit", "-m", "Other update")
	runGit(t, other, "push")
	writeFile(t, filepath.Join(root, "Note.md"), "yours\n")
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if service.Sync(context.Background()).State != StateConflict {
		t.Fatal("expected conflict")
	}
	overview, err := service.Conflicts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(other, "Later.md"), "later\n")
	runGit(t, other, "add", "--all")
	runGit(t, other, "commit", "-m", "Later update")
	runGit(t, other, "push")
	_, err = service.ResolveConflicts(context.Background(), ConflictResolution{Token: overview.Token, Decisions: []ConflictDecision{{Path: "Note.md", Action: "use_yours"}}})
	if !errors.Is(err, ErrConflictChanged) {
		t.Fatalf("stale resolution was accepted: %v", err)
	}
	if content, _ := os.ReadFile(filepath.Join(root, "Note.md")); !strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("conflict was unexpectedly mutated: %q", content)
	}
}

func TestGuidedConflictResolutionRejectsChangedWorkingCopy(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	writeFile(t, filepath.Join(other, "Note.md"), "other\n")
	runGit(t, other, "add", "--all")
	runGit(t, other, "commit", "-m", "Other")
	runGit(t, other, "push")
	writeFile(t, filepath.Join(root, "Note.md"), "yours\n")
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if service.Sync(context.Background()).State != StateConflict {
		t.Fatal("expected conflict")
	}
	overview, err := service.Conflicts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "Note.md"), "manual working-tree edit\n")
	_, err = service.ResolveConflicts(context.Background(), ConflictResolution{Token: overview.Token, Decisions: []ConflictDecision{{Path: "Note.md", Action: "use_yours"}}})
	if !errors.Is(err, ErrConflictChanged) {
		t.Fatalf("changed working copy was overwritten: %v", err)
	}
}

func TestGuidedImageConflictCanKeepBothWithoutOverwriting(t *testing.T) {
	root, remote := testRepository(t)
	imagePath := filepath.Join(root, "Note.assets", "picture.png")
	writeFile(t, imagePath, "\x00initial-image")
	runGit(t, root, "add", "--all")
	runGit(t, root, "commit", "-m", "Add image")
	runGit(t, root, "push")
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	writeFile(t, filepath.Join(other, "Note.assets", "picture.png"), "\x00other-image")
	runGit(t, other, "add", "--all")
	runGit(t, other, "commit", "-m", "Other image")
	runGit(t, other, "push")
	writeFile(t, imagePath, "\x00your-image")

	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if service.Sync(context.Background()).State != StateConflict {
		t.Fatal("expected image conflict")
	}
	overview, err := service.Conflicts(context.Background())
	if err != nil || len(overview.Items) != 1 || overview.Items[0].Kind != "image" {
		t.Fatalf("image overview unavailable: %#v %v", overview, err)
	}
	result, err := service.ResolveConflicts(context.Background(), ConflictResolution{Token: overview.Token, Decisions: []ConflictDecision{{Path: "Note.assets/picture.png", Action: "keep_both"}}})
	if err != nil || result.State != StateSynced {
		t.Fatalf("keep both failed: %#v %v", result, err)
	}
	content, _ := os.ReadFile(imagePath)
	if string(content) != "\x00your-image" {
		t.Fatalf("your selected image was overwritten: %q", content)
	}
	duplicates, err := filepath.Glob(filepath.Join(root, "Note.assets", "picture.other-*.png"))
	if err != nil || len(duplicates) != 1 {
		t.Fatalf("collision-resistant duplicate missing: %#v %v", duplicates, err)
	}
	otherContent, _ := os.ReadFile(duplicates[0])
	if string(otherContent) != "\x00other-image" {
		t.Fatalf("other image was not retained: %q", otherContent)
	}
}

func TestGuidedModifyDeleteDefaultsCanPreserveTheExistingNote(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	runGit(t, other, "rm", "Note.md")
	runGit(t, other, "commit", "-m", "Remove note")
	runGit(t, other, "push")
	writeFile(t, filepath.Join(root, "Note.md"), "your retained note\n")
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if service.Sync(context.Background()).State != StateConflict {
		t.Fatal("expected modify/delete conflict")
	}
	overview, err := service.Conflicts(context.Background())
	if err != nil || len(overview.Items) != 1 || overview.Items[0].Kind != "modify_delete" || !overview.Items[0].YourExists || overview.Items[0].OtherExists {
		t.Fatalf("modify/delete overview incorrect: %#v %v", overview, err)
	}
	result, err := service.ResolveConflicts(context.Background(), ConflictResolution{Token: overview.Token, Decisions: []ConflictDecision{{Path: "Note.md", Action: "keep_note"}}})
	if err != nil || result.State != StateSynced {
		t.Fatalf("keep note failed: %#v %v", result, err)
	}
	content, err := os.ReadFile(filepath.Join(root, "Note.md"))
	if err != nil || string(content) != "your retained note\n" {
		t.Fatalf("note was not preserved: %q %v", content, err)
	}
}

func TestSaveConflictSafetyPointPreservesExactServerVersion(t *testing.T) {
	root, _ := testRepository(t)
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	name, err := service.PreserveFileVersion(context.Background(), "Note.md")
	if err != nil || name == "" {
		t.Fatalf("save recovery point failed: %q %v", name, err)
	}
	content := runGit(t, root, "cat-file", "blob", "refs/repoquill/save-recovery/"+name)
	if content != "initial" {
		t.Fatalf("recovery point contains unexpected data: %q", content)
	}
}

func TestGuidedRenameConflictRetainsBothNamedNotes(t *testing.T) {
	root, remote := testRepository(t)
	other := filepath.Join(t.TempDir(), "other")
	run(t, "git", "clone", remote, other)
	configureIdentity(t, other)
	runGit(t, other, "mv", "Note.md", "Other name.md")
	runGit(t, other, "commit", "-m", "Other rename")
	runGit(t, other, "push")
	runGit(t, root, "mv", "Note.md", "Your name.md")
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if service.Sync(context.Background()).State != StateConflict {
		t.Fatal("expected rename conflict")
	}
	overview, err := service.Conflicts(context.Background())
	if err != nil || len(overview.Items) != 3 {
		t.Fatalf("rename paths were not presented: %#v %v", overview, err)
	}
	decisions := make([]ConflictDecision, 0, 3)
	for _, item := range overview.Items {
		action := "confirm_deletion"
		if item.YourExists {
			action = "keep_note"
		} else if item.OtherExists {
			action = "use_other"
		}
		decisions = append(decisions, ConflictDecision{Path: item.Path, Action: action})
	}
	result, err := service.ResolveConflicts(context.Background(), ConflictResolution{Token: overview.Token, Decisions: decisions})
	if err != nil || result.State != StateSynced {
		t.Fatalf("rename resolution failed: %#v %v", result, err)
	}
	for _, name := range []string{"Your name.md", "Other name.md"} {
		if content, err := os.ReadFile(filepath.Join(root, name)); err != nil || string(content) != "initial" {
			t.Fatalf("renamed note %q was not retained: %q %v", name, content, err)
		}
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
