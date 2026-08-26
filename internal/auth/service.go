package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const currentSchemaVersion = 1

type State struct {
	Mode           Mode
	ModeExplicit   bool
	OwnerPrincipal string
	SetupCompleted bool
	SchemaVersion  int
}

type Service struct {
	db     *sql.DB
	config Config
	logger *slog.Logger
}

type migration struct {
	version     int
	destructive bool
	statements  []string
}

var migrations = []migration{
	{
		version: 1,
		statements: []string{
			`CREATE TABLE auth_configuration (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				mode TEXT NOT NULL CHECK (mode IN ('local', 'disabled')),
				owner_principal TEXT NOT NULL CHECK (owner_principal = 'owner'),
				setup_completed INTEGER NOT NULL DEFAULT 0 CHECK (setup_completed IN (0, 1)),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT`,
			`CREATE TABLE auth_sessions (
				session_id_hash BLOB PRIMARY KEY,
				created_at TEXT NOT NULL,
				last_activity_at TEXT NOT NULL,
				idle_expires_at TEXT NOT NULL,
				absolute_expires_at TEXT NOT NULL,
				revoked_at TEXT,
				client_description TEXT NOT NULL DEFAULT ''
			) STRICT`,
			`CREATE TABLE auth_recovery_artifacts (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				secret_hash BLOB NOT NULL,
				created_at TEXT NOT NULL,
				expires_at TEXT,
				consumed_at TEXT
			) STRICT`,
			`CREATE TABLE auth_throttle_state (
				scope TEXT NOT NULL,
				key_hash BLOB NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				window_started_at TEXT NOT NULL,
				next_allowed_at TEXT,
				PRIMARY KEY (scope, key_hash)
			) STRICT`,
			`CREATE TABLE auth_security_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				event_type TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				outcome TEXT NOT NULL,
				details TEXT NOT NULL DEFAULT ''
			) STRICT`,
		},
	},
}

func Open(ctx context.Context, config Config, logger *slog.Logger) (*Service, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if _, err := ParseMode(string(config.Mode)); err != nil {
		return nil, err
	}
	if config.Mode == ModeDisabled && !config.ModeExplicit {
		return nil, errors.New("disabled authentication mode must be explicitly configured")
	}
	if config.MetadataPath == "" || !filepath.IsAbs(config.MetadataPath) {
		return nil, errors.New("authentication metadata path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(config.MetadataPath), 0o700); err != nil {
		return nil, fmt.Errorf("create authentication metadata directory: %w", err)
	}
	if err := os.Chmod(filepath.Dir(config.MetadataPath), 0o700); err != nil {
		return nil, fmt.Errorf("secure authentication metadata directory: %w", err)
	}

	db, err := sql.Open("sqlite", config.MetadataPath)
	if err != nil {
		return nil, fmt.Errorf("open authentication metadata: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	service := &Service{db: db, config: config, logger: logger}
	if err := service.initialize(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := os.Chmod(config.MetadataPath, 0o600); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("secure authentication metadata file: %w", err)
	}
	return service, nil
}

func (s *Service) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Service) State(ctx context.Context) (State, error) {
	var state State
	var mode string
	var setupCompleted int
	err := s.db.QueryRowContext(ctx, `
		SELECT mode, owner_principal, setup_completed
		FROM auth_configuration WHERE id = 1
	`).Scan(&mode, &state.OwnerPrincipal, &setupCompleted)
	if err != nil {
		return State{}, fmt.Errorf("read authentication state: %w", err)
	}
	state.Mode = Mode(mode)
	state.ModeExplicit = s.config.ModeExplicit
	state.SetupCompleted = setupCompleted == 1
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM auth_schema_migrations`).Scan(&state.SchemaVersion); err != nil {
		return State{}, fmt.Errorf("read authentication schema version: %w", err)
	}
	return state, nil
}

func (s *Service) initialize(ctx context.Context) error {
	for _, statement := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA busy_timeout = 5000`,
		`PRAGMA journal_mode = WAL`,
		`CREATE TABLE IF NOT EXISTS auth_schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		) STRICT`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize authentication metadata: %w", err)
		}
	}

	var existingSchemaVersion int
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM auth_schema_migrations`).Scan(&existingSchemaVersion); err != nil {
		return fmt.Errorf("read authentication schema version: %w", err)
	}
	if existingSchemaVersion > currentSchemaVersion {
		return fmt.Errorf("authentication schema version %d is newer than supported version %d", existingSchemaVersion, currentSchemaVersion)
	}

	for _, next := range migrations {
		var applied int
		err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM auth_schema_migrations WHERE version = ?`, next.version).Scan(&applied)
		if err != nil {
			return fmt.Errorf("inspect authentication schema: %w", err)
		}
		if applied != 0 {
			continue
		}
		if next.destructive {
			if _, err := s.backupDatabase(ctx); err != nil {
				return fmt.Errorf("back up authentication metadata: %w", err)
			}
		}
		if err := s.applyMigration(ctx, next); err != nil {
			return err
		}
	}

	var schemaVersion int
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM auth_schema_migrations`).Scan(&schemaVersion); err != nil {
		return fmt.Errorf("read authentication schema version: %w", err)
	}
	if schemaVersion != currentSchemaVersion {
		return fmt.Errorf("unsupported authentication schema version %d", schemaVersion)
	}
	return s.reconcileConfiguration(ctx)
}

func (s *Service) applyMigration(ctx context.Context, next migration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin authentication migration %d: %w", next.version, err)
	}
	defer tx.Rollback()
	for _, statement := range next.statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("apply authentication migration %d: %w", next.version, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO auth_schema_migrations(version, applied_at) VALUES (?, ?)`, next.version, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return fmt.Errorf("record authentication migration %d: %w", next.version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit authentication migration %d: %w", next.version, err)
	}
	return nil
}

