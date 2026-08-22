package git

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSSHHostTrustRequiresApprovalAndPersistsExactDiscoveredKey(t *testing.T) {
	knownHosts := filepath.Join(t.TempDir(), "keys", "known_hosts")
	key := mustScannedKey(t, "example.test ssh-ed25519 AQID")
	service := newFakeHostTrustService(knownHosts, []discoveredHostKey{key})

	discovery, err := service.Discover(context.Background(), "git@example.test:user/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	if discovery.State != "unknown_host" || discovery.RequestID == "" || discovery.Host != "example.test" || discovery.Port != 22 {
		t.Fatalf("unexpected discovery: %#v", discovery)
	}
	if _, err := os.Stat(knownHosts); !os.IsNotExist(err) {
		t.Fatal("host was trusted before explicit approval")
	}
	if _, err := service.Approve(context.Background(), discovery.RequestID); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(knownHosts)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "example.test ssh-ed25519 AQID\n" {
		t.Fatalf("unexpected known_hosts content: %q", content)
	}
	info, _ := os.Stat(knownHosts)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("known_hosts permissions = %o", info.Mode().Perm())
	}

	restarted := newFakeHostTrustService(knownHosts, []discoveredHostKey{key})
	afterRestart, err := restarted.Discover(context.Background(), "git@example.test:user/repo.git")
	if err != nil || afterRestart.State != "already_trusted" || afterRestart.RequestID != "" {
		t.Fatalf("trust did not persist: %#v, %v", afterRestart, err)
	}
}

func TestSSHHostTrustDistinguishesChangedKeysAndRefusesReplacement(t *testing.T) {
	knownHosts := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(knownHosts, []byte("example.test ssh-ed25519 AQID\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed := mustScannedKey(t, "example.test ssh-ed25519 BAUG")
	service := newFakeHostTrustService(knownHosts, []discoveredHostKey{changed})
	discovery, err := service.Discover(context.Background(), "git@example.test:user/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	if discovery.State != "host_key_changed" || discovery.RequestID != "" || len(discovery.PreviouslyTrustedKeys) != 1 {
		t.Fatalf("changed key was not blocked: %#v", discovery)
	}
	if _, err := service.Approve(context.Background(), strings.Repeat("a", 32)); err == nil {
		t.Fatal("arbitrary approval replaced an existing host key")
	}
	content, _ := os.ReadFile(knownHosts)
	if string(content) != "example.test ssh-ed25519 AQID\n" {
		t.Fatal("trusted host key was modified")
	}
}

func TestSSHHostTrustRejectsDiscoveryApprovalRace(t *testing.T) {
	knownHosts := filepath.Join(t.TempDir(), "known_hosts")
	first := mustScannedKey(t, "example.test ssh-ed25519 AQID")
	second := mustScannedKey(t, "example.test ssh-ed25519 BAUG")
	service := newFakeHostTrustService(knownHosts, []discoveredHostKey{first})
	discovery, err := service.Discover(context.Background(), "ssh://git@example.test:2222/user/repo.git")
	if err != nil || discovery.Port != 2222 {
		t.Fatalf("non-default port discovery failed: %#v, %v", discovery, err)
	}
	service.scan = func(context.Context, hostTarget) ([]discoveredHostKey, error) {
		return []discoveredHostKey{second}, nil
	}
	if _, err := service.Approve(context.Background(), discovery.RequestID); err == nil {
		t.Fatal("changed key was accepted between discovery and approval")
	}
	if _, err := os.Stat(knownHosts); !os.IsNotExist(err) {
		t.Fatal("race wrote an unapproved key")
	}
}

func TestParseSSHHostAndFingerprint(t *testing.T) {
	target, err := parseSSHHost("ssh://git@[2001:db8::1]:2222/user/repo.git")
	if err != nil || target.host != "2001:db8::1" || target.port != 2222 || target.lookup != "[2001:db8::1]:2222" {
		t.Fatalf("unexpected target: %#v, %v", target, err)
	}
	key := mustScannedKey(t, "example.test ssh-ed25519 AQID")
	if key.fingerprint != "SHA256:A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E" {
		t.Fatalf("unexpected SHA256 fingerprint: %s", key.fingerprint)
	}
}

func newFakeHostTrustService(path string, keys []discoveredHostKey) *HostTrustService {
	service := NewHostTrustService(path, slog.New(slog.NewTextHandler(io.Discard, nil)))
	service.scan = func(context.Context, hostTarget) ([]discoveredHostKey, error) { return keys, nil }
	return service
}

func mustScannedKey(t *testing.T, line string) discoveredHostKey {
	t.Helper()
	keys, err := parseScannedHostKeys(line)
	if err != nil {
		t.Fatal(err)
	}
	return keys[0]
}
