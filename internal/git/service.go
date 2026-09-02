package git

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotRepository = errors.New("configured notebook is not a Git repository")
	ErrDetachedHEAD  = errors.New("Git repository has a detached HEAD")
	ErrNoRemote      = errors.New("Git remote origin is not configured")
)

type State string

const (
	StateClean         State = "clean"
	StateLocalChanges  State = "local_changes"
	StateRemoteChanges State = "remote_changes"
	StateDiverged      State = "diverged"
	StateSynced        State = "synced"
	StateSyncFailed    State = "sync_failed"
	StateConflict      State = "conflict"
	StateInvalid       State = "invalid"
)

type Status struct {
	State           State            `json:"state"`
	Branch          string           `json:"branch,omitempty"`
	Ahead           int              `json:"ahead,omitempty"`
	Behind          int              `json:"behind,omitempty"`
	ConflictFiles   []string         `json:"conflictFiles,omitempty"`
	Message         string           `json:"message,omitempty"`
	LastSyncedAt    string           `json:"lastSyncedAt,omitempty"`
	ReceivedChanges []ReceivedChange `json:"receivedChanges,omitempty"`
}

type ReceivedChange struct {
	Kind     string `json:"kind"`
	Path     string `json:"path"`
	FromPath string `json:"fromPath,omitempty"`
}

type commandError struct {
	operation string
	exitCode  int
	output    string
}

func (e *commandError) Error() string { return e.operation + " failed" }

type Service struct {
	root         string
	logger       *slog.Logger
	mu           sync.Mutex
	lastFailure  string
	lastSyncedAt time.Time
	sshCommand   string
}

func NewManagedService(root, sshCommand string, logger *slog.Logger) *Service {
	service := NewService(root, logger)
	service.sshCommand = sshCommand
	return service
}

func NewService(root string, logger *slog.Logger) *Service {
	if absolute, err := filepath.Abs(root); err == nil {
		root = absolute
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	return &Service{root: filepath.Clean(root), logger: logger}
}

// RestoreLastSyncedAt hydrates informational sync state persisted outside the
// Git working tree. Invalid metadata is ignored rather than affecting Git.
func (s *Service) RestoreLastSyncedAt(value string) {
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return
	}
	s.mu.Lock()
	s.lastSyncedAt = parsed.UTC()
	s.mu.Unlock()
}

func (s *Service) Status(ctx context.Context) Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	status, err := s.status(ctx)
	if err != nil {
		return Status{State: StateInvalid, Message: publicGitError(err)}
	}
	if status.State != StateConflict && s.lastFailure != "" {
		status.State = StateSyncFailed
		status.Message = s.lastFailure
	}
	if !s.lastSyncedAt.IsZero() {
		status.LastSyncedAt = s.lastSyncedAt.UTC().Format(time.RFC3339)
		if status.State == StateClean && s.lastFailure == "" {
			status.State = StateSynced
		}
	}
	return status
}

func (s *Service) Sync(ctx context.Context) Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	if status, err := s.status(ctx); err != nil {
		return s.fail(err)
	} else if status.State == StateConflict {
		s.lastFailure = "Resolve the existing Git conflict before syncing again."
		return status
	}

	branch, err := s.branch(ctx)
	if err != nil {
		return s.fail(err)
	}
	dirty, err := s.dirty(ctx)
	if err != nil {
		return s.fail(err)
	}
	if dirty {
		if _, err := s.run(ctx, "stage", "add", "--all"); err != nil {
			return s.fail(err)
		}
		if _, err := s.run(ctx, "commit", "-c", "user.name=RepoQuill", "-c", "user.email=repoquill@localhost", "commit", "-m", "Update notes"); err != nil {
			return s.fail(err)
		}
	}
	if _, err := s.run(ctx, "inspect remote", "remote", "get-url", "origin"); err != nil {
		return s.fail(ErrNoRemote)
	}
	if _, err := s.run(ctx, "fetch", "fetch", "--prune", "origin"); err != nil {
		return s.fail(err)
	}

	remoteRef := "refs/remotes/origin/" + branch
	beforeIntegration, _ := s.revision(ctx, "HEAD")
	if _, err := s.run(ctx, "inspect remote branch", "show-ref", "--verify", "--quiet", remoteRef); err == nil {
		if _, err := s.run(ctx, "rebase", "rebase", "origin/"+branch); err != nil {
			conflicts := s.conflictFiles(ctx)
			if len(conflicts) > 0 {
				s.lastFailure = "Automatic synchronization paused because Git found conflicts."
				return Status{State: StateConflict, Branch: branch, ConflictFiles: conflicts, Message: s.lastFailure}
			}
			return s.fail(err)
		}
	}
	afterIntegration, _ := s.revision(ctx, "HEAD")
	receivedChanges := s.receivedChanges(ctx, beforeIntegration, afterIntegration)
	if _, err := s.run(ctx, "push", "push", "--set-upstream", "origin", "HEAD:"+branch); err != nil {
		return s.fail(err)
	}
	s.lastFailure = ""
	s.lastSyncedAt = time.Now()
	return Status{State: StateSynced, Branch: branch, LastSyncedAt: s.lastSyncedAt.UTC().Format(time.RFC3339), ReceivedChanges: receivedChanges}
}