func (s *Service) reconcileConfiguration(ctx context.Context) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin authentication configuration: %w", err)
	}
	defer tx.Rollback()

	var storedMode string
	err = tx.QueryRowContext(ctx, `SELECT mode FROM auth_configuration WHERE id = 1`).Scan(&storedMode)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO auth_configuration(id, mode, owner_principal, setup_completed, created_at, updated_at)
			VALUES (1, ?, ?, 0, ?, ?)
		`, s.config.Mode, OwnerPrincipal, now, now); err != nil {
			return fmt.Errorf("create authentication configuration: %w", err)
		}
	case err != nil:
		return fmt.Errorf("read authentication configuration: %w", err)
	case storedMode != string(s.config.Mode):
		// Mode transitions invalidate every authentication-level artifact. Later
		// phases add their records to these dedicated tables.
		for _, statement := range []string{
			`DELETE FROM auth_sessions`,
			`DELETE FROM auth_recovery_artifacts`,
			`DELETE FROM auth_throttle_state`,
		} {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("invalidate authentication state: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE auth_configuration SET mode = ?, setup_completed = 0, updated_at = ? WHERE id = 1`, s.config.Mode, now); err != nil {
			return fmt.Errorf("change authentication mode: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO auth_security_events(event_type, occurred_at, outcome, details) VALUES ('mode_changed', ?, 'success', '')`, now); err != nil {
			return fmt.Errorf("record authentication mode change: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit authentication configuration: %w", err)
	}
	return nil
}

func (s *Service) backupDatabase(ctx context.Context) (string, error) {
	// Startup owns the only database connection. Checkpointing first ensures a
	// file backup also contains changes previously committed to the WAL.
	if _, err := s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return "", fmt.Errorf("checkpoint authentication metadata: %w", err)
	}
	databasePath := s.config.MetadataPath
	if _, err := os.Stat(databasePath); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	backupPath := fmt.Sprintf("%s.backup-%s", databasePath, time.Now().UTC().Format("20060102T150405.000000000Z"))
	input, err := os.Open(databasePath)
	if err != nil {
		return "", err
	}
	defer input.Close()
	output, err := os.OpenFile(backupPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	succeeded := false
	defer func() {
		_ = output.Close()
		if !succeeded {
			_ = os.Remove(backupPath)
		}
	}()
	if _, err := output.ReadFrom(input); err != nil {
		return "", err
	}
	if err := output.Sync(); err != nil {
		return "", err
	}
	if err := output.Close(); err != nil {
		return "", err
	}
	succeeded = true
	return backupPath, nil
}
