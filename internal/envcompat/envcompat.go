// Package envcompat resolves the VariaNotes environment namespace while
// retaining the former RepoQuill names during the transition.
package envcompat

import (
	"fmt"
	"strings"
)

type LookupFunc func(string) (string, bool)

// Lookup prefers VARIANOTES_* values and falls back to their REPOQUILL_*
// counterparts. Non-empty values set under both names must agree, otherwise
// startup fails with an explicit configuration error.
func Lookup(lookup LookupFunc, name string) (string, bool, error) {
	if lookup == nil {
		return "", false, fmt.Errorf("environment lookup is required")
	}
	if !strings.HasPrefix(name, "VARIANOTES_") {
		return "", false, fmt.Errorf("environment name %q must use the VARIANOTES_ prefix", name)
	}
	legacyName := "REPOQUILL_" + strings.TrimPrefix(name, "VARIANOTES_")
	value, found := lookup(name)
	legacyValue, legacyFound := lookup(legacyName)
	valueSet := found && strings.TrimSpace(value) != ""
	legacySet := legacyFound && strings.TrimSpace(legacyValue) != ""
	if valueSet && legacySet && strings.TrimSpace(value) != strings.TrimSpace(legacyValue) {
		return "", false, fmt.Errorf("conflicting %s and %s values", name, legacyName)
	}
	if valueSet {
		return value, true, nil
	}
	if legacySet {
		return legacyValue, true, nil
	}
	if found {
		return value, true, nil
	}
	if legacyFound {
		return legacyValue, true, nil
	}
	return "", false, nil
}
