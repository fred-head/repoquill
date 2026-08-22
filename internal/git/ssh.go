package git

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type SSHKey struct {
	ID        string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

type ManagedSSHKey struct {
	ID          string `json:"keyId"`
	PublicKey   string `json:"publicKey"`
	CreatedAt   string `json:"createdAt"`
	Fingerprint string `json:"fingerprint"`
}

type ConnectionResult struct {
	State   string `json:"state"`
	Message string `json:"message"`
}

var keyIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

var scpRemotePattern = regexp.MustCompile(`^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:[^\s]+$`)

// ValidateRemoteURL applies the stricter rules used for remotely managed notebooks.
// Local paths remain available to package-level Git tests and local tooling, but are
// never accepted from the HTTP onboarding API.
func ValidateRemoteURL(remoteURL string, requireSSH bool) error {
	remoteURL = strings.TrimSpace(remoteURL)
	if err := validateRemoteURL(remoteURL, requireSSH); err != nil {
		return err
	}
	if !strings.Contains(remoteURL, "://") && scpRemotePattern.MatchString(remoteURL) {
		prefix := remoteURL[:strings.IndexByte(remoteURL, ':')]
		if at := strings.LastIndexByte(prefix, '@'); at >= 0 {
			prefix = prefix[at+1:]
		}
		if strings.HasPrefix(prefix, "-") || net.ParseIP(prefix) == nil && !sshHostPattern.MatchString(prefix) {
			return errors.New("invalid SSH repository hostname")
		}
		return nil
	}
	parsed, err := url.Parse(remoteURL)
	if err != nil || parsed.Hostname() == "" || parsed.Path == "" {
		return errors.New("repository URL must be an SSH or HTTPS remote URL")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "ssh":
		return nil
	case "https":
		if requireSSH {
			return errors.New("the selected SSH authentication requires an SSH repository URL")
		}
		return nil
	default:
		return errors.New("repository URL must use SSH or HTTPS")
	}
}

func ValidateBranch(branch string) error {
	branch = strings.TrimSpace(branch)
	if branch == "" {
		return nil
	}
	if len(branch) > 255 || strings.HasPrefix(branch, "-") || strings.HasPrefix(branch, ".") || strings.HasSuffix(branch, ".") || strings.HasSuffix(branch, "/") || strings.Contains(branch, "..") || strings.Contains(branch, "@{") || strings.ContainsAny(branch, " ~^:?*[\\\r\n\x00") {
		return errors.New("invalid Git branch")
	}
	for _, part := range strings.Split(branch, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return errors.New("invalid Git branch")
		}
	}
	return nil
}

func GenerateSSHKey(keysDirectory string, logger *slog.Logger) (SSHKey, error) {
	base, err := prepareKeysDirectory(keysDirectory)
	if err != nil {
		return SSHKey{}, err
	}
	identifier := make([]byte, 16)
	if _, err := rand.Read(identifier); err != nil {
		return SSHKey{}, err
	}
	id := hex.EncodeToString(identifier)
	directory := filepath.Join(base, id)
	if !isChildPath(base, directory) {
		return SSHKey{}, errors.New("invalid SSH key destination")
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		return SSHKey{}, err
	}
	privateKey := filepath.Join(directory, "id_ed25519")
	started := time.Now()
	command := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "repoquill-"+id, "-f", privateKey)
	output, commandErr := command.CombinedOutput()
	logger.Info("git credential operation", "keyId", id, "operation", "generate-ssh-key", "success", commandErr == nil, "duration", time.Since(started).String())
	if commandErr != nil {
		_ = os.RemoveAll(directory)
		return SSHKey{}, fmt.Errorf("generate SSH key: %w: %s", commandErr, sanitizeOutput(string(output)))
	}
	if err := os.Chmod(privateKey, 0o600); err != nil {
		return SSHKey{}, err
	}
	if err := os.Chmod(privateKey+".pub", 0o644); err != nil {
		return SSHKey{}, err
	}
	public, err := os.ReadFile(privateKey + ".pub")
	if err != nil {
		return SSHKey{}, err
	}
	return SSHKey{ID: id, PublicKey: strings.TrimSpace(string(public))}, nil
}

