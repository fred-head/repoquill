package git

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	ErrNoConflict      = errors.New("there are no changes that need review")
	ErrConflictChanged = errors.New("the conflicting changes changed; review the current versions again")
	ErrInvalidDecision = errors.New("every conflicting item needs a valid decision")
)

const maxConflictTextBytes = 4 << 20

type ConflictOverview struct {
	Token string         `json:"token"`
	Items []ConflictItem `json:"items"`
}

type ConflictItem struct {
	Path            string `json:"path"`
	Kind            string `json:"kind"`
	YourExists      bool   `json:"yourExists"`
	OtherExists     bool   `json:"otherExists"`
	YourContent     string `json:"yourContent,omitempty"`
	OtherContent    string `json:"otherContent,omitempty"`
	YourPreviewURL  string `json:"yourPreviewUrl,omitempty"`
	OtherPreviewURL string `json:"otherPreviewUrl,omitempty"`
	YourBlob        string `json:"-"`
	OtherBlob       string `json:"-"`
}

type ConflictDecision struct {
	Path       string `json:"path"`
	Action     string `json:"action"`
	Content    string `json:"content,omitempty"`
	TargetPath string `json:"targetPath,omitempty"`
}

type ConflictResolution struct {
	Token     string             `json:"token"`
	Decisions []ConflictDecision `json:"decisions"`
}

type ConflictResult struct {
	State       State  `json:"state"`
	SafetyPoint string `json:"safetyPoint,omitempty"`
	Message     string `json:"message"`
}

func (s *Service) PreserveFileVersion(ctx context.Context, relative string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.confinedConflictPath(relative); err != nil {
		return "", err
	}
	output, err := s.run(ctx, "preserve overlapping file version", "hash-object", "-w", "--", relative)
	blob := strings.TrimSpace(output)
	if err != nil || !revisionPattern.MatchString(blob) {
		return "", ErrInvalidDecision
	}
	digest := sha256.Sum256([]byte(relative + "\x00" + blob + "\x00" + time.Now().UTC().String()))
	name := "refs/repoquill/save-recovery/" + time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(digest[:4])
	if _, err := s.run(ctx, "create save recovery point", "update-ref", name, blob); err != nil {
		return "", err
	}
	return strings.TrimPrefix(name, "refs/repoquill/save-recovery/"), nil
}

type unmergedEntry struct {
	path  string
	mode  string
	blobs map[int]string
}

func (s *Service) Conflicts(ctx context.Context) (ConflictOverview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conflicts(ctx)
}

func (s *Service) conflicts(ctx context.Context) (ConflictOverview, error) {
	entries, err := s.unmergedEntries(ctx)
	if err != nil {
		return ConflictOverview{}, err
	}
	if len(entries) == 0 {
		return ConflictOverview{}, ErrNoConflict
	}
	remoteRevision := s.remoteRevision(ctx)
	hash := sha256.New()
	_, _ = hash.Write([]byte(remoteRevision + "\x00"))
	items := make([]ConflictItem, 0, len(entries))
	for _, entry := range entries {
		item := ConflictItem{Path: entry.path, Kind: conflictKind(entry.path), YourBlob: entry.blobs[3], OtherBlob: entry.blobs[2]}
		item.YourExists, item.OtherExists = item.YourBlob != "", item.OtherBlob != ""
		if item.Kind == "markdown" {
			if item.YourExists {
				item.YourContent, err = s.conflictBlob(ctx, item.YourBlob, maxConflictTextBytes)
				if err != nil {
					return ConflictOverview{}, err
				}
			}
			if item.OtherExists {
				item.OtherContent, err = s.conflictBlob(ctx, item.OtherBlob, maxConflictTextBytes)
				if err != nil {
					return ConflictOverview{}, err
				}
			}
		}
		if !item.YourExists || !item.OtherExists {
			item.Kind = "modify_delete"
		}
		_, _ = hash.Write([]byte(entry.path + "\x00" + entry.mode + "\x00" + item.YourBlob + "\x00" + item.OtherBlob + "\x00"))
		_, _ = hash.Write([]byte(s.conflictWorkingDigest(entry.path) + "\x00"))
		items = append(items, item)
	}
	return ConflictOverview{Token: hex.EncodeToString(hash.Sum(nil)), Items: items}, nil
}

