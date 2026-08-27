package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fred-head/repoquill/internal/auth"
	"github.com/pquerna/otp/totp"
)

func TestHealth(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	if got := strings.TrimSpace(recorder.Body.String()); got != `{"status":"ok","version":"dev"}` {
		t.Fatalf("unexpected body: %s", got)
	}
}

func TestSecureOwnerSetupAPI(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authService, err := auth.Open(t.Context(), auth.Config{Mode: auth.ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer authService.Close()
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), authService)
	if err != nil {
		t.Fatal(err)
	}

	status := httptest.NewRecorder()
	handler.ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"setupRequired":true`) || strings.Contains(status.Body.String(), "owner") {
		t.Fatalf("unexpected public auth status: %d %s", status.Code, status.Body.String())
	}
	blocked := httptest.NewRecorder()
	handler.ServeHTTP(blocked, httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil))
	if blocked.Code != http.StatusForbidden || !strings.Contains(blocked.Body.String(), `"code":"setup_required"`) {
		t.Fatalf("notebook API was exposed before owner setup: %d %s", blocked.Code, blocked.Body.String())
	}

	invalidBody := strings.NewReader(`{"bootstrapToken":"wrong","password":"a sufficiently long password"}`)
	invalid := httptest.NewRecorder()
	handler.ServeHTTP(invalid, httptest.NewRequest(http.MethodPost, "/api/auth/setup", invalidBody))
	if invalid.Code != http.StatusUnauthorized || strings.Contains(invalid.Body.String(), "wrong") {
		t.Fatalf("setup leaked or accepted invalid authorization: %d %s", invalid.Code, invalid.Body.String())
	}

	token, err := authService.CreateBootstrapToken(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	requestBody, err := json.Marshal(map[string]string{"bootstrapToken": token.Value, "password": "a sufficiently long password"})
	if err != nil {
		t.Fatal(err)
	}
	setup := httptest.NewRecorder()
	handler.ServeHTTP(setup, httptest.NewRequest(http.MethodPost, "/api/auth/setup", bytes.NewReader(requestBody)))
	if setup.Code != http.StatusOK || !strings.Contains(setup.Body.String(), `"setupCompleted":true`) {
		t.Fatalf("owner setup failed: %d %s", setup.Code, setup.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, cookie := range setup.Result().Cookies() {
		if strings.Contains(cookie.Name, "repoquill_session") {
			sessionCookie = cookie
		}
	}
	if sessionCookie == nil || !sessionCookie.HttpOnly || sessionCookie.Path != "/api" || sessionCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("setup did not issue a confined HttpOnly SameSite session cookie: %#v", sessionCookie)
	}

	after := httptest.NewRecorder()
	handler.ServeHTTP(after, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if after.Code != http.StatusOK || !strings.Contains(after.Body.String(), `"setupRequired":false`) {
		t.Fatalf("setup status did not change: %d %s", after.Code, after.Body.String())
	}
	unlocked := httptest.NewRecorder()
	unlockedRequest := httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil)
	unlockedRequest.AddCookie(sessionCookie)
	handler.ServeHTTP(unlocked, unlockedRequest)
	if unlocked.Code == http.StatusForbidden || unlocked.Code == http.StatusUnauthorized {
		t.Fatalf("setup boundary remained locked after successful setup: %d %s", unlocked.Code, unlocked.Body.String())
	}
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil))
	if unauthenticated.Code != http.StatusUnauthorized || strings.TrimSpace(unauthenticated.Body.String()) != `{"code":"authentication_required","error":"authentication required"}` {
		t.Fatalf("protected API did not return stable JSON 401: %d %s", unauthenticated.Code, unauthenticated.Body.String())
	}

	_, currentCSRF := authRequestContext(t, handler, sessionCookie)
	repeated := httptest.NewRecorder()
	repeatedRequest := httptest.NewRequest(http.MethodPost, "/api/auth/setup", bytes.NewReader(requestBody))
	addAuthRequestContext(repeatedRequest, sessionCookie, currentCSRF)
	handler.ServeHTTP(repeated, repeatedRequest)
	if repeated.Code != http.StatusConflict {
		t.Fatalf("repeated setup was not rejected: %d %s", repeated.Code, repeated.Body.String())
	}

	oversized := httptest.NewRecorder()
	oversizedBody := strings.NewReader(`{"bootstrapToken":"` + strings.Repeat("x", 5000) + `","password":"a sufficiently long password"}`)
	oversizedRequest := httptest.NewRequest(http.MethodPost, "/api/auth/setup", oversizedBody)
	addAuthRequestContext(oversizedRequest, sessionCookie, currentCSRF)
	handler.ServeHTTP(oversized, oversizedRequest)
	if oversized.Code != http.StatusBadRequest {
		t.Fatalf("oversized auth request was accepted: %d", oversized.Code)
	}
}

func TestLoginSessionPersistsAndCanBeRevoked(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	metadataPath := filepath.Join(t.TempDir(), "auth.db")
	config := auth.Config{Mode: auth.ModeLocal, MetadataPath: metadataPath}
	password := "a sufficiently long password"

	service, err := auth.Open(t.Context(), config, logger)
	if err != nil {
		t.Fatal(err)
	}
	token, err := service.CreateBootstrapToken(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := service.CompleteSetup(t.Context(), token.Value, password); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), service)
	if err != nil {
		t.Fatal(err)
	}

	wrong := httptest.NewRecorder()
	wrongRequest := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"wrong password","rememberDevice":false}`))
	handler.ServeHTTP(wrong, wrongRequest)
	if wrong.Code != http.StatusUnauthorized || strings.Contains(wrong.Body.String(), "wrong password") {
		t.Fatalf("invalid login response: %d %s", wrong.Code, wrong.Body.String())
	}

	login := httptest.NewRecorder()
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"a sufficiently long password","rememberDevice":true}`))
	handler.ServeHTTP(login, loginRequest)
	if login.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", login.Code, login.Body.String())
	}
	var cookie *http.Cookie
	for _, candidate := range login.Result().Cookies() {
		if strings.Contains(candidate.Name, "repoquill_session") {
			cookie = candidate
		}
	}
	if cookie == nil || cookie.MaxAge <= 0 {
		t.Fatalf("remembered login did not issue a persistent cookie: %#v", cookie)
	}
	_, firstCSRF := authRequestContext(t, handler, cookie)
	reauthRequest := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"a sufficiently long password","rememberDevice":true}`))
	addAuthRequestContext(reauthRequest, cookie, firstCSRF)
	reauth := httptest.NewRecorder()
	handler.ServeHTTP(reauth, reauthRequest)
	if reauth.Code != http.StatusOK {
		t.Fatalf("authenticated re-login failed: %d %s", reauth.Code, reauth.Body.String())
	}
	newCookie, newCSRF := authRequestContextFromResponse(t, reauth)
	if newCookie == nil || newCookie.Value == cookie.Value || newCSRF == firstCSRF {
		t.Fatal("authentication-level change did not rotate session and CSRF tokens")
	}
	cookie = newCookie
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}

	service, err = auth.Open(t.Context(), config, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	handler, err = NewHandlerWithAuth(logger, t.TempDir(), service)
	if err != nil {
		t.Fatal(err)
	}
	protectedRequest := httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil)
	protectedRequest.AddCookie(cookie)
	protected := httptest.NewRecorder()
	handler.ServeHTTP(protected, protectedRequest)
	if protected.Code == http.StatusUnauthorized {
		t.Fatalf("session did not survive service restart: %s", protected.Body.String())
	}
	missingCSRFRequest := httptest.NewRequest(http.MethodDelete, "/api/auth/sessions", nil)
	missingCSRFRequest.AddCookie(cookie)
	missingCSRF := httptest.NewRecorder()
	handler.ServeHTTP(missingCSRF, missingCSRFRequest)
	if missingCSRF.Code != http.StatusForbidden || !strings.Contains(missingCSRF.Body.String(), `"code":"csrf_invalid"`) {
		t.Fatalf("state-changing authenticated request bypassed CSRF protection: %d %s", missingCSRF.Code, missingCSRF.Body.String())
	}

	_, authenticatedCSRF := authRequestContext(t, handler, cookie)
	revokeRequest := httptest.NewRequest(http.MethodDelete, "/api/auth/sessions", nil)
	revokeRequest.AddCookie(cookie)
	revokeRequest.Header.Set("X-CSRF-Token", authenticatedCSRF)
	revoked := httptest.NewRecorder()
	handler.ServeHTTP(revoked, revokeRequest)
	if revoked.Code != http.StatusOK {
		t.Fatalf("session revocation failed: %d %s", revoked.Code, revoked.Body.String())
	}
	requestAfterRevoke := httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil)
	requestAfterRevoke.AddCookie(cookie)
	afterRevoke := httptest.NewRecorder()
	handler.ServeHTTP(afterRevoke, requestAfterRevoke)
	if afterRevoke.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session remained authorized: %d", afterRevoke.Code)
	}
}

