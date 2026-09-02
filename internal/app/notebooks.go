package app

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

var notebookRegistryMu sync.Mutex

type notebookRecord struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	LocalPath    string `json:"localPath"`
	RemoteURL    string `json:"remoteUrl,omitempty"`
	Branch       string `json:"branch"`
	AuthType     string `json:"authType"`
	KeyID        string `json:"keyId,omitempty"`
	LastSyncedAt string `json:"lastSyncedAt,omitempty"`
}

func recordNotebookSync(metadataPath, notebookID, lastSyncedAt string) error {
	notebookRegistryMu.Lock()
	defer notebookRegistryMu.Unlock()
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil {
		return err
	}
	for index := range registry.Entries {
		if registry.Entries[index].ID != notebookID {
			continue
		}
		registry.Entries[index].LastSyncedAt = lastSyncedAt
		return writeNotebookRegistry(metadataPath, registry)
	}
	return os.ErrNotExist
}

type notebookRegistry struct {
	ActiveID string           `json:"activeId"`
	Entries  []notebookRecord `json:"notebooks"`
}

func loadActiveNotebook(metadataPath string) (notebookRecord, error) {
	if metadataPath == "" {
		return notebookRecord{}, os.ErrNotExist
	}
	content, err := os.ReadFile(metadataPath)
	if err != nil {
		return notebookRecord{}, err
	}
	var registry notebookRegistry
	if err := json.Unmarshal(content, &registry); err != nil {
		return notebookRecord{}, err
	}
	for _, entry := range registry.Entries {
		if entry.ID == registry.ActiveID {
			return entry, nil
		}
	}
	return notebookRecord{}, errors.New("active notebook metadata is missing")
}

func loadNotebookRegistry(metadataPath string) (notebookRegistry, error) {
	if metadataPath == "" {
		return notebookRegistry{}, os.ErrNotExist
	}
	content, err := os.ReadFile(metadataPath)
	if err != nil {
		return notebookRegistry{}, err
	}
	var registry notebookRegistry
	if err := json.Unmarshal(content, &registry); err != nil {
		return notebookRegistry{}, err
	}
	return registry, nil
}

func registerActiveNotebook(metadataPath string, record notebookRecord) error {
	notebookRegistryMu.Lock()
	defer notebookRegistryMu.Unlock()
	if metadataPath == "" {
		return errors.New("notebook metadata path is not configured")
	}
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	registry.ActiveID = record.ID
	replaced := false
	for index, entry := range registry.Entries {
		if entry.ID == record.ID {
			registry.Entries[index] = record
			replaced = true
			break
		}
	}
	if !replaced {
		registry.Entries = append(registry.Entries, record)
	}
	return writeNotebookRegistry(metadataPath, registry)
}

func registerNotebookWithoutActivation(metadataPath string, record notebookRecord) error {
	notebookRegistryMu.Lock()
	defer notebookRegistryMu.Unlock()
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil {
		return err
	}
	for _, entry := range registry.Entries {
		if entry.ID == record.ID {
			return nil
		}
	}
	registry.Entries = append(registry.Entries, record)
	return writeNotebookRegistry(metadataPath, registry)
}

func findNotebook(metadataPath, notebookID string) (notebookRecord, error) {
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil {
		return notebookRecord{}, err
	}
	for _, entry := range registry.Entries {
		if entry.ID == notebookID {
			return entry, nil
		}
	}
	return notebookRecord{}, os.ErrNotExist
}

func setActiveNotebook(metadataPath, notebookID string) error {
	notebookRegistryMu.Lock()
	defer notebookRegistryMu.Unlock()
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil {
		return err
	}
	registry.ActiveID = notebookID
	return writeNotebookRegistry(metadataPath, registry)
}

func removeLocalNotebook(metadataPath, notebookID string) error {
	notebookRegistryMu.Lock()
	defer notebookRegistryMu.Unlock()
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil {
		return err
	}
	if registry.ActiveID == notebookID && len(registry.Entries) > 1 {
		return errors.New("active notebook cannot be removed")
	}
	for index, entry := range registry.Entries {
		if entry.ID != notebookID {
			continue
		}
		registry.Entries = append(registry.Entries[:index], registry.Entries[index+1:]...)
		if registry.ActiveID == notebookID {
			registry.ActiveID = ""
		}
		return writeNotebookRegistry(metadataPath, registry)
	}
	return os.ErrNotExist
}

func renameNotebook(metadataPath, notebookID, name string) (notebookRecord, error) {
	notebookRegistryMu.Lock()
	defer notebookRegistryMu.Unlock()
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil {
		return notebookRecord{}, err
	}
	for index := range registry.Entries {
		if registry.Entries[index].ID != notebookID {
			continue
		}
		registry.Entries[index].Name = name
		if err := writeNotebookRegistry(metadataPath, registry); err != nil {
			return notebookRecord{}, err
		}
		return registry.Entries[index], nil
	}
	return notebookRecord{}, os.ErrNotExist
}

func writeNotebookRegistry(metadataPath string, registry notebookRegistry) error {
	content, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(metadataPath), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(metadataPath), ".notebooks-*.json")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(content); err != nil {
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
	return os.Rename(temporaryName, metadataPath)
}
