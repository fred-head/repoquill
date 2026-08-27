package auth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"time"
)

const loginThrottleWindow = 15 * time.Minute

type LoginThrottle struct {
	service *Service
	now     func() time.Time
	active  chan struct{}
}

func NewLoginThrottle(service *Service) *LoginThrottle {
	return &LoginThrottle{service: service, now: time.Now, active: make(chan struct{}, 1)}
}

func (t *LoginThrottle) Begin() bool {
	select {
	case t.active <- struct{}{}:
		return true
	default:
		return false
	}
}

func (t *LoginThrottle) End() { <-t.active }

func (t *LoginThrottle) Check(ctx context.Context, client netip.Addr) (time.Duration, error) {
	now := t.now().UTC()
	maximum := time.Duration(0)
	for _, key := range throttleKeys(client) {
		var next sql.NullString
		err := t.service.db.QueryRowContext(ctx, `SELECT next_allowed_at FROM auth_throttle_state WHERE scope = ? AND key_hash = ?`, key.scope, key.hash[:]).Scan(&next)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("read login throttle: %w", err)
		}
		if !next.Valid {
			continue
		}
		allowedAt, err := time.Parse(time.RFC3339Nano, next.String)
		if err != nil {
			return 0, errors.New("stored login throttle is invalid")
		}
		if remaining := allowedAt.Sub(now); remaining > maximum {
			maximum = remaining
		}
	}
	return maximum, nil
}

func (t *LoginThrottle) Failure(ctx context.Context, client netip.Addr) (time.Duration, error) {
	now := t.now().UTC()
	tx, err := t.service.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	maximum := time.Duration(0)
	for _, key := range throttleKeys(client) {
		attempts, started, err := loadThrottleState(ctx, tx, key)
		if err != nil {
			return 0, err
		}
		if started.IsZero() || now.Sub(started) >= loginThrottleWindow {
			attempts, started = 0, now
		}
		attempts++
		delay := progressiveDelay(attempts, key.threshold)
		if delay > maximum {
			maximum = delay
		}
		var next any
		if delay > 0 {
			next = now.Add(delay).Format(time.RFC3339Nano)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO auth_throttle_state (scope, key_hash, attempts, window_started_at, next_allowed_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(scope, key_hash) DO UPDATE SET attempts=excluded.attempts, window_started_at=excluded.window_started_at, next_allowed_at=excluded.next_allowed_at`, key.scope, key.hash[:], attempts, started.Format(time.RFC3339Nano), next)
		if err != nil {
			return 0, fmt.Errorf("update login throttle: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return maximum, nil
}

func (t *LoginThrottle) Success(ctx context.Context, client netip.Addr) error {
	for _, key := range throttleKeys(client) {
		if _, err := t.service.db.ExecContext(ctx, `DELETE FROM auth_throttle_state WHERE scope = ? AND key_hash = ?`, key.scope, key.hash[:]); err != nil {
			return err
		}
	}
	return nil
}

type throttleKey struct {
	scope     string
	hash      [32]byte
	threshold int
}

func throttleKeys(client netip.Addr) []throttleKey {
	clientValue := "unknown"
	if client.IsValid() {
		clientValue = client.String()
	}
	clientHash := sha256.Sum256([]byte("login-client\x00" + clientValue))
	globalHash := sha256.Sum256([]byte("login-global"))
	return []throttleKey{{scope: "login_client", hash: clientHash, threshold: 3}, {scope: "login_global", hash: globalHash, threshold: 10}}
}

func loadThrottleState(ctx context.Context, tx *sql.Tx, key throttleKey) (int, time.Time, error) {
	var attempts int
	var startedText string
	err := tx.QueryRowContext(ctx, `SELECT attempts, window_started_at FROM auth_throttle_state WHERE scope = ? AND key_hash = ?`, key.scope, key.hash[:]).Scan(&attempts, &startedText)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, time.Time{}, nil
	}
	if err != nil {
		return 0, time.Time{}, err
	}
	started, err := time.Parse(time.RFC3339Nano, startedText)
	return attempts, started, err
}

func progressiveDelay(attempts, threshold int) time.Duration {
	if attempts <= threshold {
		return 0
	}
	shift := attempts - threshold - 1
	if shift > 5 {
		shift = 5
	}
	delay := time.Second * time.Duration(1<<shift)
	if delay > 30*time.Second {
		return 30 * time.Second
	}
	return delay
}

func ClientReference(client netip.Addr) string {
	value := "unknown"
	if client.IsValid() {
		value = client.String()
	}
	digest := sha256.Sum256([]byte("security-event-client\x00" + value))
	return hex.EncodeToString(digest[:8])
}

func (s *Service) RecordSecurityEvent(ctx context.Context, eventType, outcome, details string) error {
	if len(eventType) > 64 || len(outcome) > 32 || len(details) > 256 {
		return errors.New("security event is too large")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO auth_security_events (event_type, occurred_at, outcome, details) VALUES (?, ?, ?, ?)`, eventType, time.Now().UTC().Format(time.RFC3339Nano), outcome, details)
	if err == nil {
		s.logger.Info("authentication security event", "eventType", eventType, "outcome", outcome, "details", details)
	}
	return err
}