func TestSecurityAdministrationAPI(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := auth.Open(t.Context(), auth.Config{Mode: auth.ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	bootstrap, err := service.CreateBootstrapToken(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	const oldPassword = "a sufficiently long password"
	const newPassword = "a different secure password"
	if err := service.CompleteSetup(t.Context(), bootstrap.Value, oldPassword); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), service)
	if err != nil {
		t.Fatal(err)
	}

	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"a sufficiently long password"}`)))
	if login.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", login.Code, login.Body.String())
	}
	cookie, csrf := authRequestContextFromResponse(t, login)

	securityRequest := httptest.NewRequest(http.MethodGet, "/api/auth/security", nil)
	securityRequest.AddCookie(cookie)
	security := httptest.NewRecorder()
	handler.ServeHTTP(security, securityRequest)
	if security.Code != http.StatusOK || !strings.Contains(security.Body.String(), `"idleHours":168`) {
		t.Fatalf("security settings unavailable: %d %s", security.Code, security.Body.String())
	}

	settingsRequest := httptest.NewRequest(http.MethodPut, "/api/auth/security/session-settings", strings.NewReader(`{"currentPassword":"a sufficiently long password","idleHours":48,"lifetimeHours":8,"rememberDays":14}`))
	addAuthRequestContext(settingsRequest, cookie, csrf)
	settings := httptest.NewRecorder()
	handler.ServeHTTP(settings, settingsRequest)
	if settings.Code != http.StatusOK || !strings.Contains(settings.Body.String(), `"idleHours":48`) {
		t.Fatalf("session settings update failed: %d %s", settings.Code, settings.Body.String())
	}

	passwordBody, _ := json.Marshal(map[string]string{"currentPassword": oldPassword, "newPassword": newPassword})
	passwordRequest := httptest.NewRequest(http.MethodPut, "/api/auth/password", bytes.NewReader(passwordBody))
	addAuthRequestContext(passwordRequest, cookie, csrf)
	password := httptest.NewRecorder()
	handler.ServeHTTP(password, passwordRequest)
	if password.Code != http.StatusOK {
		t.Fatalf("password change failed: %d %s", password.Code, password.Body.String())
	}
	rotatedCookie, rotatedCSRF := authRequestContextFromResponse(t, password)
	if rotatedCookie == nil || rotatedCookie.Value == cookie.Value || rotatedCSRF == csrf {
		t.Fatal("password change did not rotate session credentials")
	}
	if err := service.VerifyPassword(t.Context(), oldPassword); !errors.Is(err, auth.ErrAuthentication) {
		t.Fatalf("old password still verifies: %v", err)
	}
	if err := service.VerifyPassword(t.Context(), newPassword); err != nil {
		t.Fatalf("new password does not verify: %v", err)
	}

	sessionsRequest := httptest.NewRequest(http.MethodGet, "/api/auth/sessions", nil)
	sessionsRequest.AddCookie(rotatedCookie)
	sessionList := httptest.NewRecorder()
	handler.ServeHTTP(sessionList, sessionsRequest)
	if sessionList.Code != http.StatusOK || !strings.Contains(sessionList.Body.String(), `"current":true`) {
		t.Fatalf("session list unavailable after rotation: %d %s", sessionList.Code, sessionList.Body.String())
	}
}

func TestPasswordFirstMFALoginAndRecoveryCode(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := auth.Open(t.Context(), auth.Config{Mode: auth.ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	bootstrap, _ := service.CreateBootstrapToken(t.Context())
	const password = "a sufficiently long password"
	if err := service.CompleteSetup(t.Context(), bootstrap.Value, password); err != nil {
		t.Fatal(err)
	}
	enrollment, err := service.BeginMFAEnrollment(t.Context(), password, "")
	if err != nil {
		t.Fatal(err)
	}
	code, _ := totp.GenerateCode(enrollment.Secret, time.Now().UTC())
	if err := service.ConfirmMFAEnrollment(t.Context(), code, true); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), service)
	if err != nil {
		t.Fatal(err)
	}

	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"a sufficiently long password","rememberDevice":true}`)))
	if login.Code != http.StatusAccepted || !strings.Contains(login.Body.String(), `"mfaRequired":true`) {
		t.Fatalf("password step did not require MFA: %d %s", login.Code, login.Body.String())
	}
	var pendingCookie *http.Cookie
	for _, candidate := range login.Result().Cookies() {
		if strings.Contains(candidate.Name, "repoquill_session") {
			pendingCookie = candidate
		}
	}
	if pendingCookie == nil {
		t.Fatal("MFA challenge did not issue a confined pending-session cookie")
	}

	wrongRequest := httptest.NewRequest(http.MethodPost, "/api/auth/login/mfa", strings.NewReader(`{"code":"000000"}`))
	wrongRequest.AddCookie(pendingCookie)
	wrong := httptest.NewRecorder()
	handler.ServeHTTP(wrong, wrongRequest)
	if wrong.Code != http.StatusUnauthorized || strings.TrimSpace(wrong.Body.String()) != `{"code":"invalid_credentials","error":"authentication failed"}` {
		t.Fatalf("MFA failure leaked details: %d %s", wrong.Code, wrong.Body.String())
	}

	recoveryRequest := httptest.NewRequest(http.MethodPost, "/api/auth/login/mfa", strings.NewReader(`{"code":"`+enrollment.RecoveryCodes[0]+`"}`))
	recoveryRequest.AddCookie(pendingCookie)
	recovery := httptest.NewRecorder()
	handler.ServeHTTP(recovery, recoveryRequest)
	if recovery.Code != http.StatusOK || !strings.Contains(recovery.Body.String(), `"authenticated":true`) {
		t.Fatalf("recovery-code login failed: %d %s", recovery.Code, recovery.Body.String())
	}
	rotatedCookie, csrf := authRequestContextFromResponse(t, recovery)
	if rotatedCookie == nil || rotatedCookie.Value == pendingCookie.Value || csrf == "" {
		t.Fatal("MFA completion did not rotate session and CSRF credentials")
	}
}

