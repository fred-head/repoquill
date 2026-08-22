package git

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateSSHKeySeparatesPublicAndPrivateMaterial(t *testing.T) {
	keys := filepath.Join(t.TempDir(), "keys")
	generated, err := GenerateSSHKey(keys, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(generated.PublicKey, "ssh-ed25519 ") || !strings.Contains(generated.PublicKey, "repoquill-"+generated.ID) {
		t.Fatalf("unexpected public key: %q", generated.PublicKey)
	}
	privatePath := filepath.Join(keys, generated.ID, "id_ed25519")
	private, err := os.ReadFile(privatePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(generated.PublicKey, string(private)) || !strings.Contains(string(private), "OPENSSH PRIVATE KEY") {
		t.Fatal("private/public key separation failed")
	}
	info, err := os.Stat(privatePath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("private key permissions are not restrictive: %v, %v", info, err)
	}
	_, command, err := ResolveManagedSSH(keys, generated.ID, filepath.Join(keys, "known_hosts"))
	if err != nil || !strings.Contains(command, privatePath) || strings.Contains(command, "StrictHostKeyChecking=no") {
		t.Fatalf("managed SSH command is unsafe: %q, %v", command, err)
	}
}

func TestManagedSSHKeyIDsCannotEscapeOrCrossResolve(t *testing.T) {
	keys := filepath.Join(t.TempDir(), "keys")
	first, err := GenerateSSHKey(keys, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	second, err := GenerateSSHKey(keys, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	_, firstCommand, err := ResolveManagedSSH(keys, first.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(firstCommand, second.ID) {
		t.Fatal("one notebook SSH configuration selected another key")
	}
	for _, unsafe := range []string{"../key", second.ID + "/../" + first.ID, "", strings.Repeat("a", 31)} {
		if _, _, err := ResolveManagedSSH(keys, unsafe, ""); err == nil {
			t.Errorf("unsafe key ID %q was accepted", unsafe)
		}
	}
}

func TestListAndDeleteManagedSSHKeys(t *testing.T) {
	keysDirectory := filepath.Join(t.TempDir(), "keys")
	generated, err := GenerateSSHKey(keysDirectory, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	keys, err := ListManagedSSHKeys(keysDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[0].ID != generated.ID || keys[0].PublicKey != generated.PublicKey || keys[0].CreatedAt == "" {
		t.Fatalf("unexpected managed keys: %#v", keys)
	}
	if err := DeleteManagedSSHKey(keysDirectory, generated.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(keysDirectory, generated.ID)); !os.IsNotExist(err) {
		t.Fatal("managed SSH key directory still exists")
	}
}

func TestDeleteManagedSSHKeyRejectsUnexpectedDirectoryContents(t *testing.T) {
	keysDirectory := filepath.Join(t.TempDir(), "keys")
	generated, err := GenerateSSHKey(keysDirectory, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(keysDirectory, generated.ID, "unexpected")
	if err := os.WriteFile(extra, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := DeleteManagedSSHKey(keysDirectory, generated.ID); err == nil {
		t.Fatal("key directory with unexpected contents was deleted")
	}
	if _, err := os.Stat(filepath.Join(keysDirectory, generated.ID, "id_ed25519")); err != nil {
		t.Fatal("private key was modified on rejected deletion")
	}
}

func TestExistingServerConnectionModeRemainsFunctional(t *testing.T) {
	_, remote := testRepository(t)
	result := TestConnection(context.Background(), remote, "main", "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if result.State != "success" {
		t.Fatalf("local existing-server connection failed: %#v", result)
	}
}

func TestConnectionAcceptsEmptyRepositoryWithoutConfiguredBranch(t *testing.T) {
	remote := filepath.Join(t.TempDir(), "empty.git")
	command := exec.Command("git", "init", "--bare", remote)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create empty remote: %v: %s", err, output)
	}
	result := TestConnection(context.Background(), remote, "", "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if result.State != "success" {
		t.Fatalf("empty repository connection failed: %#v", result)
	}
}

func TestManagedSSHRejectsCredentialAndHTTPSURLs(t *testing.T) {
	for _, remote := range []string{"https://user:token@example.test/repo.git", "https://example.test/repo.git", "ssh://user:secret@example.test/repo.git", "--upload-pack=evil", "/tmp/repository", "repository"} {
		if err := validateRemoteURL(remote, true); err == nil {
			t.Errorf("managed SSH accepted unsafe URL %q", remote)
		}
	}
	for _, remote := range []string{"git@example.test:user/notes.git", "ssh://git@example.test/user/notes.git"} {
		if err := validateRemoteURL(remote, true); err != nil {
			t.Errorf("managed SSH rejected URL %q: %v", remote, err)
		}
	}
}

func TestOnboardingRemoteURLRejectsLocalAndUnsafeProtocols(t *testing.T) {
	for _, remote := range []string{"/tmp/repository", "../repository", "file:///tmp/repository", "git://example.test/repo.git", "ext::sh -c evil", "https://user:token@example.test/repo.git", "git@-host:notes.git"} {
		if err := ValidateRemoteURL(remote, false); err == nil {
			t.Errorf("onboarding accepted unsafe URL %q", remote)
		}
	}
	for _, remote := range []string{"https://example.test/user/notes.git", "git@example.test:user/notes.git", "ssh://git@example.test/user/notes.git"} {
		if err := ValidateRemoteURL(remote, false); err != nil {
			t.Errorf("onboarding rejected remote URL %q: %v", remote, err)
		}
	}
	if err := ValidateRemoteURL("https://example.test/user/notes.git", true); err == nil {
		t.Fatal("SSH onboarding accepted an HTTPS URL")
	}
}

func TestBranchValidationRejectsGitRevisionAndOptionSyntax(t *testing.T) {
	for _, branch := range []string{"-main", "../main", "main..other", "main@{1}", "main lock", "main~1", ".hidden", "main.lock"} {
		if err := ValidateBranch(branch); err == nil {
			t.Errorf("accepted unsafe branch %q", branch)
		}
	}
	for _, branch := range []string{"", "main", "feature/mobile-ui"} {
		if err := ValidateBranch(branch); err != nil {
			t.Errorf("rejected valid branch %q: %v", branch, err)
		}
	}
}

func TestConnectionFailureClassification(t *testing.T) {
	tests := []struct {
		name   string
		output string
		state  string
	}{
		{name: "unknown host", output: "Host key verification failed.", state: "host_verification_failed"},
		{name: "changed host", output: "REMOTE HOST IDENTIFICATION HAS CHANGED!", state: "host_verification_failed"},
		{name: "authentication", output: "git@example: Permission denied (publickey).", state: "authentication_failed"},
		{name: "missing repository", output: "ERROR: Repository not found.", state: "repository_not_found"},
		{name: "network", output: "ssh: Could not resolve hostname example", state: "network_error"},
		{name: "generic", output: "unexpected failure", state: "failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if result := classifyConnectionFailure(test.output); result.State != test.state {
				t.Fatalf("state = %q, want %q", result.State, test.state)
			}
		})
	}
}

func TestConnectionDiagnosticRedactsEmbeddedCredentials(t *testing.T) {
	diagnostic := safeConnectionDiagnostic("fatal: https://user:secret@example.test/repo.git failed\nsecond line")
	if strings.Contains(diagnostic, "user:secret") || !strings.Contains(diagnostic, "[credentials]") || strings.Contains(diagnostic, "\n") {
		t.Fatalf("unsafe diagnostic: %q", diagnostic)
	}
}
