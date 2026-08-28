package git

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maximumHistoryEntries = 100
	maximumHistoryBytes   = 10 << 20
	historyRecordPrefix   = "REPOQUILL-HISTORY\t"
)

var (
	ErrInvalidNotePath       = errors.New("invalid note history path")
	ErrHistoryUnavailable    = errors.New("note history is unavailable")
	ErrHistoryVersionMissing = errors.New("note version was not found")
	ErrHistoryFileTooLarge   = errors.New("historical note is too large")
)

type NoteHistoryEntry struct {
	VersionID string `json:"versionId"`
	Timestamp string `json:"timestamp"`
	Summary   string `json:"summary"`
	Path      string `json:"path"`
}

type NoteVersion struct {
	NoteHistoryEntry
	Content string `json:"content"`
}

type NoteHistoryResult struct {
	Entries []NoteHistoryEntry `json:"entries"`
	Limited bool               `json:"limited"`
}

func (s *Service) NoteHistory(ctx context.Context, notePath string) ([]NoteHistoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.noteHistory(ctx, notePath)
}

func (s *Service) NoteHistoryWithStatus(ctx context.Context, notePath string) (NoteHistoryResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.noteHistory(ctx, notePath)
	if err != nil {
		return NoteHistoryResult{}, err
	}
	output, err := s.run(ctx, "inspect history availability", "rev-parse", "--is-shallow-repository")
	return NoteHistoryResult{
		Entries: entries,
		Limited: err == nil && strings.TrimSpace(output) == "true",
	}, nil
}

func (s *Service) NoteVersion(ctx context.Context, notePath, versionID string) (NoteVersion, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.noteHistory(ctx, notePath)
	if err != nil {
		return NoteVersion{}, err
	}
	var selected *NoteHistoryEntry
	for index := range entries {
		if entries[index].VersionID == versionID {
			selected = &entries[index]
			break
		}
	}
	if selected == nil {
		return NoteVersion{}, ErrHistoryVersionMissing
	}

	content, err := s.run(ctx, "read historical note", "cat-file", "blob", selected.VersionID+":"+selected.Path)
	if err != nil {
		return NoteVersion{}, ErrHistoryVersionMissing
	}
	if len(content) > maximumHistoryBytes {
		return NoteVersion{}, ErrHistoryFileTooLarge
	}
	return NoteVersion{NoteHistoryEntry: *selected, Content: content}, nil
}

func (s *Service) noteHistory(ctx context.Context, notePath string) ([]NoteHistoryEntry, error) {
	if err := s.validateRoot(ctx); err != nil {
		return nil, err
	}
	canonicalPath, err := canonicalHistoryNotePath(s.root, notePath)
	if err != nil {
		return nil, err
	}

	format := historyRecordPrefix + "%H\t%aI\t%s"
	output, err := s.run(ctx, "inspect note history", "log", "--follow", "-n", "100", "--format="+format, "--name-only", "--", canonicalPath)
	if err != nil {
		return nil, ErrHistoryUnavailable
	}
	return parseNoteHistory(output), nil
}

func canonicalHistoryNotePath(root, value string) (string, error) {
	if err := validateHistoryNotePath(value); err != nil {
		return "", err
	}
	current := root
	canonical := make([]string, 0, strings.Count(value, "/")+1)
	parts := strings.Split(value, "/")
	for index, part := range parts {
		entries, err := os.ReadDir(current)
		if err != nil {
			return "", ErrHistoryUnavailable
		}
		var matched fs.DirEntry
		for _, entry := range entries {
			if entry.Name() == part {
				matched = entry
				break
			}
		}
		if matched == nil {
			return "", ErrHistoryVersionMissing
		}
		if matched.Type()&fs.ModeSymlink != 0 || index < len(parts)-1 && !matched.IsDir() {
			return "", ErrInvalidNotePath
		}
		if index == len(parts)-1 {
			info, err := matched.Info()
			if err != nil || !info.Mode().IsRegular() {
				return "", ErrInvalidNotePath
			}
		}
		canonical = append(canonical, matched.Name())
		current = filepath.Join(current, matched.Name())
	}
	return strings.Join(canonical, "/"), nil
}

func parseNoteHistory(output string) []NoteHistoryEntry {
	entries := make([]NoteHistoryEntry, 0)
	var current *NoteHistoryEntry
	finish := func() {
		if current == nil || current.Path == "" || len(entries) >= maximumHistoryEntries {
			return
		}
		entries = append(entries, *current)
	}

	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		if strings.HasPrefix(line, historyRecordPrefix) {
			finish()
			current = nil
			fields := strings.SplitN(strings.TrimPrefix(line, historyRecordPrefix), "\t", 3)
			if len(fields) != 3 || !revisionPattern.MatchString(fields[0]) {
				continue
			}
			parsedTime, err := time.Parse(time.RFC3339, fields[1])
			if err != nil {
				continue
			}
			current = &NoteHistoryEntry{
				VersionID: strings.ToLower(fields[0]),
				Timestamp: parsedTime.UTC().Format(time.RFC3339),
				Summary:   safeHistorySummary(fields[2]),
			}
			continue
		}
		if current != nil && current.Path == "" && line != "" && validateHistoryNotePath(line) == nil {
			current.Path = line
		}
	}
	finish()
	return entries
}

func validateHistoryNotePath(value string) error {
	if value == "" || len(value) > 4096 || !utf8.ValidString(value) || strings.Contains(value, `\`) || path.IsAbs(value) || path.Clean(value) != value || !strings.EqualFold(path.Ext(value), ".md") {
		return ErrInvalidNotePath
	}
	for _, part := range strings.Split(value, "/") {
		lower := strings.ToLower(part)
		if part == "" || part == "." || part == ".." || lower == ".git" || lower == ".trash" || lower == "node_modules" || strings.IndexFunc(part, unicode.IsControl) >= 0 {
			return ErrInvalidNotePath
		}
	}
	return nil
}

func safeHistorySummary(value string) string {
	value = strings.TrimSpace(strings.Map(func(character rune) rune {
		if unicode.IsControl(character) {
			return ' '
		}
		return character
	}, value))
	if value == "" {
		return "Updated note"
	}
	characters := []rune(value)
	if len(characters) > 200 {
		return string(characters[:200]) + "…"
	}
	return value
}
