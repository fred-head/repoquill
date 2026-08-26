package auth

import (
	"path/filepath"
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

func TestConfigFromEnvironmentRejectsUnsafeValues(t *testing.T) {
	tests := []map[string]string{
		{"REPOQUILL_AUTH_MODE": "public"},
		{"REPOQUILL_AUTH_MODE": "disabled", "REPOQUILL_AUTH_METADATA": "relative/auth.db"},
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
