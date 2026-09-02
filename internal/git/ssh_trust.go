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
	"strconv"
	"strings"
	"sync"
	"time"
)

type HostKeyInfo struct {
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
}

type HostTrustDiscovery struct {
	State                 string        `json:"state"`
	Message               string        `json:"message"`
	RequestID             string        `json:"requestId,omitempty"`
	Host                  string        `json:"host"`
	Port                  int           `json:"port"`
	PresentedKeys         []HostKeyInfo `json:"presentedKeys"`
	PreviouslyTrustedKeys []HostKeyInfo `json:"previouslyTrustedKeys,omitempty"`
}

type hostTarget struct {
	host   string
	port   int
	lookup string
}

type discoveredHostKey struct {
	keyType     string
	encoded     string
	fingerprint string
}

type pendingHostTrust struct {
	target  hostTarget
	keys    []discoveredHostKey
	expires time.Time
}

type hostKeyScanner func(context.Context, hostTarget) ([]discoveredHostKey, error)

type HostTrustService struct {
	knownHostsPath string
	logger         *slog.Logger
	scan           hostKeyScanner
	mu             sync.Mutex
	pending        map[string]pendingHostTrust
}

var sshHostPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func NewHostTrustService(knownHostsPath string, logger *slog.Logger) *HostTrustService {
	service := &HostTrustService{knownHostsPath: knownHostsPath, logger: logger, pending: make(map[string]pendingHostTrust)}
	service.scan = service.scanHost
	return service
}

func (s *HostTrustService) Discover(ctx context.Context, remoteURL string) (HostTrustDiscovery, error) {
	target, err := parseSSHHost(remoteURL)
	if err != nil {
		return HostTrustDiscovery{}, err
	}
	presented, err := s.scan(ctx, target)
	if err != nil {
		return HostTrustDiscovery{}, err
	}
	trusted, err := readTrustedHostKeys(s.knownHostsPath, target.lookup)
	if err != nil {
		return HostTrustDiscovery{}, err
	}
	result := HostTrustDiscovery{Host: target.host, Port: target.port, PresentedKeys: publicHostKeys(presented)}
	if len(trusted) > 0 {
		if anyHostKeyMatches(trusted, presented) {
			result.State = "already_trusted"
			result.Message = "This SSH host key is already trusted. Retry the connection test."
			return result, nil
		}
		result.State = "host_key_changed"
		result.Message = "The SSH host key has changed. The connection remains blocked and requires administrator review."
		result.PreviouslyTrustedKeys = publicHostKeys(trusted)
		return result, nil
	}
	requestID, err := randomTrustID()
	if err != nil {
		return HostTrustDiscovery{}, err
	}
	s.mu.Lock()
	s.pruneExpiredLocked()
	s.pending[requestID] = pendingHostTrust{target: target, keys: presented, expires: time.Now().Add(10 * time.Minute)}
	s.mu.Unlock()
	result.State = "unknown_host"
	result.Message = "RepoQuill has not connected to this SSH host before. Verify the presented fingerprints before trusting it."
	result.RequestID = requestID
	return result, nil
}

