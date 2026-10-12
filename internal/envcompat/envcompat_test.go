package envcompat

import (
	"strings"
	"testing"
)

func TestLookupPrefersVariaNotesValueAndRejectsConflict(t *testing.T) {
	for _, test := range []struct {
		name    string
		values  map[string]string
		want    string
		wantErr string
	}{
		{name: "new namespace", values: map[string]string{"VARIANOTES_ADDR": ":8081"}, want: ":8081"},
		{name: "legacy fallback", values: map[string]string{"REPOQUILL_ADDR": ":8082"}, want: ":8082"},
		{name: "matching values", values: map[string]string{"VARIANOTES_ADDR": ":8081", "REPOQUILL_ADDR": ":8081"}, want: ":8081"},
		{name: "conflicting values", values: map[string]string{"VARIANOTES_ADDR": ":8081", "REPOQUILL_ADDR": ":8082"}, wantErr: "conflicting VARIANOTES_ADDR and REPOQUILL_ADDR"},
		{name: "empty new value falls back", values: map[string]string{"VARIANOTES_ADDR": " ", "REPOQUILL_ADDR": ":8082"}, want: ":8082"},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, found, err := Lookup(mapLookup(test.values), "VARIANOTES_ADDR")
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("expected error containing %q, got %v", test.wantErr, err)
				}
				return
			}
			if err != nil || !found || value != test.want {
				t.Fatalf("Lookup() = %q, %t, %v; want %q, true, nil", value, found, err, test.want)
			}
		})
	}
}

func TestLookupRequiresVariaNotesName(t *testing.T) {
	if _, _, err := Lookup(mapLookup(nil), "REPOQUILL_ADDR"); err == nil {
		t.Fatal("legacy name was accepted as the canonical lookup name")
	}
}

func mapLookup(values map[string]string) LookupFunc {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}