func TestAuthStatusGETDoesNotCreateSessionState(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := auth.Open(t.Context(), auth.Config{Mode: auth.ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), service)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("auth status failed: %d", response.Code)
	}
	if len(response.Result().Cookies()) != 0 {
		t.Fatalf("safe auth status GET created session cookie: %#v", response.Result().Cookies())
	}
	if strings.Contains(response.Body.String(), `"csrfToken":"`) && !strings.Contains(response.Body.String(), `"csrfToken":""`) {
		t.Fatalf("safe auth status GET created CSRF state: %s", response.Body.String())
	}
}

func TestLoginThrottleReturnsStableTemporaryLimit(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := auth.Open(t.Context(), auth.Config{Mode: auth.ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	bootstrap, err := service.CreateBootstrapToken(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := service.CompleteSetup(t.Context(), bootstrap.Value, "a sufficiently long password"); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), service)
	if err != nil {
		t.Fatal(err)
	}
	var cookie *http.Cookie
	for attempt := 1; attempt <= 4; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"incorrect password","rememberDevice":false}`))
		request.RemoteAddr = "198.51.100.40:1234"
		if cookie != nil {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d returned %d: %s", attempt, response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"a sufficiently long password","rememberDevice":false}`))
	request.RemoteAddr = "198.51.100.40:1234"
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") == "" || !strings.Contains(response.Body.String(), `"code":"login_throttled"`) {
		t.Fatalf("progressive throttle did not block immediate retry: %d %s", response.Code, response.Body.String())
	}
}

func authRequestContext(t *testing.T, handler http.Handler, cookie *http.Cookie) (*http.Cookie, string) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("auth status failed: %d %s", response.Code, response.Body.String())
	}
	resultCookie, token := authRequestContextFromResponse(t, response)
	if resultCookie == nil {
		resultCookie = cookie
	}
	return resultCookie, token
}

