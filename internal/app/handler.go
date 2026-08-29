package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/fred-head/repoquill/internal/auth"
	"github.com/fred-head/repoquill/internal/files"
	gitrepo "github.com/fred-head/repoquill/internal/git"
	frontend "github.com/fred-head/repoquill/web"
)

func NewHandler(logger *slog.Logger, repositoryRoot string, versions ...string) (http.Handler, error) {
	return newHandler(logger, repositoryRoot, nil, versions...)
}

func NewHandlerWithAuth(logger *slog.Logger, repositoryRoot string, authService *auth.Service, versions ...string) (http.Handler, error) {
	if authService == nil {
		return nil, errors.New("authentication service is required")
	}
	sessions, err := auth.NewSessions(authService, auth.DefaultSessionOptions(authService.Config().CookieSecure))
	if err != nil {
		return nil, err
	}
	return newHandlerWithSessions(logger, repositoryRoot, authService, sessions, versions...)
}

func newHandler(logger *slog.Logger, repositoryRoot string, authService *auth.Service, versions ...string) (http.Handler, error) {
	return newHandlerWithSessions(logger, repositoryRoot, authService, nil, versions...)
}

func newHandlerWithSessions(logger *slog.Logger, repositoryRoot string, authService *auth.Service, sessions *auth.Sessions, versions ...string) (http.Handler, error) {
	version := "dev"
	if len(versions) > 0 && strings.TrimSpace(versions[0]) != "" {
		version = strings.TrimSpace(versions[0])
	}
	metadataPath := os.Getenv("REPOQUILL_NOTEBOOK_METADATA")
	keysDirectory := os.Getenv("REPOQUILL_KEYS_DIR")
	knownHostsPath := os.Getenv("REPOQUILL_SSH_KNOWN_HOSTS")
	hostTrustService := gitrepo.NewHostTrustService(knownHostsPath, logger)
	requestIdentity := auth.NewRequestIdentity(nil)
	var loginThrottle *auth.LoginThrottle
	if authService != nil {
		requestIdentity = auth.NewRequestIdentity(authService.Config().TrustedProxies)
		loginThrottle = auth.NewLoginThrottle(authService)
	}
	activeRecord, activeLoadErr := loadActiveNotebook(metadataPath)
	activeNotebookName := strings.TrimSpace(os.Getenv("REPOQUILL_NOTEBOOK_NAME"))
	if activeLoadErr == nil {
		repositoryRoot = activeRecord.LocalPath
		activeNotebookName = activeRecord.Name
	}
	if activeNotebookName == "" {
		activeNotebookName = filepath.Base(filepath.Clean(repositoryRoot))
		if activeNotebookName == "." || activeNotebookName == string(filepath.Separator) || activeNotebookName == "" {
			activeNotebookName = "Notebook"
		}
	}
	repository, err := files.NewRepository(repositoryRoot)
	if err != nil {
		return nil, err
	}
	if errors.Is(activeLoadErr, os.ErrNotExist) && metadataPath != "" && repository.Configured() {
		localRecord := notebookRecord{ID: "local", Name: activeNotebookName, LocalPath: repositoryRoot}
		if registerErr := registerActiveNotebook(metadataPath, localRecord); registerErr == nil {
			activeRecord = localRecord
			activeLoadErr = nil
		}
	}
	gitService := gitrepo.NewService(repositoryRoot, logger)
	if activeLoadErr == nil && activeRecord.AuthType == "managed-ssh" {
		_, sshCommand, resolveErr := gitrepo.ResolveManagedSSH(keysDirectory, activeRecord.KeyID, knownHostsPath)
		if resolveErr != nil {
			return nil, fmt.Errorf("configure managed notebook SSH key: %w", resolveErr)
		}
		gitService = gitrepo.NewManagedService(repositoryRoot, sshCommand, logger)
	} else if activeLoadErr == nil && activeRecord.AuthType == "existing-server-ssh" {
		gitService = gitrepo.NewManagedService(repositoryRoot, gitrepo.SSHCommand("", knownHostsPath), logger)
	}
	if activeLoadErr == nil {
		gitService.RestoreLastSyncedAt(activeRecord.LastSyncedAt)
	}
	var activeMu sync.RWMutex
	currentRepository := func() *files.Repository {
		activeMu.RLock()
		defer activeMu.RUnlock()
		return repository
	}
	currentGit := func() *gitrepo.Service {
		activeMu.RLock()
		defer activeMu.RUnlock()
		return gitService
	}
	currentGitContext := func() (*gitrepo.Service, notebookRecord) {
		activeMu.RLock()
		defer activeMu.RUnlock()
		return gitService, activeRecord
	}
	recordSuccessfulSync := func(record notebookRecord, status gitrepo.Status) {
		if record.ID == "" || status.LastSyncedAt == "" {
			return
		}
		if err := recordNotebookSync(metadataPath, record.ID, status.LastSyncedAt); err != nil {
			logger.Warn("persist last successful synchronization failed", "notebook", record.ID, "error", err)
			return
		}
		activeMu.Lock()
		if activeRecord.ID == record.ID {
			activeRecord.LastSyncedAt = status.LastSyncedAt
		}
		activeMu.Unlock()
	}
	currentNotebookName := func() string {
		activeMu.RLock()
		defer activeMu.RUnlock()
		return activeNotebookName
	}

	mux := http.NewServeMux()
	beginCredentialAttempt := func(w http.ResponseWriter, r *http.Request, operation string) (netip.Addr, func(), bool) {
		clientIP := requestIdentity.ClientIP(r)
		errorMessage := "too many authentication attempts"
		errorCode := "authentication_throttled"
		if operation == auth.ThrottleOperationLogin {
			errorMessage = "too many login attempts"
			errorCode = "login_throttled"
		}
		if !loginThrottle.Begin() {
			w.Header().Set("Retry-After", "1")
			_ = authService.RecordSecurityEvent(r.Context(), operation, "throttled", "client="+auth.ClientReference(clientIP))
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": errorMessage, "code": errorCode, "retryAfterSeconds": 1})
			return clientIP, func() {}, false
		}
		retryAfter, err := loginThrottle.CheckOperation(r.Context(), operation, clientIP)
		if err != nil {
			loginThrottle.End()
			logger.Error("credential throttle unavailable", "operation", operation, "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication is unavailable"})
			return clientIP, func() {}, false
		}
		if retryAfter > 0 {
			loginThrottle.End()
			seconds := int64((retryAfter + time.Second - 1) / time.Second)
			w.Header().Set("Retry-After", fmt.Sprintf("%d", seconds))
			_ = authService.RecordSecurityEvent(r.Context(), operation, "throttled", "client="+auth.ClientReference(clientIP))
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": errorMessage, "code": errorCode, "retryAfterSeconds": seconds})
			return clientIP, func() {}, false
		}
		return clientIP, loginThrottle.End, true
	}
	recordCredentialFailure := func(w http.ResponseWriter, r *http.Request, operation string, clientIP netip.Addr) bool {
		delay, err := loginThrottle.FailureOperation(r.Context(), operation, clientIP)
		if err != nil {
			logger.Error("record credential throttle failed", "operation", operation, "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication is unavailable"})
			return false
		}
		if delay > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int64((delay+time.Second-1)/time.Second)))
		}
		return true
	}
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": version})
	})
	if authService != nil {
		mux.HandleFunc("GET /api/auth/status", func(w http.ResponseWriter, r *http.Request) {
			state, err := authService.State(r.Context())
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication state is unavailable"})
				return
			}
			response := map[string]any{
				"mode":          state.Mode,
				"setupRequired": state.Mode == auth.ModeLocal && !state.SetupCompleted,
				"authenticated": state.Mode == auth.ModeDisabled || (sessions != nil && sessions.Authenticated(r.Context())),
			}
			if state.Mode == auth.ModeLocal {
				response["csrfToken"] = sessions.ExistingCSRFToken(r.Context())
			}
			writeJSON(w, http.StatusOK, response)
		})
		mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				Password       string `json:"password"`
				RememberDevice bool   `json:"rememberDevice"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			state, err := authService.State(r.Context())
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication state is unavailable"})
				return
			}
			if state.Mode != auth.ModeLocal || !state.SetupCompleted {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "login is not available", "code": "login_unavailable"})
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationLogin)
			if !allowed {
				return
			}
			defer release()
			err = sessions.Login(r.Context(), input.Password, input.RememberDevice, r.UserAgent())
			if errors.Is(err, auth.ErrMFARequired) {
				_ = authService.RecordSecurityEvent(r.Context(), "login_password", "success", "client="+auth.ClientReference(clientIP))
				writeJSON(w, http.StatusAccepted, map[string]any{"authenticated": false, "mfaRequired": true})
				return
			}
			if errors.Is(err, auth.ErrAuthentication) {
				if !recordCredentialFailure(w, r, auth.ThrottleOperationLogin, clientIP) {
					return
				}
				_ = authService.RecordSecurityEvent(r.Context(), "login", "failure", "client="+auth.ClientReference(clientIP))
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
				return
			}
			if err != nil {
				_ = authService.RecordSecurityEvent(r.Context(), "login", "error", "client="+auth.ClientReference(clientIP))
				logger.Error("login failed", "error", err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication is unavailable"})
				return
			}
			if err := loginThrottle.SuccessOperation(r.Context(), auth.ThrottleOperationLogin, clientIP); err != nil {
				logger.Warn("clear login throttle failed", "error", err)
			}
			_ = authService.RecordSecurityEvent(r.Context(), "login", "success", "client="+auth.ClientReference(clientIP))
			writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "csrfToken": sessions.ExistingCSRFToken(r.Context())})
		})
		mux.HandleFunc("POST /api/auth/login/mfa", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				Code string `json:"code"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationLogin)
			if !allowed {
				return
			}
			defer release()
			if err := sessions.CompleteMFA(r.Context(), input.Code); err != nil {
				if !recordCredentialFailure(w, r, auth.ThrottleOperationLogin, clientIP) {
					return
				}
				_ = authService.RecordSecurityEvent(r.Context(), "login_mfa", "failure", "client="+auth.ClientReference(clientIP))
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
				return
			}
			_ = loginThrottle.SuccessOperation(r.Context(), auth.ThrottleOperationLogin, clientIP)
			_ = authService.RecordSecurityEvent(r.Context(), "login_mfa", "success", "client="+auth.ClientReference(clientIP))
			writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "csrfToken": sessions.ExistingCSRFToken(r.Context())})
		})
		mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
			if err := sessions.Logout(r.Context()); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "logout failed"})
				return
			}
			_ = authService.RecordSecurityEvent(r.Context(), "logout", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
			writeJSON(w, http.StatusOK, map[string]bool{"authenticated": false})
		})
		mux.HandleFunc("DELETE /api/auth/session", func(w http.ResponseWriter, r *http.Request) {
			if err := sessions.RevokeCurrent(r.Context()); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session revocation failed"})
				return
			}
			_ = authService.RecordSecurityEvent(r.Context(), "session_revoke_current", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
			writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
		})
		mux.HandleFunc("DELETE /api/auth/sessions", func(w http.ResponseWriter, r *http.Request) {
			if err := sessions.RevokeAll(r.Context()); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session revocation failed"})
				return
			}
			_ = authService.RecordSecurityEvent(r.Context(), "session_revoke_all", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
			writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
		})
		mux.HandleFunc("GET /api/auth/sessions", func(w http.ResponseWriter, r *http.Request) {
			records, err := authService.Sessions(r.Context(), sessions.CurrentHash(r.Context()))
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sessions are unavailable"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"sessions": records})
		})
		mux.HandleFunc("DELETE /api/auth/sessions/others", func(w http.ResponseWriter, r *http.Request) {
			if err := authService.RevokeOtherSessions(r.Context(), sessions.CurrentHash(r.Context())); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session revocation failed"})
				return
			}
			_ = authService.RecordSecurityEvent(r.Context(), "session_revoke_others", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
			writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
		})
		mux.HandleFunc("DELETE /api/auth/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
			err := authService.RevokeSession(r.Context(), r.PathValue("id"), sessions.CurrentHash(r.Context()))
			switch {
			case err == nil:
				writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
			case errors.Is(err, sql.ErrNoRows):
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
			default:
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			}
		})
		mux.HandleFunc("GET /api/auth/security", func(w http.ResponseWriter, r *http.Request) {
			settings, err := authService.SessionSettings(r.Context())
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "security settings are unavailable"})
				return
			}
			mfaEnabled, err := authService.MFAEnabled(r.Context())
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "MFA state is unavailable"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"sessionSettings": settings, "mfaEnabled": mfaEnabled})
		})
		mux.HandleFunc("PUT /api/auth/security/session-settings", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				CurrentPassword string `json:"currentPassword"`
				IdleHours       int    `json:"idleHours"`
				LifetimeHours   int    `json:"lifetimeHours"`
				RememberDays    int    `json:"rememberDays"`
				MFACode         string `json:"mfaCode"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			if input.IdleHours < 1 || input.IdleHours > 720 || input.LifetimeHours < 1 || input.LifetimeHours > 24 || input.RememberDays < 1 || input.RememberDays > 90 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session durations are outside the allowed range"})
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationSensitive)
			if !allowed {
				return
			}
			defer release()
			if err := authService.VerifyPassword(r.Context(), input.CurrentPassword); err != nil {
				if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
					return
				}
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
				return
			}
			enabled, stateErr := authService.MFAEnabled(r.Context())
			if stateErr != nil {
				logger.Error("read MFA state for session settings failed", "error", stateErr)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication is unavailable"})
				return
			}
			if enabled {
				if authService.VerifySecondFactor(r.Context(), input.MFACode) != nil {
					if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
						return
					}
					writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
					return
				}
			}
			settings := auth.SessionSettings{IdleHours: input.IdleHours, LifetimeHours: input.LifetimeHours, RememberDays: input.RememberDays}
			if err := authService.UpdateSessionSettings(r.Context(), settings); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := loginThrottle.SuccessOperation(r.Context(), auth.ThrottleOperationSensitive, clientIP); err != nil {
				logger.Warn("clear sensitive credential throttle failed", "error", err)
			}
			_ = authService.RecordSecurityEvent(r.Context(), "session_settings", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
			writeJSON(w, http.StatusOK, map[string]any{"sessionSettings": settings})
		})
		mux.HandleFunc("PUT /api/auth/password", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				CurrentPassword string `json:"currentPassword"`
				NewPassword     string `json:"newPassword"`
				MFACode         string `json:"mfaCode"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			if err := auth.ValidatePassword(input.NewPassword); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationSensitive)
			if !allowed {
				return
			}
			defer release()
			enabled, stateErr := authService.MFAEnabled(r.Context())
			if stateErr != nil {
				logger.Error("read MFA state for password change failed", "error", stateErr)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication is unavailable"})
				return
			}
			if enabled {
				if err := authService.VerifyPassword(r.Context(), input.CurrentPassword); err != nil || authService.VerifySecondFactor(r.Context(), input.MFACode) != nil {
					if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
						return
					}
					writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
					return
				}
			}
			err := sessions.ChangePassword(r.Context(), input.CurrentPassword, input.NewPassword)
			switch {
			case err == nil:
				if clearErr := loginThrottle.SuccessOperation(r.Context(), auth.ThrottleOperationSensitive, clientIP); clearErr != nil {
					logger.Warn("clear sensitive credential throttle failed", "error", clearErr)
				}
				_ = authService.RecordSecurityEvent(r.Context(), "password_change", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
				writeJSON(w, http.StatusOK, map[string]any{"changed": true, "csrfToken": sessions.ExistingCSRFToken(r.Context())})
			case errors.Is(err, auth.ErrAuthentication):
				if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
					return
				}
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
			case errors.Is(err, auth.ErrPasswordTooShort), errors.Is(err, auth.ErrPasswordTooLarge), errors.Is(err, auth.ErrInvalidPassword), errors.Is(err, auth.ErrPasswordTooWeak):
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			default:
				logger.Error("password change failed", "error", err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "password change failed"})
			}
		})
		mux.HandleFunc("POST /api/auth/mfa/enroll", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				CurrentPassword string `json:"currentPassword"`
				CurrentFactor   string `json:"currentFactor"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationSensitive)
			if !allowed {
				return
			}
			defer release()
			enrollment, err := authService.BeginMFAEnrollment(r.Context(), input.CurrentPassword, input.CurrentFactor, sessions.CurrentHash(r.Context()))
			if err != nil {
				if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
					return
				}
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
				return
			}
			_ = loginThrottle.SuccessOperation(r.Context(), auth.ThrottleOperationSensitive, clientIP)
			writeJSON(w, http.StatusOK, enrollment)
		})
		mux.HandleFunc("POST /api/auth/mfa/confirm", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				Code                string `json:"code"`
				RecoveryCodesStored bool   `json:"recoveryCodesStored"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationSensitive)
			if !allowed {
				return
			}
			defer release()
			if err := authService.ConfirmMFAEnrollment(r.Context(), input.Code, input.RecoveryCodesStored, sessions.CurrentHash(r.Context())); err != nil {
				if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
					return
				}
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "MFA enrollment could not be confirmed"})
				return
			}
			_ = loginThrottle.SuccessOperation(r.Context(), auth.ThrottleOperationSensitive, clientIP)
			if err := sessions.RotateCurrent(r.Context()); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session rotation failed"})
				return
			}
			_ = authService.RecordSecurityEvent(r.Context(), "mfa_enabled", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
			writeJSON(w, http.StatusOK, map[string]any{"mfaEnabled": true, "csrfToken": sessions.ExistingCSRFToken(r.Context())})
		})
		mux.HandleFunc("DELETE /api/auth/mfa/enrollment", func(w http.ResponseWriter, r *http.Request) {
			if err := authService.CancelMFAEnrollment(r.Context(), sessions.CurrentHash(r.Context())); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "MFA enrollment could not be cancelled"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"cancelled": true})
		})
		mux.HandleFunc("DELETE /api/auth/mfa", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				CurrentPassword string `json:"currentPassword"`
				Code            string `json:"code"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationSensitive)
			if !allowed {
				return
			}
			defer release()
			if err := authService.DisableMFA(r.Context(), input.CurrentPassword, input.Code); err != nil {
				if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
					return
				}
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
				return
			}
			if err := sessions.Logout(r.Context()); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "logout failed"})
				return
			}
			_ = authService.RecordSecurityEvent(r.Context(), "mfa_disabled", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
			writeJSON(w, http.StatusOK, map[string]bool{"mfaEnabled": false})
		})
		mux.HandleFunc("POST /api/auth/mfa/recovery-codes", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				CurrentPassword string `json:"currentPassword"`
				Code            string `json:"code"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			clientIP, release, allowed := beginCredentialAttempt(w, r, auth.ThrottleOperationSensitive)
			if !allowed {
				return
			}
			defer release()
			codes, err := authService.RegenerateRecoveryCodes(r.Context(), input.CurrentPassword, input.Code)
			if err != nil {
				if !recordCredentialFailure(w, r, auth.ThrottleOperationSensitive, clientIP) {
					return
				}
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication failed", "code": "invalid_credentials"})
				return
			}
			_ = loginThrottle.SuccessOperation(r.Context(), auth.ThrottleOperationSensitive, clientIP)
			writeJSON(w, http.StatusOK, map[string]any{"recoveryCodes": codes})
		})
		mux.HandleFunc("POST /api/auth/setup", func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				BootstrapToken string `json:"bootstrapToken"`
				Password       string `json:"password"`
			}
			if !decodeJSONWithLimit(w, r, &input, maxAuthRequestBodySize) {
				return
			}
			err := authService.CompleteSetup(r.Context(), input.BootstrapToken, input.Password)
			switch {
			case err == nil:
				if establishErr := sessions.EstablishAfterSetup(r.Context(), r.UserAgent()); establishErr != nil {
					logger.Error("owner session establishment failed", "error", establishErr)
					writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "setup completed but login failed"})
					return
				}
				_ = authService.RecordSecurityEvent(r.Context(), "setup", "success", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
				writeJSON(w, http.StatusOK, map[string]any{"setupCompleted": true, "authenticated": true, "csrfToken": sessions.ExistingCSRFToken(r.Context())})
			case errors.Is(err, auth.ErrPasswordTooShort), errors.Is(err, auth.ErrPasswordTooLarge), errors.Is(err, auth.ErrInvalidPassword), errors.Is(err, auth.ErrPasswordTooWeak):
				_ = authService.RecordSecurityEvent(r.Context(), "setup", "failure", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			case errors.Is(err, auth.ErrInvalidBootstrap):
				_ = authService.RecordSecurityEvent(r.Context(), "setup", "failure", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "setup authorization is invalid or expired"})
			case errors.Is(err, auth.ErrSetupUnavailable):
				_ = authService.RecordSecurityEvent(r.Context(), "setup", "unavailable", "client="+auth.ClientReference(requestIdentity.ClientIP(r)))
				writeJSON(w, http.StatusConflict, map[string]string{"error": "owner setup is not available"})
			default:
				logger.Error("owner setup failed", "error", err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "owner setup could not be completed"})
			}
		})
	}
	mux.HandleFunc("GET /api/notebook", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"name": currentNotebookName(), "configured": currentRepository().Configured()})
	})
	mux.HandleFunc("GET /api/notebooks", func(w http.ResponseWriter, _ *http.Request) {
		registry, err := loadNotebookRegistry(metadataPath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeJSON(w, http.StatusOK, map[string]any{"activeId": "", "notebooks": []notebookRecord{}})
				return
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook registry is unavailable"})
			return
		}
		items := make([]map[string]string, 0, len(registry.Entries))
		for _, notebook := range registry.Entries {
			items = append(items, map[string]string{"id": notebook.ID, "name": notebook.Name, "remoteUrl": notebook.RemoteURL, "branch": notebook.Branch, "authType": notebook.AuthType, "keyId": notebook.KeyID})
		}
		writeJSON(w, http.StatusOK, map[string]any{"activeId": registry.ActiveID, "notebooks": items})
	})
	mux.HandleFunc("POST /api/notebooks/{notebookID}/activate", func(w http.ResponseWriter, r *http.Request) {
		record, err := findNotebook(metadataPath, r.PathValue("notebookID"))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "notebook not found"})
			} else {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook could not be activated"})
			}
			return
		}
		nextRepository, err := files.NewRepository(record.LocalPath)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook files are unavailable"})
			return
		}
		sshCommand := ""
		if record.AuthType == "managed-ssh" {
			_, sshCommand, err = gitrepo.ResolveManagedSSH(keysDirectory, record.KeyID, knownHostsPath)
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook SSH key is unavailable"})
				return
			}
		} else if record.AuthType == "existing-server-ssh" {
			sshCommand = gitrepo.SSHCommand("", knownHostsPath)
		}
		if err := setActiveNotebook(metadataPath, record.ID); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook could not be activated"})
			return
		}
		activeMu.Lock()
		repository = nextRepository
		gitService = gitrepo.NewManagedService(record.LocalPath, sshCommand, logger)
		gitService.RestoreLastSyncedAt(record.LastSyncedAt)
		activeRecord = record
		activeNotebookName = record.Name
		activeMu.Unlock()
		writeJSON(w, http.StatusOK, record)
	})
	mux.HandleFunc("PATCH /api/notebooks/{notebookID}", func(w http.ResponseWriter, r *http.Request) {
		notebookID := r.PathValue("notebookID")
		var input struct {
			Name string `json:"name"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		if notebookID == "" || strings.ContainsAny(notebookID, "/\\\x00") || input.Name == "" || len(input.Name) > 100 || strings.ContainsAny(input.Name, "\r\n\x00") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid notebook name is required"})
			return
		}
		record, err := renameNotebook(metadataPath, notebookID, input.Name)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "notebook not found"})
			} else {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook name could not be saved"})
			}
			return
		}
		activeMu.Lock()
		if current, activeErr := loadActiveNotebook(metadataPath); activeErr == nil && current.ID == notebookID {
			activeNotebookName = input.Name
		}
		activeMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]string{"id": record.ID, "name": record.Name})
	})
	mux.HandleFunc("GET /api/notebooks/{notebookID}/health", func(w http.ResponseWriter, r *http.Request) {
		record, err := findNotebook(metadataPath, r.PathValue("notebookID"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "notebook not found"})
			return
		}
		localState, localMessage := "ok", "Local files are available"
		if _, repositoryErr := files.NewRepository(record.LocalPath); repositoryErr != nil {
			localState, localMessage = "failed", "Local files cannot be opened"
		}
		writeState, writeMessage := "ok", "Local storage is writable"
		if localState == "ok" {
			probe, probeErr := os.CreateTemp(record.LocalPath, ".repoquill-health-*")
			if probeErr != nil {
				writeState, writeMessage = "failed", "RepoQuill cannot write to this notebook"
			} else {
				probeName := probe.Name()
				closeErr := probe.Close()
				removeErr := os.Remove(probeName)
				if closeErr != nil || removeErr != nil {
					writeState, writeMessage = "failed", "RepoQuill cannot safely update this notebook"
				}
			}
		} else {
			writeState, writeMessage = "failed", "Write access cannot be checked until local files are available"
		}
		sshCommand := ""
		if record.AuthType == "managed-ssh" {
			_, sshCommand, err = gitrepo.ResolveManagedSSH(keysDirectory, record.KeyID, knownHostsPath)
		} else if record.AuthType == "existing-server-ssh" {
			sshCommand = gitrepo.SSHCommand("", knownHostsPath)
		}
		connectionState, connectionMessage := "not_checked", "Remote connection has not been checked"
		if err != nil {
			connectionState, connectionMessage = "failed", "The assigned SSH key is unavailable"
		} else if r.URL.Query().Get("remote") == "true" && record.RemoteURL != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			defer cancel()
			connection := gitrepo.TestConnection(ctx, record.RemoteURL, record.Branch, sshCommand, logger)
			connectionState, connectionMessage = connection.State, connection.Message
		}
		statusContext, statusCancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer statusCancel()
		service := gitrepo.NewManagedService(record.LocalPath, sshCommand, logger)
		service.RestoreLastSyncedAt(record.LastSyncedAt)
		if active, activeErr := loadActiveNotebook(metadataPath); activeErr == nil && active.ID == record.ID {
			service = currentGit()
		}
		status := service.Status(statusContext)
		writeJSON(w, http.StatusOK, map[string]any{"localFiles": map[string]string{"state": localState, "message": localMessage}, "writeAccess": map[string]string{"state": writeState, "message": writeMessage}, "connection": map[string]string{"state": connectionState, "message": connectionMessage}, "pendingWork": map[string]string{"state": string(status.State), "message": status.Message}, "lastSyncedAt": record.LastSyncedAt})
	})
	mux.HandleFunc("DELETE /api/notebooks/{notebookID}", func(w http.ResponseWriter, r *http.Request) {
		notebookID := r.PathValue("notebookID")
		if notebookID == "" || strings.ContainsAny(notebookID, "/\\\x00") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid notebook ID"})
			return
		}
		record, findErr := findNotebook(metadataPath, notebookID)
		if findErr != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "notebook not found"})
			return
		}
		deleteLocal := r.URL.Query().Get("deleteLocal") == "true"
		if deleteLocal {
			var input struct {
				Confirmation string `json:"confirmation"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			if input.Confirmation != record.Name {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type the exact notebook name to confirm local file deletion"})
				return
			}
		}
		if err := removeLocalNotebook(metadataPath, notebookID); err != nil {
			switch {
			case errors.Is(err, os.ErrNotExist):
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "notebook not found"})
			case err.Error() == "active notebook cannot be removed":
				writeJSON(w, http.StatusConflict, map[string]string{"error": "switch to another notebook before removing this local notebook"})
			default:
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook registration could not be removed"})
			}
			return
		}
		if deleteLocal {
			notebookBase := strings.TrimSpace(os.Getenv("REPOQUILL_NOTEBOOKS_DIR"))
			base, baseErr := filepath.Abs(notebookBase)
			target, targetErr := filepath.Abs(record.LocalPath)
			relative, relErr := filepath.Rel(base, target)
			info, statErr := os.Lstat(target)
			if notebookBase == "" || baseErr != nil || targetErr != nil || relErr != nil || relative != record.ID || statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				_ = registerNotebookWithoutActivation(metadataPath, record)
				writeJSON(w, http.StatusConflict, map[string]string{"error": "local files were retained because their location could not be verified safely"})
				return
			}
			if err := os.RemoveAll(target); err != nil {
				_ = registerNotebookWithoutActivation(metadataPath, record)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registration was restored because local files could not be deleted"})
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/repository/tree", func(w http.ResponseWriter, _ *http.Request) {
		tree, err := currentRepository().Tree()
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": tree})
	})
	mux.HandleFunc("GET /api/repository/search", func(w http.ResponseWriter, r *http.Request) {
		results, err := currentRepository().Search(r.URL.Query().Get("q"))
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": results})
	})
	mux.HandleFunc("GET /api/repository/file", func(w http.ResponseWriter, r *http.Request) {
		filePath := r.URL.Query().Get("path")
		markdown, err := currentRepository().ReadMarkdown(filePath)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"path": filePath, "content": markdown.Content, "version": markdown.Version})
	})
	mux.HandleFunc("PUT /api/repository/file", func(w http.ResponseWriter, r *http.Request) {
		filePath := r.URL.Query().Get("path")
		var input struct {
			Content string `json:"content"`
			Version string `json:"version"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid save request"})
			return
		}
		markdown, err := currentRepository().WriteMarkdown(filePath, input.Content, input.Version)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"path": filePath, "content": markdown.Content, "version": markdown.Version})
	})
	mux.HandleFunc("POST /api/repository/file/resolve-conflict", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Path            string `json:"path"`
			ExpectedVersion string `json:"expectedVersion"`
			Content         string `json:"content"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		safetyPoint, err := currentGit().PreserveFileVersion(ctx, input.Path)
		if err != nil {
			writeGitConflictError(w, err)
			return
		}
		markdown, err := currentRepository().WriteMarkdown(input.Path, input.Content, input.ExpectedVersion)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"file": map[string]string{"path": input.Path, "content": markdown.Content, "version": markdown.Version}, "safetyPoint": safetyPoint})
	})
	mux.HandleFunc("GET /api/repository/history", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		history, err := currentGit().NoteHistoryWithStatus(ctx, r.URL.Query().Get("path"))
		if err != nil {
			writeHistoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, history)
	})
	mux.HandleFunc("GET /api/repository/history/version", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		version, err := currentGit().NoteVersion(ctx, r.URL.Query().Get("path"), r.URL.Query().Get("version"))
		if err != nil {
			writeHistoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, version)
	})
	mux.HandleFunc("POST /api/repository/history/restore", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Path            string `json:"path"`
			VersionID       string `json:"versionId"`
			ExpectedVersion string `json:"expectedVersion"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		version, err := currentGit().NoteVersion(ctx, input.Path, input.VersionID)
		if err != nil {
			writeHistoryError(w, err)
			return
		}
		markdown, err := currentRepository().WriteMarkdown(input.Path, version.Content, input.ExpectedVersion)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"path": input.Path, "content": markdown.Content, "version": markdown.Version})
	})
	mux.HandleFunc("POST /api/repository/entries", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Path string `json:"path"`
			Type string `json:"type"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := currentRepository().Create(input.Path, input.Type); err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"path": input.Path, "type": input.Type})
	})
	mux.HandleFunc("POST /api/repository/move", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Source       string `json:"source"`
			Target       string `json:"target"`
			RewriteToken string `json:"rewriteToken"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if input.RewriteToken == "" {
			preview, err := currentRepository().PreviewMoveLinks(input.Source, input.Target)
			if err != nil {
				writeRepositoryError(w, err)
				return
			}
			if len(preview.Rewrites) > 0 {
				writeRepositoryError(w, files.ErrLinkPreviewRequired)
				return
			}
			if err := currentRepository().Move(input.Source, input.Target); err != nil {
				writeRepositoryError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"path": input.Target, "rewrites": []files.LinkRewrite{}})
			return
		}
		preview, err := currentRepository().MoveWithLinkUpdates(input.Source, input.Target, input.RewriteToken)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": input.Target, "rewrites": preview.Rewrites})
	})
	mux.HandleFunc("POST /api/repository/move/preview", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Source string `json:"source"`
			Target string `json:"target"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		preview, err := currentRepository().PreviewMoveLinks(input.Source, input.Target)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preview)
	})
	mux.HandleFunc("GET /api/repository/links", func(w http.ResponseWriter, r *http.Request) {
		links, err := currentRepository().NoteLinks(r.URL.Query().Get("path"))
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"links": links})
	})
	mux.HandleFunc("DELETE /api/repository/entry", func(w http.ResponseWriter, r *http.Request) {
		item, err := currentRepository().MoveToTrash(r.URL.Query().Get("path"))
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	})
	mux.HandleFunc("GET /api/repository/trash", func(w http.ResponseWriter, _ *http.Request) {
		items, err := currentRepository().TrashItems()
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	})
	mux.HandleFunc("POST /api/repository/trash/{trashID}/restore", func(w http.ResponseWriter, r *http.Request) {
		item, err := currentRepository().RestoreTrashItem(r.PathValue("trashID"))
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	})
	mux.HandleFunc("DELETE /api/repository/trash/{trashID}", func(w http.ResponseWriter, r *http.Request) {
		item, err := currentRepository().DeleteTrashItem(r.PathValue("trashID"))
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	})
	mux.HandleFunc("POST /api/repository/assets", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxAssetRequestBodySize)
		if err := r.ParseMultipartForm(maxAssetRequestBodySize); err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "image upload is too large"})
			return
		}
		if r.MultipartForm != nil {
			defer r.MultipartForm.RemoveAll()
		}
		upload, _, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "image file is required"})
			return
		}
		defer upload.Close()
		asset, err := currentRepository().SaveAsset(r.URL.Query().Get("note"), upload)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"path": asset.RelativePath})
	})
	mux.HandleFunc("GET /api/repository/asset", func(w http.ResponseWriter, r *http.Request) {
		asset, err := currentRepository().ReadAsset(r.URL.Query().Get("note"), r.URL.Query().Get("path"))
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		w.Header().Set("Content-Type", asset.ContentType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(asset.Content)
	})
	mux.HandleFunc("GET /api/repository/assets/unreferenced", func(w http.ResponseWriter, _ *http.Request) {
		assets, err := currentRepository().UnreferencedAssets()
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"assets": assets})
	})
	mux.HandleFunc("POST /api/repository/assets/cleanup", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Paths []string `json:"paths"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		result, err := currentRepository().DeleteUnreferencedAssets(input.Paths)
		if err != nil {
			writeRepositoryError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /api/repository/git/status", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		writeJSON(w, http.StatusOK, currentGit().Status(ctx))
	})
	mux.HandleFunc("POST /api/repository/git/sync", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		service, record := currentGitContext()
		result := service.Sync(ctx)
		if result.State == gitrepo.StateSynced {
			recordSuccessfulSync(record, service.Status(ctx))
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST /api/repository/git/sync-background", func(w http.ResponseWriter, _ *http.Request) {
		service, record := currentGitContext()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			result := service.Sync(ctx)
			recordSuccessfulSync(record, result)
			logger.Info("background Git sync completed", "state", result.State)
		}()
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
	})
	mux.HandleFunc("GET /api/repository/git/conflicts", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		overview, err := currentGit().Conflicts(ctx)
		if err != nil {
			writeGitConflictError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, overview)
	})
	mux.HandleFunc("GET /api/repository/git/conflict-version", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		content, contentType, err := currentGit().ConflictBlob(ctx, r.URL.Query().Get("path"), r.URL.Query().Get("side"))
		if err != nil {
			writeGitConflictError(w, err)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(content)
	})
	mux.HandleFunc("POST /api/repository/git/conflicts/resolve", func(w http.ResponseWriter, r *http.Request) {
		var input gitrepo.ConflictResolution
		if !decodeJSON(w, r, &input) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		service, record := currentGitContext()
		result, err := service.ResolveConflicts(ctx, input)
		if err != nil {
			writeGitConflictError(w, err)
			return
		}
		if result.State == gitrepo.StateSynced {
			recordSuccessfulSync(record, service.Status(ctx))
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST /api/notebooks", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Name          string `json:"name"`
			RepositoryURL string `json:"repositoryUrl"`
			Branch        string `json:"branch"`
			AuthType      string `json:"authType"`
			KeyID         string `json:"keyId"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		input.Branch = strings.TrimSpace(input.Branch)
		if input.AuthType == "" {
			input.AuthType = "existing-server-ssh"
		}
		if input.AuthType != "managed-ssh" && input.AuthType != "existing-server-ssh" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported Git authentication type"})
			return
		}
		if err := validateNotebookRemoteURL(input.RepositoryURL); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := gitrepo.ValidateBranch(input.Branch); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if input.Name == "" || len(input.Name) > 100 || strings.ContainsAny(input.Name, "\r\n\x00") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "notebook name is required"})
			return
		}
		notebookBase := os.Getenv("REPOQUILL_NOTEBOOKS_DIR")
		if notebookBase == "" || metadataPath == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook cloning is not configured on this server"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		sshCommand := ""
		if input.AuthType == "managed-ssh" {
			if registry, registryErr := loadNotebookRegistry(metadataPath); registryErr == nil {
				for _, notebook := range registry.Entries {
					if notebook.KeyID == input.KeyID {
						writeJSON(w, http.StatusConflict, map[string]string{"error": "managed SSH key is already assigned to notebook " + notebook.Name})
						return
					}
				}
			} else if !errors.Is(registryErr, os.ErrNotExist) {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "managed SSH key assignments could not be verified"})
				return
			}
			_, managedCommand, resolveErr := gitrepo.ResolveManagedSSH(keysDirectory, input.KeyID, knownHostsPath)
			if resolveErr != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "managed SSH key is unavailable"})
				return
			}
			sshCommand = managedCommand
		} else {
			sshCommand = gitrepo.SSHCommand("", knownHostsPath)
		}
		connection := gitrepo.TestConnection(ctx, input.RepositoryURL, input.Branch, sshCommand, logger)
		if connection.State != "success" {
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"error":   connection.Message,
				"state":   connection.State,
				"message": connection.Message,
			})
			return
		}
		cloned, cloneErr := gitrepo.CloneManaged(ctx, notebookBase, input.RepositoryURL, input.Branch, sshCommand, logger)
		if cloneErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Git clone failed. Check the repository URL, branch, network, SSH host verification, and credentials."})
			return
		}
		clonedRepository, repositoryErr := files.NewRepository(cloned.Path)
		if repositoryErr != nil {
			_ = os.RemoveAll(cloned.Path)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cloned notebook could not be opened"})
			return
		}
		record := notebookRecord{ID: cloned.ID, Name: input.Name, LocalPath: cloned.Path, RemoteURL: strings.TrimSpace(input.RepositoryURL), Branch: cloned.Branch, AuthType: input.AuthType, KeyID: input.KeyID}
		if err := registerActiveNotebook(metadataPath, record); err != nil {
			base, _ := filepath.Abs(notebookBase)
			target, _ := filepath.Abs(cloned.Path)
			if relative, relErr := filepath.Rel(base, target); relErr == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				_ = os.RemoveAll(target)
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cloned notebook could not be registered"})
			return
		}
		activeMu.Lock()
		repository = clonedRepository
		gitService = gitrepo.NewManagedService(cloned.Path, sshCommand, logger)
		activeRecord = record
		activeNotebookName = record.Name
		activeMu.Unlock()
		writeJSON(w, http.StatusCreated, record)
	})
	mux.HandleFunc("POST /api/notebooks/ssh-key", func(w http.ResponseWriter, _ *http.Request) {
		if strings.TrimSpace(keysDirectory) == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "managed SSH keys are not configured on this server; set REPOQUILL_KEYS_DIR and restart RepoQuill"})
			return
		}
		key, err := gitrepo.GenerateSSHKey(keysDirectory, logger)
		if err != nil {
			logger.Error("managed SSH key generation failed", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "managed SSH key generation failed; check the configured key directory and server logs"})
			return
		}
		writeJSON(w, http.StatusCreated, key)
	})
	mux.HandleFunc("GET /api/notebooks/ssh-keys", func(w http.ResponseWriter, _ *http.Request) {
		keys, err := gitrepo.ListManagedSSHKeys(keysDirectory)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "managed SSH keys are not available"})
			return
		}
		assignments := make(map[string]string)
		if registry, registryErr := loadNotebookRegistry(metadataPath); registryErr == nil {
			for _, notebook := range registry.Entries {
				if notebook.AuthType == "managed-ssh" && notebook.KeyID != "" {
					assignments[notebook.KeyID] = notebook.Name
				}
			}
		}
		items := make([]map[string]any, 0, len(keys))
		for _, key := range keys {
			notebookName, assigned := assignments[key.ID]
			items = append(items, map[string]any{"keyId": key.ID, "publicKey": key.PublicKey, "createdAt": key.CreatedAt, "fingerprint": key.Fingerprint, "assigned": assigned, "notebookName": notebookName})
		}
		writeJSON(w, http.StatusOK, map[string]any{"keys": items})
	})
	mux.HandleFunc("DELETE /api/notebooks/ssh-keys/{keyID}", func(w http.ResponseWriter, r *http.Request) {
		keyID := r.PathValue("keyID")
		registry, registryErr := loadNotebookRegistry(metadataPath)
		if registryErr != nil && !errors.Is(registryErr, os.ErrNotExist) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "notebook assignments could not be verified; key was not deleted"})
			return
		}
		if registryErr == nil {
			for _, notebook := range registry.Entries {
				if notebook.AuthType == "managed-ssh" && notebook.KeyID == keyID {
					writeJSON(w, http.StatusConflict, map[string]string{"error": "managed SSH key is assigned to notebook " + notebook.Name})
					return
				}
			}
		}
		if err := gitrepo.DeleteManagedSSHKey(keysDirectory, keyID); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "managed SSH key not found"})
			} else {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "managed SSH key could not be deleted"})
			}
			return
		}
		logger.Info("managed SSH key deleted", "keyId", keyID, "operation", "delete-managed-ssh-key")
		writeJSON(w, http.StatusOK, map[string]string{"deleted": keyID})
	})
	mux.HandleFunc("POST /api/notebooks/test-connection", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RepositoryURL string `json:"repositoryUrl"`
			Branch        string `json:"branch"`
			AuthType      string `json:"authType"`
			KeyID         string `json:"keyId"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := validateNotebookRemoteURL(input.RepositoryURL); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"state": "invalid_url", "message": err.Error()})
			return
		}
		if err := gitrepo.ValidateBranch(input.Branch); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"state": "invalid_branch", "message": err.Error()})
			return
		}
		sshCommand := ""
		if input.AuthType == "managed-ssh" {
			_, managedCommand, err := gitrepo.ResolveManagedSSH(keysDirectory, input.KeyID, knownHostsPath)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"state": "key_unavailable", "message": "Generate a RepoQuill SSH key before testing the connection."})
				return
			}
			sshCommand = managedCommand
		} else if input.AuthType != "existing-server-ssh" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"state": "invalid_auth", "message": "Choose a supported authentication method."})
			return
		} else {
			sshCommand = gitrepo.SSHCommand("", knownHostsPath)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		writeJSON(w, http.StatusOK, gitrepo.TestConnection(ctx, strings.TrimSpace(input.RepositoryURL), strings.TrimSpace(input.Branch), sshCommand, logger))
	})
	mux.HandleFunc("POST /api/notebooks/ssh-host/discover", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RepositoryURL string `json:"repositoryUrl"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		discovery, err := hostTrustService.Discover(ctx, strings.TrimSpace(input.RepositoryURL))
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "SSH host-key discovery failed; check the repository URL, host, port, and network"})
			return
		}
		writeJSON(w, http.StatusOK, discovery)
	})
	mux.HandleFunc("POST /api/notebooks/ssh-host/trust", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RequestID string `json:"requestId"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		result, err := hostTrustService.Approve(ctx, strings.TrimSpace(input.RequestID))
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	assets, err := fs.Sub(frontend.Files, "dist")
	if err != nil {
		panic(err)
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "API endpoint not found"})
	})
	mux.Handle("/", spaHandler(assets))

	handler := http.Handler(mux)
	if sessions != nil {
		handler = sessions.LoadAndSave(authenticationBoundary(authService, sessions, csrfProtection(authService, sessions, requestIdentity, handler)))
	}
	return requestLogger(logger, securityHeaders(sameOriginProtection(requestIdentity, handler))), nil
}

const maxRequestBodySize = (10 << 20) + (64 << 10)
const maxAssetRequestBodySize = (10 << 20) + (1 << 20)
const maxAuthRequestBodySize = 4 << 10

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	return decodeJSONWithLimit(w, r, target, maxRequestBodySize)
}

func decodeJSONWithLimit(w http.ResponseWriter, r *http.Request, target any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return false
	}
	return true
}

func writeRepositoryError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "repository operation failed"
	switch {
	case errors.Is(err, files.ErrNotConfigured):
		status, message = http.StatusServiceUnavailable, "repository is not configured"
	case errors.Is(err, files.ErrInvalidPath):
		status, message = http.StatusBadRequest, "invalid repository path"
	case errors.Is(err, files.ErrNotMarkdown):
		status, message = http.StatusBadRequest, "note path must end in .md"
	case errors.Is(err, files.ErrInvalidType):
		status, message = http.StatusBadRequest, "entry type must be file or directory"
	case errors.Is(err, files.ErrAlreadyExists):
		status, message = http.StatusConflict, err.Error()
	case errors.Is(err, files.ErrRestoreCollision):
		status, message = http.StatusConflict, "The original location is already in use. Rename or move the existing item before restoring."
	case errors.Is(err, files.ErrInvalidTrashID):
		status, message = http.StatusBadRequest, "invalid trash item"
	case errors.Is(err, files.ErrLinkPreviewRequired):
		status, message = http.StatusConflict, "Review the internal note-link updates before moving this item."
	case errors.Is(err, files.ErrFileTooLarge):
		status, message = http.StatusRequestEntityTooLarge, err.Error()
	case errors.Is(err, files.ErrAssetTooLarge):
		status, message = http.StatusRequestEntityTooLarge, err.Error()
	case errors.Is(err, files.ErrUnsupportedMedia):
		status, message = http.StatusUnsupportedMediaType, err.Error()
	case errors.Is(err, files.ErrConflict):
		status, message = http.StatusConflict, err.Error()
	case errors.Is(err, os.ErrNotExist):
		status, message = http.StatusNotFound, "Markdown file not found"
	case errors.Is(err, os.ErrPermission):
		status, message = http.StatusForbidden, "repository path is not readable"
	}
	writeJSON(w, status, map[string]string{"error": message})
}

func writeGitConflictError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "The changes could not be reviewed safely. Both versions remain preserved."
	switch {
	case errors.Is(err, gitrepo.ErrNoConflict):
		status, message = http.StatusNotFound, err.Error()
	case errors.Is(err, gitrepo.ErrConflictChanged):
		status, message = http.StatusConflict, err.Error()
	case errors.Is(err, gitrepo.ErrInvalidDecision), errors.Is(err, os.ErrNotExist):
		status, message = http.StatusBadRequest, err.Error()
	}
	writeJSON(w, status, map[string]string{"error": message})
}

func writeHistoryError(w http.ResponseWriter, err error) {
	status := http.StatusServiceUnavailable
	message := "Version history is not available for this notebook."
	switch {
	case errors.Is(err, gitrepo.ErrInvalidNotePath):
		status, message = http.StatusBadRequest, "invalid note history path"
	case errors.Is(err, gitrepo.ErrHistoryVersionMissing):
		status, message = http.StatusNotFound, "This note version is no longer available."
	case errors.Is(err, gitrepo.ErrHistoryFileTooLarge):
		status, message = http.StatusRequestEntityTooLarge, "This historical note is too large to display."
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		status, message = http.StatusServiceUnavailable, "Version history took too long to load. Try again."
	}
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func spaHandler(files fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		requested := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requested == "." {
			requested = "index.html"
		}
		if info, err := fs.Stat(files, requested); err == nil && !info.IsDir() {
			if contentType := mime.TypeByExtension(path.Ext(requested)); contentType != "" {
				w.Header().Set("Content-Type", contentType)
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob: https: http:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") && w.Header().Get("Cache-Control") == "" {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func authenticationBoundary(authService *auth.Service, sessions *auth.Sessions, next http.Handler) http.Handler {
	if authService == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		readOnlyMethod := r.Method == http.MethodGet || r.Method == http.MethodHead
		public := !strings.HasPrefix(r.URL.Path, "/api/") ||
			(readOnlyMethod && r.URL.Path == "/api/health") ||
			(readOnlyMethod && r.URL.Path == "/api/auth/status") ||
			(r.Method == http.MethodPost && r.URL.Path == "/api/auth/setup") ||
			(r.Method == http.MethodPost && (r.URL.Path == "/api/auth/login" || r.URL.Path == "/api/auth/login/mfa"))
		if public {
			next.ServeHTTP(w, r)
			return
		}
		state, err := authService.State(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication state is unavailable"})
			return
		}
		if state.Mode == auth.ModeLocal && !state.SetupCompleted {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner setup is required", "code": "setup_required"})
			return
		}
		if state.Mode == auth.ModeLocal && !sessions.Authenticated(r.Context()) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required", "code": "authentication_required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func csrfProtection(authService *auth.Service, sessions *auth.Sessions, identity *auth.RequestIdentity, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		state, err := authService.State(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication state is unavailable"})
			return
		}
		if state.Mode == auth.ModeDisabled {
			next.ServeHTTP(w, r)
			return
		}
		if (r.URL.Path == "/api/auth/login" || r.URL.Path == "/api/auth/login/mfa" || r.URL.Path == "/api/auth/setup") && !sessions.Authenticated(r.Context()) {
			next.ServeHTTP(w, r)
			return
		}
		if !sessions.ValidCSRFToken(r.Context(), r.Header.Get("X-CSRF-Token")) {
			_ = authService.RecordSecurityEvent(r.Context(), "csrf", "rejected", "client="+auth.ClientReference(identity.ClientIP(r)))
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "CSRF validation failed", "code": "csrf_invalid"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func sameOriginProtection(identity *auth.RequestIdentity, next http.Handler) http.Handler {
	trusted := make(map[string]bool)
	for _, value := range strings.Split(os.Getenv("REPOQUILL_TRUSTED_ORIGINS"), ",") {
		if origin := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "/")); origin != "" {
			trusted[origin] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-origin request rejected"})
			return
		}
		origin := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(r.Header.Get("Origin")), "/"))
		if origin == "" {
			referer := strings.TrimSpace(r.Header.Get("Referer"))
			if referer != "" {
				parsed, err := url.Parse(referer)
				if err == nil {
					origin = strings.ToLower(parsed.Scheme + "://" + parsed.Host)
				}
			}
		}
		if origin != "" && !trusted[origin] {
			parsed, err := url.Parse(origin)
			if err != nil || parsed.Scheme != identity.Scheme(r) || !strings.EqualFold(parsed.Host, r.Host) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-origin request rejected"})
				return
			}
		} else if origin == "" && r.Header.Get("Sec-Fetch-Site") != "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "request origin is required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func validateNotebookRemoteURL(remoteURL string) error {
	if os.Getenv("REPOQUILL_ALLOW_LOCAL_REMOTES") == "true" {
		return nil
	}
	return gitrepo.ValidateRemoteURL(remoteURL, true)
}

func requestLogger(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := strings.ReplaceAll(r.Method, "\n", "")
		method = strings.ReplaceAll(method, "\r", "")
		requestPath := strings.ReplaceAll(r.URL.Path, "\n", "")
		requestPath = strings.ReplaceAll(requestPath, "\r", "")
		logger.Info("http request", "method", sanitizeLogValue(method), "path", sanitizeLogValue(requestPath))
		next.ServeHTTP(w, r)
	})
}

// sanitizeLogValue keeps attacker-controlled request fields on one structured
// log record and removes terminal/control sequences. The limit also prevents a
// request target from creating disproportionate log volume.
func sanitizeLogValue(value string) string {
	const maxRunes = 1024
	clean := strings.Map(func(character rune) rune {
		if unicode.IsControl(character) || character == utf8.RuneError {
			return '�'
		}
		return character
	}, value)
	characters := []rune(clean)
	if len(characters) > maxRunes {
		return string(characters[:maxRunes]) + "…"
	}
	return clean
}