func (s *Service) conflictWorkingDigest(relative string) string {
	target, err := s.confinedConflictPath(relative)
	if err != nil {
		return "invalid"
	}
	content, err := os.ReadFile(target)
	if errors.Is(err, os.ErrNotExist) {
		return "missing"
	}
	if err != nil {
		return "unreadable"
	}
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func (s *Service) ConflictBlob(ctx context.Context, path, side string) ([]byte, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	overview, err := s.conflicts(ctx)
	if err != nil {
		return nil, "", err
	}
	for _, item := range overview.Items {
		if item.Path != path {
			continue
		}
		blob := item.YourBlob
		if side == "other" {
			blob = item.OtherBlob
		} else if side != "yours" {
			return nil, "", ErrInvalidDecision
		}
		if blob == "" {
			return nil, "", os.ErrNotExist
		}
		output, err := s.runBytes(ctx, "read conflict version", "cat-file", "blob", blob)
		return output, conflictContentType(path), err
	}
	return nil, "", os.ErrNotExist
}

func (s *Service) ResolveConflicts(ctx context.Context, input ConflictResolution) (ConflictResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	overview, err := s.conflicts(ctx)
	if err != nil {
		return ConflictResult{}, err
	}
	if input.Token == "" || input.Token != overview.Token {
		return ConflictResult{}, ErrConflictChanged
	}
	decisions := make(map[string]ConflictDecision, len(input.Decisions))
	for _, decision := range input.Decisions {
		if _, exists := decisions[decision.Path]; exists {
			return ConflictResult{}, ErrInvalidDecision
		}
		decisions[decision.Path] = decision
	}
	if len(decisions) != len(overview.Items) {
		return ConflictResult{}, ErrInvalidDecision
	}

	branch, err := s.conflictBranch(ctx)
	if err != nil {
		return ConflictResult{}, err
	}
	remoteBefore := s.remoteRevision(ctx)
	if _, err := s.run(ctx, "revalidate remote", "fetch", "--prune", "origin"); err != nil {
		return ConflictResult{}, err
	}
	if remoteBefore != s.remoteRevision(ctx) {
		return ConflictResult{}, ErrConflictChanged
	}
	current, err := s.conflicts(ctx)
	if err != nil || current.Token != input.Token {
		return ConflictResult{}, ErrConflictChanged
	}

	safetyPoint, err := s.createConflictSafetyPoint(ctx)
	if err != nil {
		return ConflictResult{}, err
	}
	for _, item := range overview.Items {
		decision, ok := decisions[item.Path]
		if !ok || decision.Path != item.Path {
			return ConflictResult{}, ErrInvalidDecision
		}
		if err := s.applyConflictDecision(ctx, item, decision); err != nil {
			return ConflictResult{}, err
		}
	}
	if len(s.conflictFiles(ctx)) != 0 {
		return ConflictResult{}, ErrInvalidDecision
	}
	if _, err := s.runWithEditor(ctx, "continue synchronization", "rebase", "--continue"); err != nil {
		if len(s.conflictFiles(ctx)) > 0 {
			s.lastFailure = "More overlapping changes need review before synchronization can continue."
			return ConflictResult{State: StateConflict, SafetyPoint: safetyPoint, Message: s.lastFailure}, nil
		}
		return ConflictResult{}, err
	}
	if _, err := s.run(ctx, "push resolved changes", "push", "--set-upstream", "origin", "HEAD:"+branch); err != nil {
		return ConflictResult{}, err
	}
	s.lastFailure = ""
	s.lastSyncedAt = time.Now()
	return ConflictResult{State: StateSynced, SafetyPoint: safetyPoint, Message: "The selected versions were saved and synchronized."}, nil
}

func (s *Service) applyConflictDecision(ctx context.Context, item ConflictItem, decision ConflictDecision) error {
	action := decision.Action
	if item.Kind == "markdown" && action == "edit_combined" {
		if len(decision.Content) > maxConflictTextBytes || strings.Contains(decision.Content, "<<<<<<<") || strings.Contains(decision.Content, ">>>>>>>") {
			return ErrInvalidDecision
		}
		if err := s.writeConflictPath(item.Path, []byte(decision.Content)); err != nil {
			return err
		}
	} else if action == "use_yours" || action == "keep_note" {
		if item.YourBlob == "" {
			return ErrInvalidDecision
		}
		content, err := s.runBytes(ctx, "read your version", "cat-file", "blob", item.YourBlob)
		if err != nil {
			return err
		}
		if err := s.writeConflictPath(item.Path, content); err != nil {
			return err
		}
	} else if action == "use_other" {
		if item.OtherBlob == "" {
			return ErrInvalidDecision
		}
		content, err := s.runBytes(ctx, "read other version", "cat-file", "blob", item.OtherBlob)
		if err != nil {
			return err
		}
		if err := s.writeConflictPath(item.Path, content); err != nil {
			return err
		}
	} else if action == "confirm_deletion" {
		resolved, err := s.confinedConflictPath(item.Path)
		if err != nil {
			return err
		}
		if err := os.Remove(resolved); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else if action == "keep_both" && item.Kind == "image" && item.YourBlob != "" && item.OtherBlob != "" {
		yours, err := s.runBytes(ctx, "read your image", "cat-file", "blob", item.YourBlob)
		if err != nil {
			return err
		}
		other, err := s.runBytes(ctx, "read other image", "cat-file", "blob", item.OtherBlob)
		if err != nil {
			return err
		}
		if err := s.writeConflictPath(item.Path, yours); err != nil {
			return err
		}
		duplicate, err := s.availableCollisionPath(item.Path, other)
		if err != nil {
			return err
		}
		if err := s.writeConflictPath(duplicate, other); err != nil {
			return err
		}
		if _, err := s.run(ctx, "stage retained image", "add", "--", duplicate); err != nil {
			return err
		}
	} else {
		return ErrInvalidDecision
	}
	if action == "confirm_deletion" {
		_, err := s.run(ctx, "stage selected deletion", "rm", "--ignore-unmatch", "--", item.Path)
		return err
	}
	_, err := s.run(ctx, "stage selected version", "add", "--", item.Path)
	return err
}

func (s *Service) unmergedEntries(ctx context.Context) ([]unmergedEntry, error) {
	output, err := s.runBytes(ctx, "inspect conflict versions", "ls-files", "-u", "-z", "--")
	if err != nil {
		return nil, err
	}
	byPath := map[string]*unmergedEntry{}
	for _, record := range strings.Split(string(output), "\x00") {
		if record == "" {
			continue
		}
		tab := strings.IndexByte(record, '\t')
		if tab < 0 {
			return nil, ErrInvalidDecision
		}
		fields := strings.Fields(record[:tab])
		pathValue := filepath.ToSlash(record[tab+1:])
		if len(fields) != 3 || !validSummaryPath(pathValue) {
			return nil, ErrInvalidDecision
		}
		stage, conversionErr := strconv.Atoi(fields[2])
		if conversionErr != nil || stage < 1 || stage > 3 || !revisionPattern.MatchString(fields[1]) || fields[0] == "120000" {
			return nil, ErrInvalidDecision
		}
		entry := byPath[pathValue]
		if entry == nil {
			entry = &unmergedEntry{path: pathValue, mode: fields[0], blobs: map[int]string{}}
			byPath[pathValue] = entry
		}
		entry.blobs[stage] = fields[1]
	}
	result := make([]unmergedEntry, 0, len(byPath))
	for _, entry := range byPath {
		result = append(result, *entry)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].path < result[j].path })
	return result, nil
}

