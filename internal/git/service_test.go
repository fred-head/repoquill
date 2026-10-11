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

func TestLocalNotebookInitializesAndCommitsWithoutRemote(t *testing.T) {
	root := filepath.Join(t.TempDir(), "notebooks")
	created, err := InitializeLocal(context.Background(), root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if created.Branch != "main" || strings.TrimSpace(runGit(t, created.Path, "branch", "--show-current")) != "main" {
		t.Fatalf("local notebook branch was not initialized: %#v", created)
	}
	if strings.TrimSpace(runGit(t, created.Path, "remote")) != "" {
		t.Fatal("new local notebook unexpectedly has a remote")
	}
	service := NewService(created.Path, slog.New(slog.NewTextHandler(io.Discard, nil)))
	writeFile(t, filepath.Join(created.Path, "Note.md"), "saved locally")
	if status := service.Status(context.Background()); status.State != StateLocalOnly || !status.LocalChanges {
		t.Fatalf("local changes were reported as a sync failure: %#v", status)
	}
	status := service.Sync(context.Background())
	if status.State != StateLocalOnly || status.LocalChanges || status.LastSyncedAt != "" {
		t.Fatalf("local-only commit did not complete cleanly: %#v", status)
	}
	if count := strings.TrimSpace(runGit(t, created.Path, "rev-list", "--count", "main")); count != "1" {
		t.Fatalf("local-only sync should create one commit, got %s", count)
	}
}

func TestConnectRemoteAcceptsEmptyRepositoryAndPreservesLocalHistory(t *testing.T) {
	created, err := InitializeLocal(context.Background(), filepath.Join(t.TempDir(), "notebooks"), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(created.Path, slog.New(slog.NewTextHandler(io.Discard, nil)))
	writeFile(t, filepath.Join(created.Path, "Note.md"), "local notes")
	if result := service.Sync(context.Background()); result.State != StateLocalOnly {
		t.Fatalf("initial local commit failed: %#v", result)
	}
	remote := filepath.Join(t.TempDir(), "empty.git")
	run(t, "git", "init", "--bare", "--initial-branch=main", remote)
	branch, err := service.ConnectRemote(context.Background(), remote, "main", "")
	if err != nil || branch != "main" {
		t.Fatalf("empty remote was not connected: branch=%q err=%v", branch, err)
	}
	if status := service.Status(context.Background()); status.State != StateLocalChanges {
		t.Fatalf("local commits were not shown as pending for the empty remote: %#v", status)
	}
	if status := service.Sync(context.Background()); status.State != StateSynced {
		t.Fatalf("first push to empty remote failed: %#v", status)
	}
	if count := strings.TrimSpace(runGit(t, remote, "rev-list", "--count", "main")); count != "1" {
		t.Fatalf("local history was not pushed to the empty remote: %s commits", count)
	}
}

func TestConnectRemoteAcceptsSharedHistory(t *testing.T) {
	created, err := InitializeLocal(context.Background(), filepath.Join(t.TempDir(), "notebooks"), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(created.Path, slog.New(slog.NewTextHandler(io.Discard, nil)))
	writeFile(t, filepath.Join(created.Path, "Note.md"), "shared notes")
	if result := service.Sync(context.Background()); result.State != StateLocalOnly {
		t.Fatalf("initial local commit failed: %#v", result)
	}
	remote := filepath.Join(t.TempDir(), "shared.git")
	run(t, "git", "init", "--bare", "--initial-branch=main", remote)
	seed := filepath.Join(t.TempDir(), "seed")
	run(t, "git", "clone", created.Path, seed)
	configureIdentity(t, seed)
	runGit(t, seed, "remote", "remove", "origin")
	runGit(t, seed, "remote", "add", "origin", remote)
	runGit(t, seed, "push", "--set-upstream", "origin", "main")
	if _, err := service.ConnectRemote(context.Background(), remote, "main", ""); err != nil {
		t.Fatalf("remote with shared history was rejected: %v", err)
	}
	if status := service.Sync(context.Background()); status.State != StateSynced {
		t.Fatalf("sync after connecting shared history failed: %#v", status)
	}
}

func TestConnectRemoteRejectsUnrelatedHistoryWithoutChangingNotebook(t *testing.T) {
	created, err := InitializeLocal(context.Background(), filepath.Join(t.TempDir(), "notebooks"), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(created.Path, slog.New(slog.NewTextHandler(io.Discard, nil)))
	writeFile(t, filepath.Join(created.Path, "Local.md"), "local copy")
	if result := service.Sync(context.Background()); result.State != StateLocalOnly {
		t.Fatalf("initial local commit failed: %#v", result)
	}
	_, unrelated := testRepository(t)
	if _, err := service.ConnectRemote(context.Background(), unrelated, "main", ""); err == nil || !strings.Contains(err.Error(), "unrelated") {
		t.Fatalf("unrelated remote history was not rejected: %v", err)
	}
	if strings.TrimSpace(runGit(t, created.Path, "remote")) != "" {
		t.Fatal("rejected remote remained configured")
	}
	if content, err := os.ReadFile(filepath.Join(created.Path, "Local.md")); err != nil || string(content) != "local copy" {
		t.Fatalf("local note was changed by rejected connection: %q %v", content, err)
	}
	if count := strings.TrimSpace(runGit(t, created.Path, "rev-list", "--count", "main")); count != "1" {
		t.Fatalf("local history changed after rejection: %s commits", count)
	}
}

func TestDisconnectRemoteKeepsLocalHistoryAndRemoteRepository(t *testing.T) {
	root, remote := testRepository(t)
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := service.DisconnectRemote(context.Background()); err != nil {
		t.Fatal(err)
	}
	status := service.Status(context.Background())
	if status.State != StateLocalOnly {
		t.Fatalf("disconnected notebook was not marked local-only: %#v", status)
	}
	if strings.TrimSpace(runGit(t, root, "remote")) != "" {
		t.Fatal("origin remained configured after disconnect")
	}
	if local, remoteHead := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD")), strings.TrimSpace(runGit(t, remote, "rev-parse", "main")); local != remoteHead {
		t.Fatalf("disconnect changed repository history: local=%s remote=%s", local, remoteHead)
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

func TestSaveConflictSafetyPointRejectsSymlinkEscape(t *testing.T) {
	root, _ := testRepository(t)
	outside := filepath.Join(t.TempDir(), "outside.md")
	writeFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(root, "escape.md")); err != nil {
		t.Fatal(err)
	}
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := service.PreserveFileVersion(context.Background(), "escape.md"); !errors.Is(err, ErrInvalidDecision) {
		t.Fatalf("symlink escape was accepted: %v", err)
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