func (s *HostTrustService) Approve(ctx context.Context, requestID string) (HostTrustDiscovery, error) {
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(requestID) {
		return HostTrustDiscovery{}, errors.New("invalid or expired host trust request")
	}
	s.mu.Lock()
	s.pruneExpiredLocked()
	pending, ok := s.pending[requestID]
	s.mu.Unlock()
	if !ok {
		return HostTrustDiscovery{}, errors.New("invalid or expired host trust request")
	}
	presented, err := s.scan(ctx, pending.target)
	if err != nil {
		return HostTrustDiscovery{}, err
	}
	if !sameHostKeys(pending.keys, presented) {
		return HostTrustDiscovery{}, errors.New("SSH host keys changed before approval; review them again")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	trusted, err := readTrustedHostKeys(s.knownHostsPath, pending.target.lookup)
	if err != nil {
		return HostTrustDiscovery{}, err
	}
	if len(trusted) > 0 && !anyHostKeyMatches(trusted, pending.keys) {
		return HostTrustDiscovery{}, errors.New("an existing trusted SSH host key cannot be replaced automatically")
	}
	if len(trusted) == 0 {
		if err := appendKnownHostKeys(s.knownHostsPath, pending.target.lookup, pending.keys); err != nil {
			return HostTrustDiscovery{}, err
		}
	}
	delete(s.pending, requestID)
	for _, key := range pending.keys {
		s.logger.Info("SSH host trust approved", "host", pending.target.host, "port", pending.target.port, "operation", "ssh-host-trust", "status", "approved", "keyType", key.keyType, "fingerprint", key.fingerprint)
	}
	return HostTrustDiscovery{State: "trusted", Message: "SSH host trusted. Retry the connection test.", Host: pending.target.host, Port: pending.target.port, PresentedKeys: publicHostKeys(pending.keys)}, nil
}

func (s *HostTrustService) pruneExpiredLocked() {
	now := time.Now()
	for id, request := range s.pending {
		if now.After(request.expires) {
			delete(s.pending, id)
		}
	}
}

func (s *HostTrustService) scanHost(ctx context.Context, target hostTarget) ([]discoveredHostKey, error) {
	arguments := []string{"-T", "10", "-p", strconv.Itoa(target.port), target.host}
	// #nosec G204 -- no shell is used and parseSSHHost validates both hostname and numeric port before invocation.
	command := exec.CommandContext(ctx, "ssh-keyscan", arguments...)
	output, err := command.Output()
	if err != nil && len(output) == 0 {
		return nil, errors.New("could not retrieve SSH host keys")
	}
	return parseScannedHostKeys(string(output))
}

func parseSSHHost(remoteURL string) (hostTarget, error) {
	if err := validateRemoteURL(remoteURL, true); err != nil {
		return hostTarget{}, err
	}
	target := hostTarget{port: 22}
	if strings.HasPrefix(strings.ToLower(remoteURL), "ssh://") {
		parsed, err := url.Parse(remoteURL)
		if err != nil {
			return target, errors.New("invalid SSH repository URL")
		}
		target.host = parsed.Hostname()
		if parsed.Port() != "" {
			port, err := strconv.Atoi(parsed.Port())
			if err != nil || port < 1 || port > 65535 {
				return target, errors.New("invalid SSH port")
			}
			target.port = port
		}
	} else {
		prefix := remoteURL[:strings.IndexByte(remoteURL, ':')]
		if at := strings.LastIndexByte(prefix, '@'); at >= 0 {
			prefix = prefix[at+1:]
		}
		target.host = prefix
	}
	if net.ParseIP(target.host) == nil && (!sshHostPattern.MatchString(target.host) || strings.HasPrefix(target.host, "-")) {
		return target, errors.New("invalid SSH hostname")
	}
	target.lookup = target.host
	if target.port != 22 {
		target.lookup = fmt.Sprintf("[%s]:%d", target.host, target.port)
	}
	return target, nil
}

func parseScannedHostKeys(output string) ([]discoveredHostKey, error) {
	byIdentity := make(map[string]discoveredHostKey)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(fields[2])
		if err != nil || len(decoded) == 0 {
			continue
		}
		digest := sha256.Sum256(decoded)
		key := discoveredHostKey{keyType: fields[1], encoded: fields[2], fingerprint: "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])}
		byIdentity[key.keyType+" "+key.encoded] = key
	}
	keys := make([]discoveredHostKey, 0, len(byIdentity))
	for _, key := range byIdentity {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].keyType < keys[j].keyType })
	if len(keys) == 0 {
		return nil, errors.New("SSH host did not present a usable public host key")
	}
	return keys, nil
}

func readTrustedHostKeys(path, lookup string) ([]discoveredHostKey, error) {
	// #nosec G304 -- path is the operator-configured known_hosts file, never request input.
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var matching strings.Builder
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		for _, host := range strings.Split(fields[0], ",") {
			if host == lookup {
				matching.WriteString(line)
				matching.WriteByte('\n')
			}
		}
	}
	if matching.Len() == 0 {
		return nil, nil
	}
	return parseScannedHostKeys(matching.String())
}

func appendKnownHostKeys(path, lookup string, keys []discoveredHostKey) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("SSH known_hosts is not configured")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	// #nosec G304 -- path is the operator-configured known_hosts file; request data cannot select another filesystem path.
	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var updated strings.Builder
	updated.Write(existing)
	if len(existing) > 0 && existing[len(existing)-1] != '\n' {
		updated.WriteByte('\n')
	}
	for _, key := range keys {
		fmt.Fprintf(&updated, "%s %s %s\n", lookup, key.keyType, key.encoded)
	}
	temporary, err := os.CreateTemp(directory, ".known-hosts-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.WriteString(updated.String()); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func sameHostKeys(left, right []discoveredHostKey) bool {
	if len(left) != len(right) {
		return false
	}
	identities := make(map[string]struct{}, len(left))
	for _, key := range left {
		identities[key.keyType+" "+key.encoded] = struct{}{}
	}
	for _, key := range right {
		if _, ok := identities[key.keyType+" "+key.encoded]; !ok {
			return false
		}
	}
	return true
}

func anyHostKeyMatches(left, right []discoveredHostKey) bool {
	identities := make(map[string]struct{}, len(left))
	for _, key := range left {
		identities[key.keyType+" "+key.encoded] = struct{}{}
	}
	for _, key := range right {
		if _, ok := identities[key.keyType+" "+key.encoded]; ok {
			return true
		}
	}
	return false
}

func publicHostKeys(keys []discoveredHostKey) []HostKeyInfo {
	result := make([]HostKeyInfo, len(keys))
	for index, key := range keys {
		result[index] = HostKeyInfo{KeyType: strings.TrimPrefix(key.keyType, "ssh-"), Fingerprint: key.fingerprint}
	}
	return result
}

func randomTrustID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
