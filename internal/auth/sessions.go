package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/alexedwards/scs/v2"
)

const (
	sessionPrincipalKey = "principal"
	sessionCSRFKey      = "csrf_token"
)

type SessionOptions struct {
	CookieSecure     bool
	IdleTimeout      time.Duration
	Lifetime         time.Duration
	RememberLifetime time.Duration
}

func DefaultSessionOptions(cookieSecure bool) SessionOptions {
	return SessionOptions{CookieSecure: cookieSecure, IdleTimeout: 7 * 24 * time.Hour, Lifetime: 12 * time.Hour, RememberLifetime: 30 * 24 * time.Hour}
}

type Sessions struct {
	manager *scs.SessionManager
	service *Service
	options SessionOptions
}

func NewSessions(service *Service, options SessionOptions) (*Sessions, error) {
	if service == nil || service.db == nil {
		return nil, errors.New("authentication service is required")
	}
	if options.IdleTimeout <= 0 || options.Lifetime <= 0 || options.RememberLifetime < options.Lifetime {
		return nil, errors.New("invalid session durations")
	}
	manager := scs.New()
	manager.Store = &sqliteSessionStore{db: service.db, codec: manager.Codec, defaultIdle: options.IdleTimeout}
	manager.Lifetime = options.RememberLifetime
	manager.IdleTimeout = 30 * 24 * time.Hour
	manager.Cookie.Name = "repoquill_session"
	if options.CookieSecure {
		manager.Cookie.Name = "__Secure-repoquill_session"
	}
	manager.Cookie.Domain = ""
	manager.Cookie.HttpOnly = true
	manager.Cookie.Path = "/api"
	manager.Cookie.Persist = false
	manager.Cookie.SameSite = http.SameSiteStrictMode
	manager.Cookie.Secure = options.CookieSecure
	return &Sessions{manager: manager, service: service, options: options}, nil
}

func (s *Sessions) LoadAndSave(next http.Handler) http.Handler { return s.manager.LoadAndSave(next) }

func (s *Sessions) Authenticated(ctx context.Context) bool {
	return s.manager.GetString(ctx, sessionPrincipalKey) == OwnerPrincipal
}

func (s *Sessions) Login(ctx context.Context, password string, remember bool, client string) error {
	if err := s.service.VerifyPassword(ctx, password); err != nil {
		return err
	}
	return s.establish(ctx, remember, client)
}

func (s *Sessions) EstablishAfterSetup(ctx context.Context, client string) error {
	return s.establish(ctx, false, client)
}

func (s *Sessions) establish(ctx context.Context, remember bool, client string) error {
	if err := s.manager.RenewToken(ctx); err != nil {
		return err
	}
	settings, err := s.service.SessionSettings(ctx)
	if err != nil {
		return err
	}
	lifetime := time.Duration(settings.LifetimeHours) * time.Hour
	if remember {
		lifetime = time.Duration(settings.RememberDays) * 24 * time.Hour
	}
	s.manager.SetDeadline(ctx, time.Now().Add(lifetime))
	s.manager.RememberMe(ctx, remember)
	s.manager.Put(ctx, sessionPrincipalKey, OwnerPrincipal)
	s.manager.Put(ctx, "client", sanitizeClientDescription(client))
	s.manager.Put(ctx, "idle_hours", settings.IdleHours)
	s.manager.Put(ctx, "remember", remember)
	s.manager.Remove(ctx, sessionCSRFKey)
	_, err = s.CSRFToken(ctx)
	return err
}

func (s *Sessions) CurrentHash(ctx context.Context) []byte {
	token := s.manager.Token(ctx)
	if token == "" {
		return nil
	}
	hash := sessionHash(token)
	return append([]byte(nil), hash[:]...)
}

func (s *Sessions) ChangePassword(ctx context.Context, currentPassword, newPassword string) error {
	currentHash := s.CurrentHash(ctx)
	if err := s.service.ChangePassword(ctx, currentPassword, newPassword, currentHash); err != nil {
		return err
	}
	remember := s.manager.GetBool(ctx, "remember")
	client := s.manager.GetString(ctx, "client")
	if err := s.establish(ctx, remember, client); err != nil {
		// The credential was already changed. Do not leave the old session alive
		// if rotating it unexpectedly fails.
		_ = s.manager.Destroy(ctx)
		return err
	}
	return nil
}

