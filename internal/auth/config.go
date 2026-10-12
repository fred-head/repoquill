package auth

import (
	"errors"
	"fmt"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/fred-head/repoquill/internal/envcompat"
)

type Mode string

const (
	ModeLocal    Mode = "local"
	ModeDisabled Mode = "disabled"

	OwnerPrincipal = "owner"
)

type Config struct {
	Mode                Mode
	ModeExplicit        bool
	MetadataPath        string
	EncryptionKeyPath   string
	CookieSecure        bool
	TrustedProxies      []netip.Prefix
	AllowMFAKeyRecovery bool
}

type EnvironmentLookup func(string) (string, bool)

// ConfigFromEnvironment defines fail-closed migration from an installation
// without built-in authentication. An absent mode selects local authentication
// and setup-required rather than silently retaining unauthenticated access.
func ConfigFromEnvironment(lookup EnvironmentLookup) (Config, error) {
	if lookup == nil {
		return Config{}, errors.New("authentication environment lookup is required")
	}

	read := func(name string) (string, bool, error) {
		return envcompat.Lookup(envcompat.LookupFunc(lookup), name)
	}
	rawMode, explicit, err := read("VARIANOTES_AUTH_MODE")
	if err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(rawMode) == "" {
		rawMode = string(ModeLocal)
		explicit = false
	}
	mode, err := ParseMode(rawMode)
	if err != nil {
		return Config{}, err
	}

	metadataPath, _, err := read("VARIANOTES_AUTH_METADATA")
	if err != nil {
		return Config{}, err
	}
	metadataPath = strings.TrimSpace(metadataPath)
	if metadataPath == "" {
		notebookMetadata, ok, lookupErr := read("VARIANOTES_NOTEBOOK_METADATA")
		if lookupErr != nil {
			return Config{}, lookupErr
		}
		if ok && strings.TrimSpace(notebookMetadata) != "" {
			metadataPath = filepath.Join(filepath.Dir(strings.TrimSpace(notebookMetadata)), "auth.db")
		} else {
			metadataPath = "/data/app/auth.db"
		}
	}
	if !filepath.IsAbs(metadataPath) {
		return Config{}, errors.New("authentication metadata path must be absolute")
	}
	encryptionKeyPath, _, err := read("VARIANOTES_AUTH_ENCRYPTION_KEY_FILE")
	if err != nil {
		return Config{}, err
	}
	encryptionKeyPath = strings.TrimSpace(encryptionKeyPath)
	if encryptionKeyPath == "" {
		encryptionKeyPath = filepath.Join(filepath.Dir(metadataPath), "auth.key")
	}
	if !filepath.IsAbs(encryptionKeyPath) {
		return Config{}, errors.New("authentication encryption key path must be absolute")
	}

	cookieSecure := true
	if raw, ok, lookupErr := read("VARIANOTES_SESSION_COOKIE_SECURE"); lookupErr != nil {
		return Config{}, lookupErr
	} else if ok && strings.TrimSpace(raw) != "" {
		cookieSecure, err = strconv.ParseBool(strings.TrimSpace(raw))
		if err != nil {
			return Config{}, errors.New("VARIANOTES_SESSION_COOKIE_SECURE must be true or false")
		}
	}
	trustedProxies, err := parseTrustedProxies(read)
	if err != nil {
		return Config{}, err
	}
	return Config{Mode: mode, ModeExplicit: explicit, MetadataPath: filepath.Clean(metadataPath), EncryptionKeyPath: filepath.Clean(encryptionKeyPath), CookieSecure: cookieSecure, TrustedProxies: trustedProxies}, nil
}

func parseTrustedProxies(lookup func(string) (string, bool, error)) ([]netip.Prefix, error) {
	raw, _, err := lookup("VARIANOTES_TRUSTED_PROXIES")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	prefixes := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			return nil, errors.New("VARIANOTES_TRUSTED_PROXIES contains an empty entry")
		}
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			address, addressErr := netip.ParseAddr(value)
			if addressErr != nil {
				return nil, fmt.Errorf("invalid trusted proxy %q", value)
			}
			prefix = netip.PrefixFrom(address, address.BitLen())
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
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