func ListManagedSSHKeys(keysDirectory string) ([]ManagedSSHKey, error) {
	base, err := prepareKeysDirectory(keysDirectory)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, err
	}
	keys := make([]ManagedSSHKey, 0)
	for _, entry := range entries {
		if !entry.IsDir() || !keyIDPattern.MatchString(entry.Name()) || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		privatePath, _, resolveErr := ResolveManagedSSH(base, entry.Name(), "")
		if resolveErr != nil {
			continue
		}
		public, readErr := os.ReadFile(privatePath + ".pub")
		info, statErr := os.Stat(privatePath)
		if readErr != nil || statErr != nil || !strings.HasPrefix(strings.TrimSpace(string(public)), "ssh-ed25519 ") {
			continue
		}
		publicKey := strings.TrimSpace(string(public))
		fields := strings.Fields(publicKey)
		fingerprint := ""
		if len(fields) >= 2 {
			if decoded, decodeErr := base64.StdEncoding.DecodeString(fields[1]); decodeErr == nil {
				digest := sha256.Sum256(decoded)
				fingerprint = "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])
			}
		}
		keys = append(keys, ManagedSSHKey{ID: entry.Name(), PublicKey: publicKey, CreatedAt: info.ModTime().UTC().Format(time.RFC3339), Fingerprint: fingerprint})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].CreatedAt > keys[j].CreatedAt })
	return keys, nil
}

func DeleteManagedSSHKey(keysDirectory, keyID string) error {
	privatePath, _, err := ResolveManagedSSH(keysDirectory, keyID, "")
	if err != nil {
		return err
	}
	directory := filepath.Dir(privatePath)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) != 2 {
		return errors.New("managed SSH key directory contains unexpected files")
	}
	expected := map[string]bool{"id_ed25519": true, "id_ed25519.pub": true}
	for _, entry := range entries {
		if !expected[entry.Name()] || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return errors.New("managed SSH key directory contains unexpected files")
		}
	}
	if err := os.Remove(privatePath + ".pub"); err != nil {
		return err
	}
	if err := os.Remove(privatePath); err != nil {
		return err
	}
	return os.Remove(directory)
}

func ResolveManagedSSH(keysDirectory, keyID, knownHostsPath string) (privateKey string, sshCommand string, err error) {
	if !keyIDPattern.MatchString(keyID) {
		return "", "", errors.New("invalid managed SSH key")
	}
	base, err := prepareKeysDirectory(keysDirectory)
	if err != nil {
		return "", "", err
	}
	privateKey = filepath.Join(base, keyID, "id_ed25519")
	if !isChildPath(base, privateKey) {
		return "", "", errors.New("invalid managed SSH key")
	}
	info, err := os.Lstat(privateKey)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return "", "", errors.New("managed SSH private key is unavailable or has unsafe permissions")
	}
	if knownHostsPath == "" {
		knownHostsPath = filepath.Join(base, "known_hosts")
	}
	knownHostsPath, err = filepath.Abs(knownHostsPath)
	if err != nil {
		return "", "", err
	}
	return privateKey, SSHCommand(privateKey, knownHostsPath), nil
}

func SSHCommand(privateKey, knownHostsPath string) string {
	if strings.TrimSpace(knownHostsPath) == "" {
		return ""
	}
	parts := []string{
		"ssh",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + shellQuote(knownHostsPath),
	}
	if privateKey != "" {
		parts = append(parts, "-o", "IdentitiesOnly=yes", "-i", shellQuote(privateKey))
	}
	return strings.Join(parts, " ")
}

func TestConnection(ctx context.Context, remoteURL, branch, sshCommand string, logger *slog.Logger) ConnectionResult {
	if err := validateRemoteURL(remoteURL, sshCommand != ""); err != nil {
		return ConnectionResult{State: "invalid_url", Message: err.Error()}
	}
	arguments := []string{"ls-remote"}
	if branch != "" {
		arguments = append(arguments, "--exit-code")
	}
	arguments = append(arguments, "--", remoteURL)
	if branch != "" {
		arguments = append(arguments, "refs/heads/"+branch)
	}
	command := exec.CommandContext(ctx, "git", arguments...)
	command.Env = gitEnvironment(sshCommand)
	started := time.Now()
	output, err := command.CombinedOutput()
	logger.Info("git operation", "operation", "ssh-test", "success", err == nil, "duration", time.Since(started).String())
	if err == nil {
		return ConnectionResult{State: "success", Message: "Repository connection successful. Write access will be verified when RepoQuill pushes."}
	}
	var exitError *exec.ExitError
	if branch != "" && errors.As(err, &exitError) && exitError.ExitCode() == 2 && len(output) == 0 {
		return ConnectionResult{State: "branch_not_found", Message: "The configured branch was not found in the repository."}
	}
	result := classifyConnectionFailure(string(output))
	logger.Warn("git connection test failed", "state", result.State, "diagnostic", safeConnectionDiagnostic(string(output)))
	return result
}

