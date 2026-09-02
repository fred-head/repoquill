package git

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type CloneResult struct {
	ID     string
	Path   string
	Branch string
}

func Clone(ctx context.Context, baseDirectory, remoteURL, branch string, logger *slog.Logger) (CloneResult, error) {
	return clone(ctx, baseDirectory, remoteURL, branch, "", logger)
}

func CloneManaged(ctx context.Context, baseDirectory, remoteURL, branch, sshCommand string, logger *slog.Logger) (CloneResult, error) {
	return clone(ctx, baseDirectory, remoteURL, branch, sshCommand, logger)
}

func clone(ctx context.Context, baseDirectory, remoteURL, branch, sshCommand string, logger *slog.Logger) (CloneResult, error) {
	if err := validateRemoteURL(remoteURL, sshCommand != ""); err != nil {
		return CloneResult{}, err
	}
	if err := ValidateBranch(branch); err != nil {
		return CloneResult{}, err
	}
	base, err := filepath.Abs(baseDirectory)
	if err != nil {
		return CloneResult{}, err
	}
	// #nosec G301 -- notebook working trees contain intentionally portable Git files; secrets are stored separately below the 0700 keys root.
	if err := os.MkdirAll(base, 0o755); err != nil {
		return CloneResult{}, err
	}
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		return CloneResult{}, err
	}
	identifier := make([]byte, 16)
	if _, err := rand.Read(identifier); err != nil {
		return CloneResult{}, err
	}
	id := hex.EncodeToString(identifier)
	target := filepath.Join(base, id)
	if !isChildPath(base, target) {
		return CloneResult{}, errors.New("invalid notebook destination")
	}

	arguments := []string{"clone", "--origin", "origin"}
	if branch != "" {
		arguments = append(arguments, "--branch", branch, "--single-branch")
	}
	arguments = append(arguments, "--", remoteURL, target)
	started := time.Now()
	command := exec.CommandContext(ctx, "git", arguments...)
	command.Env = gitEnvironment(sshCommand)
	output, commandErr := command.CombinedOutput()
	exitCode := 0
	if commandErr != nil {
		exitCode = -1
		var exitError *exec.ExitError
		if errors.As(commandErr, &exitError) {
			exitCode = exitError.ExitCode()
		}
	}
	logger.Info("git operation", "notebook", id, "operation", "clone", "success", commandErr == nil, "duration", time.Since(started).String(), "exitCode", exitCode)
	if commandErr != nil {
		if isChildPath(base, target) {
			_ = os.RemoveAll(target)
		}
		return CloneResult{}, &commandError{operation: "clone", exitCode: exitCode, output: sanitizeOutput(string(output))}
	}
	service := NewManagedService(target, sshCommand, logger)
	actualBranch, err := service.branch(ctx)
	if err != nil {
		_ = os.RemoveAll(target)
		return CloneResult{}, err
	}
	return CloneResult{ID: id, Path: target, Branch: actualBranch}, nil
}

func isChildPath(parent, candidate string) bool {
	relative, err := filepath.Rel(parent, candidate)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