func (s *Service) conflictBlob(ctx context.Context, blob string, limit int) (string, error) {
	output, err := s.runBytes(ctx, "read conflict text", "cat-file", "blob", blob)
	if err != nil {
		return "", err
	}
	if len(output) > limit || strings.IndexByte(string(output), 0) >= 0 {
		return "", ErrInvalidDecision
	}
	return string(output), nil
}

func (s *Service) createConflictSafetyPoint(ctx context.Context) (string, error) {
	revision, err := s.revision(ctx, "ORIG_HEAD")
	if err != nil {
		revision, err = s.revision(ctx, "HEAD")
	}
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(revision + time.Now().UTC().String()))
	name := "refs/repoquill/recovery/" + time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(digest[:4])
	if _, err := s.run(ctx, "create recovery point", "update-ref", name, revision); err != nil {
		return "", err
	}
	return strings.TrimPrefix(name, "refs/repoquill/recovery/"), nil
}

func (s *Service) remoteRevision(ctx context.Context) string {
	branch, err := s.conflictBranch(ctx)
	if err != nil {
		return ""
	}
	revision, _ := s.revision(ctx, "refs/remotes/origin/"+branch)
	return revision
}

func (s *Service) conflictBranch(ctx context.Context) (string, error) {
	if branch, err := s.branch(ctx); err == nil {
		return branch, nil
	}
	for _, name := range []string{"rebase-merge/head-name", "rebase-apply/head-name"} {
		content, err := os.ReadFile(filepath.Join(s.root, ".git", name))
		if err != nil {
			continue
		}
		value := strings.TrimSpace(string(content))
		const prefix = "refs/heads/"
		if strings.HasPrefix(value, prefix) {
			branch := strings.TrimPrefix(value, prefix)
			if branch != "" && !strings.ContainsAny(branch, " ~^:?*[\\") && !strings.Contains(branch, "..") {
				return branch, nil
			}
		}
	}
	return "", ErrDetachedHEAD
}