func authRequestContextFromResponse(t *testing.T, response *httptest.ResponseRecorder) (*http.Cookie, string) {
	t.Helper()
	var payload struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.CSRFToken == "" {
		t.Fatal("auth status did not provide a CSRF token")
	}
	var cookie *http.Cookie
	for _, candidate := range response.Result().Cookies() {
		if strings.Contains(candidate.Name, "repoquill_session") {
			cookie = candidate
		}
	}
	return cookie, payload.CSRFToken
}

func addAuthRequestContext(request *http.Request, cookie *http.Cookie, token string) {
	if cookie != nil {
		request.AddCookie(cookie)
	}
	request.Header.Set("X-CSRF-Token", token)
}

func TestExplicitDisabledModeDoesNotEnterSetupGate(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authService, err := auth.Open(t.Context(), auth.Config{
		Mode: auth.ModeDisabled, ModeExplicit: true, MetadataPath: filepath.Join(t.TempDir(), "auth.db"),
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer authService.Close()
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), authService)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil))
	if response.Code == http.StatusForbidden || strings.Contains(response.Body.String(), "setup_required") {
		t.Fatalf("explicit disabled mode entered the local setup gate: %d %s", response.Code, response.Body.String())
	}
}

func TestSecurityHeadersAndSameOriginProtection(t *testing.T) {
	root := t.TempDir()
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), root)
	if err != nil {
		t.Fatal(err)
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	for _, header := range []string{"Content-Security-Policy", "Referrer-Policy", "Permissions-Policy", "X-Content-Type-Options", "X-Frame-Options"} {
		if health.Header().Get(header) == "" {
			t.Errorf("security header %s is missing", header)
		}
	}
	if health.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("API cache policy is unsafe: %q", health.Header().Get("Cache-Control"))
	}

	crossSite := httptest.NewRequest(http.MethodPost, "/api/repository/git/sync", nil)
	crossSite.Header.Set("Origin", "https://attacker.example")
	crossSite.Header.Set("Sec-Fetch-Site", "cross-site")
	blocked := httptest.NewRecorder()
	handler.ServeHTTP(blocked, crossSite)
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("cross-site mutation was not rejected: %d", blocked.Code)
	}

	sameSite := httptest.NewRequest(http.MethodPost, "/api/repository/git/sync", nil)
	sameSite.Host = "notes.example.test"
	sameSite.Header.Set("Origin", "http://notes.example.test")
	allowed := httptest.NewRecorder()
	handler.ServeHTTP(allowed, sameSite)
	if allowed.Code == http.StatusForbidden {
		t.Fatal("same-origin mutation was rejected")
	}
}

func TestSameOriginProtectionTrustsForwardedSchemeOnlyFromConfiguredProxy(t *testing.T) {
	identity := auth.NewRequestIdentity([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler := sameOriginProtection(identity, next)

	trusted := httptest.NewRequest(http.MethodPost, "http://notes.example.test/api/action", nil)
	trusted.Host = "notes.example.test"
	trusted.RemoteAddr = "10.0.0.2:8080"
	trusted.Header.Set("Origin", "https://notes.example.test")
	trusted.Header.Set("X-Forwarded-Proto", "https")
	trustedResponse := httptest.NewRecorder()
	handler.ServeHTTP(trustedResponse, trusted)
	if trustedResponse.Code != http.StatusNoContent {
		t.Fatalf("trusted proxy scheme was rejected: %d", trustedResponse.Code)
	}

	untrusted := trusted.Clone(t.Context())
	untrusted.RemoteAddr = "198.51.100.2:8080"
	untrustedResponse := httptest.NewRecorder()
	handler.ServeHTTP(untrustedResponse, untrusted)
	if untrustedResponse.Code != http.StatusForbidden {
		t.Fatalf("untrusted forwarded scheme was accepted: %d", untrustedResponse.Code)
	}

	missingOrigin := httptest.NewRequest(http.MethodPost, "http://notes.example.test/api/action", nil)
	missingOrigin.Header.Set("Sec-Fetch-Site", "same-origin")
	missingOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingOriginResponse, missingOrigin)
	if missingOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("browser mutation without origin was accepted: %d", missingOriginResponse.Code)
	}
}

func TestUnknownAPIAndTrailingJSONDoNotFallThrough(t *testing.T) {
	root := t.TempDir()
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), root)
	if err != nil {
		t.Fatal(err)
	}
	unknown := httptest.NewRecorder()
	handler.ServeHTTP(unknown, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))
	if unknown.Code != http.StatusNotFound || !strings.Contains(unknown.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("unknown API fell through to the SPA: %d %q", unknown.Code, unknown.Header().Get("Content-Type"))
	}

	trailing := httptest.NewRecorder()
	body := strings.NewReader(`{"path":"Note.md","type":"file"}{"extra":true}`)
	handler.ServeHTTP(trailing, httptest.NewRequest(http.MethodPost, "/api/repository/entries", body))
	if trailing.Code != http.StatusBadRequest {
		t.Fatalf("request with trailing JSON was accepted: %d", trailing.Code)
	}
}

