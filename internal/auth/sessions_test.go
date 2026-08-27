package auth

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteSessionStoreHashesOpaqueTokenAndHonorsRevocation(t *testing.T) {
	service, err := Open(t.Context(), Config{Mode: ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	store := &sqliteSessionStore{db: service.db}
	token := "plaintext-session-token-must-not-be-persisted"
	data := []byte("server-side-session-data")
	if err := store.CommitCtx(t.Context(), token, data, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	var storedHash, storedData []byte
	if err := service.db.QueryRowContext(t.Context(), `SELECT session_id_hash, session_data FROM auth_sessions`).Scan(&storedHash, &storedData); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(storedHash, []byte(token)) || bytes.Equal(storedHash, []byte(token)) {
		t.Fatal("plaintext session token was persisted")
	}
	if !bytes.Equal(storedData, data) {
		t.Fatal("server-side session data was not persisted")
	}
	if found, ok, err := store.FindCtx(t.Context(), token); err != nil || !ok || !bytes.Equal(found, data) {
		t.Fatalf("stored session was not found: ok=%v err=%v", ok, err)
	}
	if err := store.DeleteCtx(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.FindCtx(t.Context(), token); err != nil || ok {
		t.Fatalf("revoked session remained active: ok=%v err=%v", ok, err)
	}
}

func TestSessionCookieSecurityOptions(t *testing.T) {
	service, err := Open(t.Context(), Config{Mode: ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	sessions, err := NewSessions(service, DefaultSessionOptions(true))
	if err != nil {
		t.Fatal(err)
	}
	if !sessions.manager.Cookie.Secure || !sessions.manager.Cookie.HttpOnly || sessions.manager.Cookie.Path != "/api" || sessions.manager.Cookie.Name != "__Secure-repoquill_session" {
		t.Fatalf("unsafe production cookie settings: %#v", sessions.manager.Cookie)
	}
}