var revisionPattern = regexp.MustCompile(`^[0-9a-fA-F]{40,64}$`)

func (s *Service) revision(ctx context.Context, revision string) (string, error) {
	output, err := s.run(ctx, "inspect revision", "rev-parse", "--verify", revision)
	value := strings.TrimSpace(output)
	if err != nil || !revisionPattern.MatchString(value) {
		return "", errors.New("Git revision is unavailable")
	}
	return value, nil
}

func (s *Service) receivedChanges(ctx context.Context, before, after string) []ReceivedChange {
	if before == "" || after == "" || before == after || !revisionPattern.MatchString(before) || !revisionPattern.MatchString(after) {
		return nil
	}
	output, err := s.run(ctx, "inspect received changes", "diff", "--name-status", "-z", "-M", before, after, "--")
	if err != nil {
		return nil
	}
	parts := strings.Split(output, "\x00")
	changes := make([]ReceivedChange, 0)
	for index := 0; index < len(parts) && len(changes) < 100; {
		status := parts[index]
		index++
		if status == "" || index >= len(parts) {
			break
		}
		if strings.HasPrefix(status, "R") {
			if index+1 >= len(parts) {
				break
			}
			from, destination := parts[index], parts[index+1]
			index += 2
			if validSummaryPath(from) && validSummaryPath(destination) {
				changes = append(changes, ReceivedChange{Kind: "moved", Path: destination, FromPath: from})
			}
			continue
		}
		changedPath := parts[index]
		index++
		if !validSummaryPath(changedPath) {
			continue
		}
		kind := "updated"
		switch status[0] {
		case 'A':
			kind = "added"
		case 'D':
			kind = "deleted"
		}
		changes = append(changes, ReceivedChange{Kind: kind, Path: changedPath})
	}
	return changes
}

func validSummaryPath(value string) bool {
	return value != "" && !filepath.IsAbs(value) && value != ".." && !strings.HasPrefix(value, "../") && !strings.ContainsRune(value, '\x00')
}

func (s *Service) status(ctx context.Context) (Status, error) {
	if err := s.validateRoot(ctx); err != nil {
		return Status{}, err
	}
	conflicts := s.conflictFiles(ctx)
	if len(conflicts) > 0 || s.rebaseInProgress() {
		branch, _ := s.conflictBranch(ctx)
		return Status{State: StateConflict, Branch: branch, ConflictFiles: conflicts, Message: "Automatic synchronization is paused until the Git conflict is resolved."}, nil
	}
	branch, err := s.branch(ctx)
	if err != nil {
		return Status{}, err
	}
	dirty, err := s.dirty(ctx)
	if err != nil {
		return Status{}, err
	}
	ahead, behind := s.aheadBehind(ctx)
	state := StateClean
	switch {
	case dirty || ahead > 0 && behind == 0:
		state = StateLocalChanges
	case ahead > 0 && behind > 0:
		state = StateDiverged
	case behind > 0:
		state = StateRemoteChanges
	}
	return Status{State: state, Branch: branch, Ahead: ahead, Behind: behind}, nil
}

func (s *Service) validateRoot(ctx context.Context) error {
	if s.root == "" {
		return ErrNotRepository
	}
	output, err := s.run(ctx, "validate repository", "rev-parse", "--show-toplevel")
	if err != nil {
		return ErrNotRepository
	}
	resolved, err := filepath.EvalSymlinks(strings.TrimSpace(output))
	if err != nil || filepath.Clean(resolved) != s.root {
		return ErrNotRepository
	}
	return nil
}

func (s *Service) branch(ctx context.Context) (string, error) {
	output, err := s.run(ctx, "inspect branch", "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || strings.TrimSpace(output) == "" {
		return "", ErrDetachedHEAD
	}
	return strings.TrimSpace(output), nil
}