func TestRepositoryAPI(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Welcome.md"), []byte("# Welcome"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), root)
	if err != nil {
		t.Fatal(err)
	}

	treeRecorder := httptest.NewRecorder()
	handler.ServeHTTP(treeRecorder, httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil))
	if treeRecorder.Code != http.StatusOK || !strings.Contains(treeRecorder.Body.String(), "Welcome.md") {
		t.Fatalf("unexpected tree response: %d %s", treeRecorder.Code, treeRecorder.Body.String())
	}

	searchRecorder := httptest.NewRecorder()
	handler.ServeHTTP(searchRecorder, httptest.NewRequest(http.MethodGet, "/api/repository/search?q=welcome", nil))
	if searchRecorder.Code != http.StatusOK || !strings.Contains(searchRecorder.Body.String(), `"type":"file"`) || !strings.Contains(searchRecorder.Body.String(), `"type":"content"`) {
		t.Fatalf("unexpected search response: %d %s", searchRecorder.Code, searchRecorder.Body.String())
	}

	fileRecorder := httptest.NewRecorder()
	handler.ServeHTTP(fileRecorder, httptest.NewRequest(http.MethodGet, "/api/repository/file?path=Welcome.md", nil))
	if fileRecorder.Code != http.StatusOK {
		t.Fatalf("unexpected file status: %d", fileRecorder.Code)
	}
	var file struct {
		Content string `json:"content"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(fileRecorder.Body).Decode(&file); err != nil {
		t.Fatal(err)
	}
	if file.Content != "# Welcome" {
		t.Fatalf("unexpected file content: %q", file.Content)
	}

	requestBody, err := json.Marshal(map[string]string{"content": "# Updated", "version": file.Version})
	if err != nil {
		t.Fatal(err)
	}
	writeRecorder := httptest.NewRecorder()
	handler.ServeHTTP(writeRecorder, httptest.NewRequest(http.MethodPut, "/api/repository/file?path=Welcome.md", bytes.NewReader(requestBody)))
	if writeRecorder.Code != http.StatusOK {
		t.Fatalf("unexpected write response: %d %s", writeRecorder.Code, writeRecorder.Body.String())
	}
	written, err := os.ReadFile(filepath.Join(root, "Welcome.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != "# Updated" {
		t.Fatalf("unexpected saved content: %q", written)
	}

	conflictRecorder := httptest.NewRecorder()
	handler.ServeHTTP(conflictRecorder, httptest.NewRequest(http.MethodPut, "/api/repository/file?path=Welcome.md", bytes.NewReader(requestBody)))
	if conflictRecorder.Code != http.StatusConflict {
		t.Fatalf("expected stale write conflict, got %d %s", conflictRecorder.Code, conflictRecorder.Body.String())
	}
}

func TestRepositoryAPIRequiresConfiguration(t *testing.T) {
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status 503, got %d", recorder.Code)
	}
}

func TestFreshInstallationDoesNotRegisterDefaultNotebook(t *testing.T) {
	metadataPath := filepath.Join(t.TempDir(), "app", "notebooks.json")
	t.Setenv("REPOQUILL_NOTEBOOK_METADATA", metadataPath)
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}

	notebook := httptest.NewRecorder()
	handler.ServeHTTP(notebook, httptest.NewRequest(http.MethodGet, "/api/notebook", nil))
	if notebook.Code != http.StatusOK || !strings.Contains(notebook.Body.String(), `"configured":false`) {
		t.Fatalf("unexpected notebook state: %d %s", notebook.Code, notebook.Body.String())
	}

	registry := httptest.NewRecorder()
	handler.ServeHTTP(registry, httptest.NewRequest(http.MethodGet, "/api/notebooks", nil))
	if registry.Code != http.StatusOK || !strings.Contains(registry.Body.String(), `"notebooks":[]`) {
		t.Fatalf("unexpected registry state: %d %s", registry.Code, registry.Body.String())
	}
	if _, err := os.Stat(metadataPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("fresh installation unexpectedly created notebook metadata: %v", err)
	}
}

func TestInactiveLegacyNotebookCanBeUnregisteredWithoutDeletingFiles(t *testing.T) {
	dataRoot := t.TempDir()
	localRoot := filepath.Join(dataRoot, "repos")
	activeRoot := filepath.Join(dataRoot, "notebooks", "active")
	if err := os.MkdirAll(localRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(activeRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(localRoot, "Keep.md")
	if err := os.WriteFile(marker, []byte("# Keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	metadataPath := filepath.Join(dataRoot, "app", "notebooks.json")
	if err := writeNotebookRegistry(metadataPath, notebookRegistry{
		ActiveID: "active",
		Entries: []notebookRecord{
			{ID: "local", Name: "repos", LocalPath: localRoot},
			{ID: "active", Name: "Notes", LocalPath: activeRoot, RemoteURL: "git@example.test:notes.git"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REPOQUILL_NOTEBOOK_METADATA", metadataPath)
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}

	activeRemoval := httptest.NewRecorder()
	handler.ServeHTTP(activeRemoval, httptest.NewRequest(http.MethodDelete, "/api/notebooks/active", nil))
	if activeRemoval.Code != http.StatusConflict {
		t.Fatalf("active notebook removal was not blocked: %d %s", activeRemoval.Code, activeRemoval.Body.String())
	}

	removal := httptest.NewRecorder()
	handler.ServeHTTP(removal, httptest.NewRequest(http.MethodDelete, "/api/notebooks/local", nil))
	if removal.Code != http.StatusNoContent {
		t.Fatalf("legacy notebook removal failed: %d %s", removal.Code, removal.Body.String())
	}
	if content, err := os.ReadFile(marker); err != nil || string(content) != "# Keep" {
		t.Fatalf("legacy notebook files were changed: %q %v", content, err)
	}
	registry, err := loadNotebookRegistry(metadataPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Entries) != 1 || registry.Entries[0].ID != "active" {
		t.Fatalf("unexpected registry after removal: %#v", registry)
	}
}

func TestRepositoryMutationAPI(t *testing.T) {
	root := t.TempDir()
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), root)
	if err != nil {
		t.Fatal(err)
	}

	requestJSON := func(method, target string, body map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(method, target, bytes.NewReader(encoded)))
		return recorder
	}

	createdFolder := requestJSON(http.MethodPost, "/api/repository/entries", map[string]string{"path": "Folder", "type": "directory"})
	if createdFolder.Code != http.StatusCreated {
		t.Fatalf("create folder failed: %d %s", createdFolder.Code, createdFolder.Body.String())
	}
	createdNote := requestJSON(http.MethodPost, "/api/repository/entries", map[string]string{"path": "Folder/Note.md", "type": "file"})
	if createdNote.Code != http.StatusCreated {
		t.Fatalf("create note failed: %d %s", createdNote.Code, createdNote.Body.String())
	}
	moved := requestJSON(http.MethodPost, "/api/repository/move", map[string]string{"source": "Folder/Note.md", "target": "Moved.md"})
	if moved.Code != http.StatusOK {
		t.Fatalf("move note failed: %d %s", moved.Code, moved.Body.String())
	}

	deleted := httptest.NewRecorder()
	handler.ServeHTTP(deleted, httptest.NewRequest(http.MethodDelete, "/api/repository/entry?path=Moved.md", nil))
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete note failed: %d %s", deleted.Code, deleted.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "Moved.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted note still exists: %v", err)
	}
}

func TestRepositoryAssetAPI(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Note.md"), []byte("# Note"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), root)
	if err != nil {
		t.Fatal(err)
	}

	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "screenshot.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(png); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	uploadRequest := httptest.NewRequest(http.MethodPost, "/api/repository/assets?note=Note.md", &body)
	uploadRequest.Header.Set("Content-Type", writer.FormDataContentType())
	uploadRecorder := httptest.NewRecorder()
	handler.ServeHTTP(uploadRecorder, uploadRequest)
	if uploadRecorder.Code != http.StatusCreated {
		t.Fatalf("unexpected upload response: %d %s", uploadRecorder.Code, uploadRecorder.Body.String())
	}
	var uploaded struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(uploadRecorder.Body).Decode(&uploaded); err != nil {
		t.Fatal(err)
	}

	assetRecorder := httptest.NewRecorder()
	assetURL := "/api/repository/asset?note=Note.md&path=" + url.QueryEscape(uploaded.Path)
	handler.ServeHTTP(assetRecorder, httptest.NewRequest(http.MethodGet, assetURL, nil))
	if assetRecorder.Code != http.StatusOK || assetRecorder.Header().Get("Content-Type") != "image/png" || !bytes.Equal(assetRecorder.Body.Bytes(), png) {
		t.Fatalf("unexpected asset response: %d %s", assetRecorder.Code, assetRecorder.Body.String())
	}
}

func TestRepositoryAssetCleanupAPI(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Note.md"), []byte("# Note"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "Note.assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Note.assets", "unused.png"), []byte("image"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), root)
	if err != nil {
		t.Fatal(err)
	}

	scan := httptest.NewRecorder()
	handler.ServeHTTP(scan, httptest.NewRequest(http.MethodGet, "/api/repository/assets/unreferenced", nil))
	if scan.Code != http.StatusOK || !strings.Contains(scan.Body.String(), "Note.assets/unused.png") {
		t.Fatalf("unexpected cleanup scan: %d %s", scan.Code, scan.Body.String())
	}

	body := bytes.NewBufferString(`{"paths":["Note.assets/unused.png"]}`)
	cleanup := httptest.NewRecorder()
	handler.ServeHTTP(cleanup, httptest.NewRequest(http.MethodPost, "/api/repository/assets/cleanup", body))
	if cleanup.Code != http.StatusOK || !strings.Contains(cleanup.Body.String(), "Note.assets/unused.png") {
		t.Fatalf("unexpected cleanup response: %d %s", cleanup.Code, cleanup.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "Note.assets", "unused.png")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cleanup did not delete asset: %v", err)
	}
}

func TestCloneAndActivateNotebookAPI(t *testing.T) {
	t.Setenv("REPOQUILL_ALLOW_LOCAL_REMOTES", "true")
	base := t.TempDir()
	remote := filepath.Join(base, "remote.git")
	seed := filepath.Join(base, "seed")
	runGitTest(t, "init", "--bare", "--initial-branch=main", remote)
	runGitTest(t, "init", "--initial-branch=main", seed)
	runGitTest(t, "-C", seed, "config", "user.name", "Test")
	runGitTest(t, "-C", seed, "config", "user.email", "test@example.test")
	if err := os.WriteFile(filepath.Join(seed, "Cloned.md"), []byte("# Cloned"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, "-C", seed, "add", "--all")
	runGitTest(t, "-C", seed, "commit", "-m", "Initial")
	runGitTest(t, "-C", seed, "remote", "add", "origin", remote)
	runGitTest(t, "-C", seed, "push", "origin", "main")

	t.Setenv("REPOQUILL_NOTEBOOKS_DIR", filepath.Join(base, "notebooks"))
	metadata := filepath.Join(base, "app", "notebooks.json")
	t.Setenv("REPOQUILL_NOTEBOOK_METADATA", metadata)
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.NewBufferString(`{"name":"Private","repositoryUrl":"` + remote + `","branch":"main"}`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notebooks", body))
	if response.Code != http.StatusCreated {
		t.Fatalf("clone failed: %d %s", response.Code, response.Body.String())
	}
	tree := httptest.NewRecorder()
	handler.ServeHTTP(tree, httptest.NewRequest(http.MethodGet, "/api/repository/tree", nil))
	if tree.Code != http.StatusOK || !strings.Contains(tree.Body.String(), "Cloned.md") {
		t.Fatalf("cloned notebook not active: %d %s", tree.Code, tree.Body.String())
	}
	if _, err := os.Stat(metadata); err != nil {
		t.Fatalf("notebook metadata was not persisted: %v", err)
	}
}

func TestManagedSSHKeyAPINeverReturnsPrivateMaterial(t *testing.T) {
	base := t.TempDir()
	t.Setenv("REPOQUILL_KEYS_DIR", filepath.Join(base, "keys"))
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notebooks/ssh-key", nil))
	if response.Code != http.StatusCreated {
		t.Fatalf("key generation failed: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "PRIVATE KEY") || strings.Contains(strings.ToLower(response.Body.String()), "privatekey") {
		t.Fatalf("API exposed private material: %s", response.Body.String())
	}
	var key struct {
		KeyID     string `json:"keyId"`
		PublicKey string `json:"publicKey"`
	}
	if err := json.NewDecoder(response.Body).Decode(&key); err != nil {
		t.Fatal(err)
	}
	private, err := os.Stat(filepath.Join(base, "keys", key.KeyID, "id_ed25519"))
	if err != nil || private.Mode().Perm() != 0o600 || !strings.HasPrefix(key.PublicKey, "ssh-ed25519 ") {
		t.Fatalf("unexpected persisted key: %v, %v", private, err)
	}
}

func TestActiveNotebookNameAPIUsesConfiguredName(t *testing.T) {
	t.Setenv("REPOQUILL_NOTEBOOK_NAME", "Personal Notes")
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/notebook", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"name":"Personal Notes"`) {
		t.Fatalf("unexpected notebook info: %d %s", response.Code, response.Body.String())
	}
}

