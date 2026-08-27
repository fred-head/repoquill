# RepoQuill single-owner authentication architecture

Status: Milestone 19 architecture decision. The operator-authorized password
setup foundation is implemented by M19P2 and the persistent server-side session
boundary by M19P3; CSRF enforcement, throttling, browser/PWA login, recovery,
and TOTP are added by later phases.
Alpha 2 must not be published until the complete M19 security gate passes.

## Decision and scope

RepoQuill owns one authentication boundary for one fixed internal principal,
`owner`. It does not provide registration, usernames, multiple users, roles,
email addresses, invitations, organizations, or email recovery.

Supported modes are:

- `local`: recommended and fail-closed default. A new or migrated database has
  `setup_completed = false` until the operator-authorized setup in M19P2.
- `disabled`: accepted only when the operator explicitly sets
  `REPOQUILL_AUTH_MODE=disabled`. Later phases show a persistent warning and
  invalidate local authentication artifacts when modes change.

An absent or empty mode never means public access. It resolves to `local` so an
existing Alpha 1 installation enters the restricted setup migration path once
the API boundary is enabled. A missing database is recreated only in this
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
- narrowly scoped future setup-status, bootstrap setup, login, and auth-status
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
throttling state atomically and resets setup completion. Later phases add an
operator-only recovery command requiring filesystem/container administration.
Recovery changes authentication metadata only; it never moves, encrypts,
deletes, or rewrites notebook repositories.

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
trusted proxy. The browser/PWA login screens, recovery, and MFA remain later M19
phases, so no Alpha 2 image may be released before all M19 phases and adversarial
tests pass.