func (s *Service) dirty(ctx context.Context) (bool, error) {
	output, err := s.run(ctx, "inspect working tree", "status", "--porcelain=v1", "--untracked-files=all")
	return strings.TrimSpace(output) != "", err
}

func (s *Service) aheadBehind(ctx context.Context) (int, int) {
	output, err := s.run(ctx, "inspect upstream", "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
	if err != nil {
		return 0, 0
	}
	fields := strings.Fields(output)
	if len(fields) != 2 {
		return 0, 0
	}
	ahead, _ := strconv.Atoi(fields[0])
	behind, _ := strconv.Atoi(fields[1])
	return ahead, behind
}

func (s *Service) conflictFiles(ctx context.Context) []string {
	output, err := s.run(ctx, "inspect conflicts", "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return nil
	}
	result := []string{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line != "" {
			result = append(result, line)
		}
	}
	return result
}

func (s *Service) rebaseInProgress() bool {
	for _, name := range []string{"rebase-merge", "rebase-apply", "MERGE_HEAD"} {
		if _, err := os.Stat(filepath.Join(s.root, ".git", name)); err == nil {
			return true
		}
	}
	return false
}

func (s *Service) run(ctx context.Context, operation string, arguments ...string) (string, error) {
	output, err := s.runBytes(ctx, operation, arguments...)
	return string(output), err
}

func (s *Service) runBytes(ctx context.Context, operation string, arguments ...string) ([]byte, error) {
	started := time.Now()
	commandArguments := append([]string{"-c", "core.hooksPath=/dev/null", "-C", s.root}, arguments...)
	// #nosec G204 -- no shell is used; callers construct a fixed Git subcommand plus separately validated arguments.
	command := exec.CommandContext(ctx, "git", commandArguments...)
	command.Env = gitEnvironment(s.sshCommand)
	output, err := command.CombinedOutput()
	exitCode := 0
	if err != nil {
		exitCode = -1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
	}
	s.logger.Info("git operation", "notebook", filepath.Base(s.root), "operation", operation, "success", err == nil, "duration", time.Since(started).String(), "exitCode", exitCode)
	if err != nil {
		return nil, &commandError{operation: operation, exitCode: exitCode, output: sanitizeOutput(string(output))}
	}
	return output, nil
}

func (s *Service) runWithEditor(ctx context.Context, operation string, arguments ...string) (string, error) {
	started := time.Now()
	commandArguments := append([]string{"-c", "core.hooksPath=/dev/null", "-C", s.root}, arguments...)
	// #nosec G204 -- no shell is used; callers construct a fixed Git subcommand plus separately validated arguments.
	command := exec.CommandContext(ctx, "git", commandArguments...)
	command.Env = append(gitEnvironment(s.sshCommand), "GIT_EDITOR=true", "GIT_SEQUENCE_EDITOR=true")
	output, err := command.CombinedOutput()
	exitCode := 0
	if err != nil {
		exitCode = -1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
	}
	s.logger.Info("git operation", "notebook", filepath.Base(s.root), "operation", operation, "success", err == nil, "duration", time.Since(started).String(), "exitCode", exitCode)
	if err != nil {
		return "", &commandError{operation: operation, exitCode: exitCode, output: sanitizeOutput(string(output))}
	}
	return string(output), nil
}

func (s *Service) fail(err error) Status {
	message := publicGitError(err)
	s.lastFailure = message
	return Status{State: StateSyncFailed, Message: message}
}

func publicGitError(err error) string {
	switch {
	case errors.Is(err, ErrNotRepository):
		return ErrNotRepository.Error()
	case errors.Is(err, ErrDetachedHEAD):
		return ErrDetachedHEAD.Error()
	case errors.Is(err, ErrNoRemote):
		return ErrNoRemote.Error()
	}
	var command *commandError
	if errors.As(err, &command) {
		lower := strings.ToLower(command.output)
		switch {
		case strings.Contains(lower, "authentication failed"), strings.Contains(lower, "permission denied"), strings.Contains(lower, "could not read username"):
			return "Git authentication failed. Check the configured repository credentials."
		case strings.Contains(lower, "could not resolve host"), strings.Contains(lower, "unable to access"), strings.Contains(lower, "connection refused"):
			return "The Git remote is unavailable. Local files remain saved."
		default:
			return fmt.Sprintf("Git %s failed. Local files remain saved.", command.operation)
		}
	}
	return "Git synchronization failed. Local files remain saved."
}

var credentialPattern = regexp.MustCompile(`(?i)(https?://)[^/@\s]+@`)

func sanitizeOutput(value string) string {
	return credentialPattern.ReplaceAllString(value, `${1}[credentials]@`)
}