func classifyConnectionFailure(output string) ConnectionResult {
	lower := strings.ToLower(output)
	switch {
	case strings.Contains(lower, "host key verification failed"), strings.Contains(lower, "host key is known for"), strings.Contains(lower, "remote host identification has changed"):
		return ConnectionResult{State: "host_verification_failed", Message: "SSH host verification failed. Add the trusted host key to RepoQuill's known_hosts file."}
	case strings.Contains(lower, "permission denied"), strings.Contains(lower, "authentication failed"):
		return ConnectionResult{State: "authentication_failed", Message: "SSH authentication failed. Confirm that the displayed public key has repository access."}
	case strings.Contains(lower, "repository not found"), strings.Contains(lower, "does not appear to be a git repository"):
		return ConnectionResult{State: "repository_not_found", Message: "The repository was not found or the key does not have access."}
	case strings.Contains(lower, "couldn't find remote ref"), strings.Contains(lower, "remote ref does not exist"):
		return ConnectionResult{State: "branch_not_found", Message: "The configured branch was not found in the repository."}
	case strings.Contains(lower, "permission to ") && strings.Contains(lower, "denied"):
		return ConnectionResult{State: "authentication_failed", Message: "The SSH key does not have the required repository access."}
	case strings.Contains(lower, "could not resolve"), strings.Contains(lower, "connection refused"), strings.Contains(lower, "connection timed out"), strings.Contains(lower, "network is unreachable"):
		return ConnectionResult{State: "network_error", Message: "The SSH host could not be reached."}
	default:
		diagnostic := safeConnectionDiagnostic(output)
		if diagnostic != "" {
			return ConnectionResult{State: "failed", Message: "The repository connection test failed. Git reported: " + diagnostic}
		}
		return ConnectionResult{State: "failed", Message: "The repository connection test failed without additional Git output. Check the URL, branch, host verification, and key access."}
	}
}

func safeConnectionDiagnostic(output string) string {
	value := strings.Join(strings.Fields(sanitizeOutput(output)), " ")
	if len(value) > 300 {
		value = value[:300] + "…"
	}
	return value
}

func validateRemoteURL(remoteURL string, managedSSH bool) error {
	remoteURL = strings.TrimSpace(remoteURL)
	if remoteURL == "" || strings.HasPrefix(remoteURL, "-") || strings.ContainsAny(remoteURL, "\r\n\x00") {
		return errors.New("invalid Git repository URL")
	}
	if strings.Contains(remoteURL, "://") {
		if managedSSH {
			if !strings.HasPrefix(strings.ToLower(remoteURL), "ssh://") {
				return errors.New("RepoQuill-managed SSH requires an SSH repository URL")
			}
			parsed, err := url.Parse(remoteURL)
			if err != nil || parsed.Hostname() == "" || parsed.Path == "" {
				return errors.New("invalid Git repository URL")
			}
			if _, hasPassword := parsed.User.Password(); hasPassword {
				return errors.New("repository URLs with embedded credentials are not accepted")
			}
			return nil
		}
		if credentialPattern.MatchString(remoteURL) {
			return errors.New("repository URLs with embedded credentials are not accepted")
		}
	}
	if managedSSH {
		separator := strings.IndexByte(remoteURL, ':')
		if separator <= 0 || separator == len(remoteURL)-1 || strings.ContainsAny(remoteURL[:separator], `/\\`) {
			return errors.New("RepoQuill-managed SSH requires an SSH repository URL")
		}
	}
	return nil
}

func prepareKeysDirectory(keysDirectory string) (string, error) {
	if strings.TrimSpace(keysDirectory) == "" {
		return "", errors.New("managed SSH keys are not configured on this server")
	}
	base, err := filepath.Abs(keysDirectory)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(base, 0o700); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(base)
}

func gitEnvironment(sshCommand string) []string {
	environment := append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if sshCommand != "" {
		environment = append(environment, "GIT_SSH_COMMAND="+sshCommand)
	}
	return environment
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'" }