func (s *Sessions) CSRFToken(ctx context.Context) (string, error) {
	if existing := s.manager.GetString(ctx, sessionCSRFKey); existing != "" {
		return existing, nil
	}
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(value)
	s.manager.Put(ctx, sessionCSRFKey, token)
	return token, nil
}

func (s *Sessions) ExistingCSRFToken(ctx context.Context) string {
	return s.manager.GetString(ctx, sessionCSRFKey)
}

func (s *Sessions) ValidCSRFToken(ctx context.Context, supplied string) bool {
	expected := s.manager.GetString(ctx, sessionCSRFKey)
	if expected == "" || len(supplied) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) == 1
}

func (s *Sessions) Logout(ctx context.Context) error { return s.manager.Destroy(ctx) }

func (s *Sessions) RevokeCurrent(ctx context.Context) error { return s.manager.Destroy(ctx) }

func (s *Sessions) RevokeAll(ctx context.Context) error {
	if _, err := s.service.db.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL`, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return s.manager.Destroy(ctx)
}

func sanitizeClientDescription(value string) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if len(value) > 200 {
		value = value[:200]
	}
	return value
}

type sqliteSessionStore struct {
	db          *sql.DB
	codec       scs.Codec
	defaultIdle time.Duration
}

func sessionHash(token string) [32]byte { return sha256.Sum256([]byte(token)) }

func (s *sqliteSessionStore) Delete(token string) error {
	return s.DeleteCtx(context.Background(), token)
}
func (s *sqliteSessionStore) Find(token string) ([]byte, bool, error) {
	return s.FindCtx(context.Background(), token)
}
func (s *sqliteSessionStore) Commit(token string, data []byte, expiry time.Time) error {
	return s.CommitCtx(context.Background(), token, data, expiry)
}

func (s *sqliteSessionStore) DeleteCtx(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	hash := sessionHash(token)
	_, err := s.db.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at = ? WHERE session_id_hash = ?`, time.Now().UTC().Format(time.RFC3339Nano), hash[:])
	return err
}

func (s *sqliteSessionStore) FindCtx(ctx context.Context, token string) ([]byte, bool, error) {
	hash := sessionHash(token)
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT session_data FROM auth_sessions WHERE session_id_hash = ? AND revoked_at IS NULL AND idle_expires_at > ?`, hash[:], time.Now().UTC().Format(time.RFC3339Nano)).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	return data, err == nil, err
}

func (s *sqliteSessionStore) CommitCtx(ctx context.Context, token string, data []byte, expiry time.Time) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	expires := expiry.UTC().Format(time.RFC3339Nano)
	absoluteExpiry := expires
	client := ""
	if s.codec != nil {
		deadline, values, err := s.codec.Decode(data)
		if err != nil {
			return err
		}
		absoluteExpiry = deadline.UTC().Format(time.RFC3339Nano)
		if value, ok := values["client"].(string); ok {
			client = sanitizeClientDescription(value)
		}
		idle := s.defaultIdle
		if hours, ok := values["idle_hours"].(int); ok && hours >= 1 && hours <= 720 {
			idle = time.Duration(hours) * time.Hour
		}
		if idleExpiry := time.Now().UTC().Add(idle); idleExpiry.Before(deadline) {
			expires = idleExpiry.Format(time.RFC3339Nano)
		} else {
			expires = deadline.UTC().Format(time.RFC3339Nano)
		}
	}
	hash := sessionHash(token)
	_, err := s.db.ExecContext(ctx, `INSERT INTO auth_sessions (session_id_hash, created_at, last_activity_at, idle_expires_at, absolute_expires_at, client_description, session_data)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id_hash) DO UPDATE SET last_activity_at=excluded.last_activity_at, idle_expires_at=excluded.idle_expires_at, absolute_expires_at=excluded.absolute_expires_at, client_description=excluded.client_description, session_data=excluded.session_data, revoked_at=NULL`, hash[:], now, now, expires, absoluteExpiry, client, data)
	return err
}
