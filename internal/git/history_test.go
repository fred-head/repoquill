package git

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestNoteHistoryListsVersionsAndReadsHistoricalContent(t *testing.T) {
	root, _ := testRepository(t)
	writeFile(t, filepath.Join(root, "Note.md"), "second version")
	runGit(t, root, "add", "Note.md")
	runGit(t, root, "commit", "-m", "Explain network changes")

	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	entries, err := service.NoteHistory(context.Background(), "Note.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Summary != "Explain network changes" || entries[0].Path != "Note.md" {
		t.Fatalf("unexpected note history: %#v", entries)
	}
	version, err := service.NoteVersion(context.Background(), "Note.md", entries[1].VersionID)
	if err != nil {
		t.Fatal(err)
	}
	if version.Content != "initial" || version.Path != "Note.md" {
		t.Fatalf("unexpected historical note: %#v", version)
	}
}

func TestNoteHistoryReportsShallowRepository(t *testing.T) {
	root, _ := testRepository(t)
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	entries, err := service.NoteHistory(context.Background(), "Note.md")
	if err != nil || len(entries) != 1 {
		t.Fatalf("prepare history: %#v, %v", entries, err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "shallow"), []byte(entries[0].VersionID+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := service.NoteHistoryWithStatus(context.Background(), "Note.md")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Limited || len(result.Entries) != 1 {
		t.Fatalf("shallow history was not reported: %#v", result)
	}
}

func TestNoteHistoryFollowsRenameAndUsesHistoricalPath(t *testing.T) {
	root, _ := testRepository(t)
	runGit(t, root, "mv", "Note.md", "Renamed.md")
	runGit(t, root, "commit", "-m", "Rename the note")
	writeFile(t, filepath.Join(root, "Renamed.md"), "new name content")
	runGit(t, root, "add", "Renamed.md")
	runGit(t, root, "commit", "-m", "Update renamed note")

	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	entries, err := service.NoteHistory(context.Background(), "Renamed.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 || entries[2].Path != "Note.md" {
		t.Fatalf("renamed history was not followed: %#v", entries)
	}
	version, err := service.NoteVersion(context.Background(), "Renamed.md", entries[2].VersionID)
	if err != nil || version.Content != "initial" {
		t.Fatalf("historical pre-rename content unavailable: %#v, %v", version, err)
	}
}

func TestNoteHistoryRejectsPathsAndUnknownVersions(t *testing.T) {
	root, _ := testRepository(t)
	service := NewService(root, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, unsafe := range []string{"../Note.md", "/tmp/Note.md", `.trash/Note.md`, `.git/config.md`, `Folder\Note.md`, "Note.txt"} {
		if _, err := service.NoteHistory(context.Background(), unsafe); !errors.Is(err, ErrInvalidNotePath) {
			t.Errorf("unsafe history path %q was accepted: %v", unsafe, err)
		}
	}
	if _, err := service.NoteVersion(context.Background(), "Note.md", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); !errors.Is(err, ErrHistoryVersionMissing) {
		t.Fatalf("unknown history version was accepted: %v", err)
	}
}
