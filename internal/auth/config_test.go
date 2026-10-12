package auth

import (
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigFromEnvironmentDefaultsSafelyToLocal(t *testing.T) {
	values := map[string]string{"REPOQUILL_NOTEBOOK_METADATA": "/srv/repoquill/notebooks.json"}
	config, err := ConfigFromEnvironment(mapLookup(values))
	if err != nil {
		t.Fatal(err)
	}
	if config.Mode != ModeLocal || config.ModeExplicit {
		t.Fatalf("expected implicit local mode, got %#v", config)
	}
	if config.MetadataPath != "/srv/repoquill/auth.db" {
		t.Fatalf("unexpected metadata path %q", config.MetadataPath)
	}
	if !config.CookieSecure {
		t.Fatal("secure session cookies must be the default")
	}
	if config.EncryptionKeyPath != "/srv/repoquill/auth.key" {
		t.Fatalf("unexpected encryption key path %q", config.EncryptionKeyPath)
	}
}

func TestConfigFromEnvironmentAcceptsExplicitDisabledMode(t *testing.T) {
	values := map[string]string{
		"REPOQUILL_AUTH_MODE":     "disabled",
		"REPOQUILL_AUTH_METADATA": filepath.Join(t.TempDir(), "auth.db"),
	}
	config, err := ConfigFromEnvironment(mapLookup(values))
	if err != nil {
		t.Fatal(err)
	}
	if config.Mode != ModeDisabled || !config.ModeExplicit {
		t.Fatalf("expected explicit disabled mode, got %#v", config)
	}
}

func TestConfigFromEnvironmentUsesVariaNotesNamesAndRetainsPaths(t *testing.T) {
	metadataPath := filepath.Join(t.TempDir(), "varianotes-auth.db")
	config, err := ConfigFromEnvironment(mapLookup(map[string]string{
		"VARIANOTES_AUTH_MODE":     "local",
		"VARIANOTES_AUTH_METADATA": metadataPath,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if config.MetadataPath != metadataPath {
		t.Fatalf("configured auth path changed: got %q, want %q", config.MetadataPath, metadataPath)
	}
	if config.EncryptionKeyPath != filepath.Join(filepath.Dir(metadataPath), "auth.key") {
		t.Fatalf("unexpected encryption key path %q", config.EncryptionKeyPath)
	}
}

func TestConfigFromEnvironmentRejectsConflictingNamespaces(t *testing.T) {
	_, err := ConfigFromEnvironment(mapLookup(map[string]string{
		"VARIANOTES_AUTH_MODE": "local",
		"REPOQUILL_AUTH_MODE":  "disabled",
	}))
	if err == nil || !strings.Contains(err.Error(), "conflicting VARIANOTES_AUTH_MODE and REPOQUILL_AUTH_MODE") {
		t.Fatalf("expected a clear namespace conflict error, got %v", err)
	}
}

func TestConfigFromEnvironmentParsesOnlyExplicitTrustedProxies(t *testing.T) {
	config, err := ConfigFromEnvironment(mapLookup(map[string]string{
		"REPOQUILL_AUTH_METADATA":   "/tmp/repoquill-auth.db",
		"REPOQUILL_TRUSTED_PROXIES": "10.0.0.2, 2001:db8::/48",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Prefix{netip.MustParsePrefix("10.0.0.2/32"), netip.MustParsePrefix("2001:db8::/48")}
	if len(config.TrustedProxies) != len(want) {
		t.Fatalf("unexpected trusted proxies: %#v", config.TrustedProxies)
	}
	for index := range want {
		if config.TrustedProxies[index] != want[index] {
			t.Fatalf("trusted proxy %d = %s", index, config.TrustedProxies[index])
		}
	}
}

func TestConfigFromEnvironmentRejectsUnsafeValues(t *testing.T) {
	tests := []map[string]string{
		{"REPOQUILL_AUTH_MODE": "public"},
		{"REPOQUILL_AUTH_MODE": "disabled", "REPOQUILL_AUTH_METADATA": "relative/auth.db"},
		{"REPOQUILL_SESSION_COOKIE_SECURE": "sometimes"},
		{"REPOQUILL_TRUSTED_PROXIES": "10.0.0.1,not-an-address"},
		{"REPOQUILL_TRUSTED_PROXIES": "10.0.0.1,"},
		{"REPOQUILL_AUTH_ENCRYPTION_KEY_FILE": "relative/auth.key"},
	}
	for _, values := range tests {
		if _, err := ConfigFromEnvironment(mapLookup(values)); err == nil {
			t.Fatalf("expected configuration error for %#v", values)
		}
	}
}

func mapLookup(values map[string]string) EnvironmentLookup {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}