func (s *Service) confinedConflictPath(relative string) (string, error) {
	if !validSummaryPath(relative) || strings.Contains(relative, `\`) {
		return "", ErrInvalidDecision
	}
	clean := filepath.Clean(filepath.FromSlash(relative))
	candidate := filepath.Join(s.root, clean)
	rel, err := filepath.Rel(s.root, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrInvalidDecision
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err == nil {
		if resolved != filepath.Clean(candidate) || !isConfinedGitPath(s.root, resolved) {
			return "", ErrInvalidDecision
		}
		return resolved, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", ErrInvalidDecision
	}
	parent := filepath.Dir(candidate)
	resolvedParent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return "", ErrInvalidDecision
	}
	if resolvedParent != filepath.Clean(parent) || !isConfinedGitPath(s.root, resolvedParent) {
		return "", ErrInvalidDecision
	}
	return filepath.Join(resolvedParent, filepath.Base(candidate)), nil
}

func isConfinedGitPath(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func (s *Service) writeConflictPath(relative string, content []byte) error {
	target, err := s.confinedConflictPath(relative)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".repoquill-resolution-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, target)
}

func collisionPath(original string, content []byte) string {
	digest := sha256.Sum256(content)
	extension := filepath.Ext(original)
	base := strings.TrimSuffix(original, extension)
	return fmt.Sprintf("%s.other-%s%s", base, hex.EncodeToString(digest[:6]), extension)
}

func (s *Service) availableCollisionPath(original string, content []byte) (string, error) {
	first := collisionPath(original, content)
	extension := filepath.Ext(first)
	base := strings.TrimSuffix(first, extension)
	for attempt := 0; attempt < 1000; attempt++ {
		candidate := first
		if attempt > 0 {
			candidate = fmt.Sprintf("%s-%d%s", base, attempt, extension)
		}
		resolved, err := s.confinedConflictPath(candidate)
		if err != nil {
			return "", err
		}
		if _, err := os.Lstat(resolved); errors.Is(err, os.ErrNotExist) {
			return candidate, nil
		} else if err != nil {
			return "", err
		}
	}
	return "", ErrInvalidDecision
}

func conflictKind(pathValue string) string {
	extension := strings.ToLower(filepath.Ext(pathValue))
	if extension == ".md" {
		return "markdown"
	}
	switch extension {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return "image"
	}
	return "binary"
}

func conflictContentType(pathValue string) string {
	switch strings.ToLower(filepath.Ext(pathValue)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}
