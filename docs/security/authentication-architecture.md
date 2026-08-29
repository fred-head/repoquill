# RepoQuill single-owner authentication architecture

Status: Milestone 19 architecture decision. Password setup, persistent sessions,
CSRF/throttling, browser/PWA reauthentication, and password/session
administration, optional TOTP, and explicit disabled-mode migration are
implemented through M19P9. The completed review and residual-risk record lives
in [m19-security-review.md](m19-security-review.md). Alpha 2 must not be
published unless the complete M19 CI and review gate passes for its exact tag.

## Decision and scope

RepoQuill owns one authentication boundary for one fixed internal principal,
`owner`. It does not provide registration, usernames, multiple users, roles,
email addresses, invitations, organizations, or email recovery.

Supported modes are:

- `local`: recommended and fail-closed default. A new or migrated database has
  `setup_completed = false` until operator-authorized bootstrap setup.
- `disabled`: accepted only when the operator explicitly sets
  `REPOQUILL_AUTH_MODE=disabled`. The application shows a persistent warning
  and invalidates local authentication artifacts when modes change.

An absent or empty mode never means public access. It resolves to `local`, so an
installation upgraded from unauthenticated Alpha 1 enters the restricted setup
migration path. A missing database is recreated only in this
setup-required state. An unreadable, corrupt, unsupported, or newer database
stops startup instead of falling back to unauthenticated operation.

## Trust boundaries and threat model

```text
untrusted browser/PWA and network
              |
              v
trusted TLS reverse proxy (optional forwarded headers only from configured IPs)
              |
              v
RepoQuill HTTP authentication boundary
              |
       +------+------------------+
       |                         |
       v                         v
authentication metadata      notebook/Git services
/data/app/auth.db             /data/repos, /data/keys
```

The design protects notebook, Git, SSH, maintenance, and management APIs from
unauthenticated network access. It assumes an attacker can send arbitrary HTTP
requests, spoof forwarding headers, steal or replay submitted values, attempt
brute force and setup takeover, trigger restarts, and cause interrupted writes.
It does not protect a host administrator or an attacker with access to the
persistent volume, process memory, container runtime, or TLS private keys.

HTTPS remains mandatory for Internet-facing deployments. Forwarded client IP
and scheme information is untrusted unless the direct peer belongs to an
explicit trusted-proxy allowlist introduced in M19P4.

## HTTP surface

The Phase 3 deny-by-default boundary will classify routes as follows:

Public minimum:

- `GET /api/health`, containing liveness and application version only,
- static application-shell files required to render setup/login,
- narrowly scoped setup, login, MFA challenge, and auth-status
  routes; these must expose no notebook, Git, SSH, filesystem, or host metadata.

Protected:

- every other `/api/` route, including notebooks, notes, tree, files, assets,
  search, Git sync/status, SSH keys/trust, settings, cleanup, and maintenance.

GET and HEAD must not mutate authentication or application state. Missing or
expired API authentication returns stable JSON `401`, never an HTML redirect.

## Persistent metadata boundary

`REPOQUILL_AUTH_METADATA` defaults to `/data/app/auth.db` or to `auth.db` beside
the configured notebook registry. The directory and database use modes `0700`
and `0600`. SQLite runs in the Go process without an external database service.

The database is limited to:

- the fixed owner authentication configuration,
- hashed opaque session identifiers and session metadata,
- hashed one-time setup/recovery artifacts,
- hashed throttle keys and counters,
- security events that contain neither credentials nor note content,
- versioned migration records.

It must never contain Markdown, asset bytes, notebook trees, Git repositories,
SSH private keys, remote tokens, password plaintext, session plaintext, TOTP
codes, or recovery-code plaintext. Deleting it can remove RepoQuill access
configuration but cannot make the ordinary Git-backed notebooks unreadable.

## Migration and recovery model

Schema changes are ordered, recorded, transactional, and restart-safe. A
future destructive migration must checkpoint SQLite and create a private,
exclusive backup before its transaction begins. A failed migration rolls back
and prevents startup. A database created by a newer RepoQuill version is never
downgraded implicitly.

Changing `local`/`disabled` invalidates sessions, one-time artifacts, and
throttling state atomically and resets setup completion. Operator-only password
and MFA recovery commands require filesystem/container administration. Recovery
changes authentication metadata only; it never moves, encrypts, deletes, or
rewrites notebook repositories.

M19P1 initializes and validates this metadata service. M19P2 adds the
operator-controlled one-time bootstrap, versioned Argon2id credential, and a
restricted first-run boundary that blocks all non-setup APIs. M19P3 uses SCS
v2.9 with random opaque session identifiers, stores only their SHA-256 hashes
and server-side state in SQLite, and applies a deny-by-default API boundary.
Normal sessions have a 12-hour absolute lifetime; remembered sessions have a
30-day absolute lifetime, both with a seven-day idle ceiling. The cookie is
HttpOnly, SameSite Strict, scoped to `/api`, and Secure by default. Plain HTTP
development must explicitly set `REPOQUILL_SESSION_COOKIE_SECURE=false`.

The public M19P3 surface is limited to the static shell, liveness, setup,
login, and authentication status. Missing, expired, and revoked sessions receive
`401` with `authentication_required`; they are not reported as Git failures.
M19P4 adds a random synchronizer token bound to each server-side session,
Origin/Referer enforcement, bounded progressive login throttling, hashed client
references in security events, and explicit trusted-proxy CIDRs. Forwarded
client or scheme headers are ignored unless the direct peer is configured as a
trusted proxy. M19P5 adds responsive setup/login screens, in-memory CSRF
handling, cross-tab authentication notifications, network/focus rechecks, and
version-aware temporary recovery drafts for interrupted unsaved edits. The
service worker continues to cache only the application shell and never
API/auth responses. M19P6 adds owner-verified password changes, configurable
session lifetimes, opaque session inspection and revocation, plus an interactive
operator password reset that revokes every session without touching notebook
content. M19P7 adds password-first TOTP with a one-step clock-skew window,
single-use TOTP steps, hashed atomic recovery codes, locally rendered enrollment
QR codes, and AES-256-GCM secret encryption using a separate private application
key. Enrollment and replacement remain pending until the new factor verifies
and recovery-code storage is confirmed. M19P8 completes explicit disabled-mode
warnings and migration guidance; every mode transition invalidates all local
authentication artifacts and never alters notebook repositories. M19P9 adds
the complete unauthenticated-route matrix, adversarial MFA/session tests,
browser/PWA lifecycle tests, authenticated container persistence/recovery smoke
coverage, and the documented OWASP-oriented review. No Alpha 2 image may be
released unless those checks and the vulnerability gates pass for the exact
candidate.
