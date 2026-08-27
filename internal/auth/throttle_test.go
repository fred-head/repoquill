package auth

import (
	"io"
	"log/slog"
	"net/netip"
	"path/filepath"
	"testing"
	"time"
)

func TestLoginThrottleUsesProgressiveTemporaryDelays(t *testing.T) {
	service, err := Open(t.Context(), Config{Mode: ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	clock := time.Date(2026, 8, 27, 8, 0, 0, 0, time.UTC)
	throttle := NewLoginThrottle(service)
	throttle.now = func() time.Time { return clock }
	client := netip.MustParseAddr("203.0.113.9")
	for attempt := 1; attempt <= 3; attempt++ {
		if delay, err := throttle.Failure(t.Context(), client); err != nil || delay != 0 {
			t.Fatalf("attempt %d delayed unexpectedly: %v %v", attempt, delay, err)
		}
	}
	if delay, err := throttle.Failure(t.Context(), client); err != nil || delay != time.Second {
		t.Fatalf("fourth attempt delay = %v, err=%v", delay, err)
	}
	if remaining, err := throttle.Check(t.Context(), client); err != nil || remaining != time.Second {
		t.Fatalf("active throttle = %v, err=%v", remaining, err)
	}
	clock = clock.Add(2 * time.Second)
	if remaining, err := throttle.Check(t.Context(), client); err != nil || remaining != 0 {
		t.Fatalf("temporary throttle did not expire: %v, err=%v", remaining, err)
	}
	if err := throttle.Success(t.Context(), client); err != nil {
		t.Fatal(err)
	}
	if remaining, err := throttle.Check(t.Context(), client); err != nil || remaining != 0 {
		t.Fatalf("successful login did not clear throttle: %v, err=%v", remaining, err)
	}
}

func TestLoginThrottleHasBoundedDelay(t *testing.T) {
	if delay := progressiveDelay(100, 3); delay != 30*time.Second {
		t.Fatalf("unbounded delay: %v", delay)
	}
}

func TestLoginThrottleBoundsConcurrentPasswordWork(t *testing.T) {
	throttle := &LoginThrottle{active: make(chan struct{}, 1)}
	if !throttle.Begin() {
		t.Fatal("first login work was rejected")
	}
	if throttle.Begin() {
		t.Fatal("concurrent login work was accepted")
	}
	throttle.End()
	if !throttle.Begin() {
		t.Fatal("login work remained locked")
	}
	throttle.End()
}
