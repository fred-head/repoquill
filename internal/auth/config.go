package auth

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

type Mode string

const (
	ModeLocal    Mode = "local"
	ModeDisabled Mode = "disabled"

	OwnerPrincipal = "owner"
)

type Config struct {
	Mode         Mode
	ModeExplicit bool
	MetadataPath string
}

type EnvironmentLookup func(string) (string, bool)

// ConfigFromEnvironment defines the fail-closed Alpha 1 migration behavior.
// An absent mode selects local authentication, which later phases expose as
// setup-required rather than silently retaining unauthenticated access.
func ConfigFromEnvironment(lookup EnvironmentLookup) (Config, error) {
	if lookup == nil {
		return Config{}, errors.New("authentication environment lookup is required")
	}

	rawMode, explicit := lookup("REPOQUILL_AUTH_MODE")
	if strings.TrimSpace(rawMode) == "" {
		rawMode = string(ModeLocal)
		explicit = false
	}
	mode, err := ParseMode(rawMode)
	if err != nil {
		return Config{}, err
	}

	metadataPath, _ := lookup("REPOQUILL_AUTH_METADATA")
	metadataPath = strings.TrimSpace(metadataPath)
	if metadataPath == "" {
		if notebookMetadata, ok := lookup("REPOQUILL_NOTEBOOK_METADATA"); ok && strings.TrimSpace(notebookMetadata) != "" {
			metadataPath = filepath.Join(filepath.Dir(strings.TrimSpace(notebookMetadata)), "auth.db")
		} else {
			metadataPath = "/data/app/auth.db"
		}
	}
	if !filepath.IsAbs(metadataPath) {
		return Config{}, errors.New("authentication metadata path must be absolute")
	}

	return Config{Mode: mode, ModeExplicit: explicit, MetadataPath: filepath.Clean(metadataPath)}, nil
}

func ParseMode(value string) (Mode, error) {
	mode := Mode(strings.ToLower(strings.TrimSpace(value)))
	switch mode {
	case ModeLocal, ModeDisabled:
		return mode, nil
	default:
		return "", fmt.Errorf("unsupported authentication mode %q; expected local or disabled", value)
	}
}