func TestBackgroundGitSyncIsAcceptedWithoutBrowserRequestLifetime(t *testing.T) {
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/repository/git/sync-background", nil))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"status":"accepted"`) {
		t.Fatalf("unexpected background sync response: %d %s", response.Code, response.Body.String())
	}
}

func TestNotebookRegistryPreservesEntriesAndChangesActiveNotebook(t *testing.T) {
	base := t.TempDir()
	metadata := filepath.Join(base, "notebooks.json")
	firstPath := filepath.Join(base, "first")
	secondPath := filepath.Join(base, "second")
	if err := os.MkdirAll(firstPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(secondPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := registerActiveNotebook(metadata, notebookRecord{ID: "first", Name: "Private", LocalPath: firstPath}); err != nil {
		t.Fatal(err)
	}
	if err := registerActiveNotebook(metadata, notebookRecord{ID: "second", Name: "Work", LocalPath: secondPath, RemoteURL: "git@example.test:work.git", Branch: "main"}); err != nil {
		t.Fatal(err)
	}
	registry, err := loadNotebookRegistry(metadata)
	if err != nil || len(registry.Entries) != 2 || registry.ActiveID != "second" {
		t.Fatalf("registry did not preserve notebooks: %#v, %v", registry, err)
	}
	t.Setenv("REPOQUILL_NOTEBOOK_METADATA", metadata)
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notebooks/first/activate", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("activate notebook: %d %s", response.Code, response.Body.String())
	}
	registry, _ = loadNotebookRegistry(metadata)
	if registry.ActiveID != "first" {
		t.Fatalf("active notebook = %q", registry.ActiveID)
	}
	list := httptest.NewRecorder()
	handler.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/notebooks", nil))
	if !strings.Contains(list.Body.String(), `"name":"Private"`) || !strings.Contains(list.Body.String(), `"name":"Work"`) || strings.Contains(list.Body.String(), firstPath) {
		t.Fatalf("unsafe/incomplete notebook list: %s", list.Body.String())
	}
}

func TestManagedSSHKeyManagementProtectsAssignedKeys(t *testing.T) {
	base := t.TempDir()
	keysDirectory := filepath.Join(base, "keys")
	metadata := filepath.Join(base, "app", "notebooks.json")
	t.Setenv("REPOQUILL_KEYS_DIR", keysDirectory)
	t.Setenv("REPOQUILL_NOTEBOOK_METADATA", metadata)
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	generate := func() string {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/notebooks/ssh-key", nil))
		var key struct {
			KeyID string `json:"keyId"`
		}
		if response.Code != http.StatusCreated || json.NewDecoder(response.Body).Decode(&key) != nil {
			t.Fatalf("generate managed key: %d %s", response.Code, response.Body.String())
		}
		return key.KeyID
	}
	assignedID := generate()
	unusedID := generate()
	if err := registerActiveNotebook(metadata, notebookRecord{ID: "notebook", Name: "Private", LocalPath: base, AuthType: "managed-ssh", KeyID: assignedID}); err != nil {
		t.Fatal(err)
	}

	list := httptest.NewRecorder()
	handler.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/notebooks/ssh-keys", nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"notebookName":"Private"`) || strings.Contains(list.Body.String(), "PRIVATE KEY") {
		t.Fatalf("unexpected key list: %d %s", list.Code, list.Body.String())
	}
	assignedDelete := httptest.NewRecorder()
	handler.ServeHTTP(assignedDelete, httptest.NewRequest(http.MethodDelete, "/api/notebooks/ssh-keys/"+assignedID, nil))
	if assignedDelete.Code != http.StatusConflict {
		t.Fatalf("assigned key deletion status = %d: %s", assignedDelete.Code, assignedDelete.Body.String())
	}
	unusedDelete := httptest.NewRecorder()
	handler.ServeHTTP(unusedDelete, httptest.NewRequest(http.MethodDelete, "/api/notebooks/ssh-keys/"+unusedID, nil))
	if unusedDelete.Code != http.StatusOK {
		t.Fatalf("unused key deletion status = %d: %s", unusedDelete.Code, unusedDelete.Body.String())
	}
	if _, err := os.Stat(filepath.Join(keysDirectory, unusedID)); !os.IsNotExist(err) {
		t.Fatal("unused managed key was not deleted")
	}
	if _, err := os.Stat(filepath.Join(keysDirectory, assignedID, "id_ed25519")); err != nil {
		t.Fatal("assigned private key was deleted")
	}
}

func runGitTest(t *testing.T, arguments ...string) {
	t.Helper()
	command := exec.Command("git", arguments...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", arguments, err, output)
	}
}

func TestFrontendFallback(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/notes/welcome", nil)
	handler, err := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "RepoQuill") {
		t.Fatal("expected embedded frontend")
	}
}

func TestEveryApplicationAPIRouteDeniesUnauthenticatedAccess(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := auth.Open(t.Context(), auth.Config{Mode: auth.ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "auth.db")}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	token, err := service.CreateBootstrapToken(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := service.CompleteSetup(t.Context(), token.Value, "a sufficiently long password"); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandlerWithAuth(logger, t.TempDir(), service)
	if err != nil {
		t.Fatal(err)
	}

	protected := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/auth/logout"},
		{http.MethodDelete, "/api/auth/session"},
		{http.MethodDelete, "/api/auth/sessions"},
		{http.MethodGet, "/api/auth/sessions"},
		{http.MethodDelete, "/api/auth/sessions/others"},
		{http.MethodDelete, "/api/auth/sessions/example"},
		{http.MethodGet, "/api/auth/security"},
		{http.MethodPut, "/api/auth/security/session-settings"},
		{http.MethodPut, "/api/auth/password"},
		{http.MethodPost, "/api/auth/mfa/enroll"},
		{http.MethodPost, "/api/auth/mfa/confirm"},
		{http.MethodDelete, "/api/auth/mfa"},
		{http.MethodPost, "/api/auth/mfa/recovery-codes"},
		{http.MethodGet, "/api/notebook"},
		{http.MethodGet, "/api/notebooks"},
		{http.MethodPost, "/api/notebooks/example/activate"},
		{http.MethodDelete, "/api/notebooks/example"},
		{http.MethodGet, "/api/repository/tree"},
		{http.MethodGet, "/api/repository/search?q=secret"},
		{http.MethodGet, "/api/repository/file?path=Secret.md"},
		{http.MethodPut, "/api/repository/file"},
		{http.MethodPost, "/api/repository/entries"},
		{http.MethodPost, "/api/repository/move"},
		{http.MethodDelete, "/api/repository/entry"},
		{http.MethodPost, "/api/repository/assets"},
		{http.MethodGet, "/api/repository/asset"},
		{http.MethodGet, "/api/repository/assets/unreferenced"},
		{http.MethodPost, "/api/repository/assets/cleanup"},
		{http.MethodGet, "/api/repository/git/status"},
		{http.MethodPost, "/api/repository/git/sync"},
		{http.MethodPost, "/api/repository/git/sync-background"},
		{http.MethodPost, "/api/notebooks"},
		{http.MethodPost, "/api/notebooks/ssh-key"},
		{http.MethodGet, "/api/notebooks/ssh-keys"},
		{http.MethodDelete, "/api/notebooks/ssh-keys/example"},
		{http.MethodPost, "/api/notebooks/test-connection"},
		{http.MethodPost, "/api/notebooks/ssh-host/discover"},
		{http.MethodPost, "/api/notebooks/ssh-host/trust"},
		{http.MethodGet, "/api/future-protected-route"},
	}
	for _, route := range protected {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(route.method, route.path, nil))
			if response.Code != http.StatusUnauthorized || strings.TrimSpace(response.Body.String()) != `{"code":"authentication_required","error":"authentication required"}` {
				t.Fatalf("protected API response = %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestPublicAuthSurfaceDoesNotExposeDeploymentMetadata(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	root := filepath.Join(t.TempDir(), "SENSITIVE-HOST-PATH")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	service, err := auth.Open(t.Context(), auth.Config{Mode: auth.ModeLocal, MetadataPath: filepath.Join(t.TempDir(), "SENSITIVE-AUTH-DATABASE.db")}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	token, err := service.CreateBootstrapToken(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := service.CompleteSetup(t.Context(), token.Value, "a sufficiently long password"); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandlerWithAuth(logger, root, service)
	if err != nil {
		t.Fatal(err)
	}
	public := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/health", ""},
		{http.MethodGet, "/api/auth/status", ""},
		{http.MethodPost, "/api/auth/login", `{"password":"wrong but deliberately long password","rememberDevice":false}`},
		{http.MethodPost, "/api/auth/login/mfa", `{"code":"000000"}`},
		{http.MethodPost, "/api/auth/setup", `{"bootstrapToken":"invalid","password":"another sufficiently long password"}`},
	}
	for _, route := range public {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(route.method, route.path, strings.NewReader(route.body)))
		body := strings.ToLower(response.Body.String())
		for _, forbidden := range []string{"sensitive-host-path", "sensitive-auth-database", "remoteurl", "private key", "known_hosts", "git@"} {
			if strings.Contains(body, strings.ToLower(forbidden)) {
				t.Fatalf("public %s exposed deployment metadata %q: %s", route.path, forbidden, response.Body.String())
			}
		}
	}
}
