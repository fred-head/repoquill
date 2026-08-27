# Local authentication setup foundation

Status: Milestone 19 Phase 2 backend foundation. The responsive setup/login UI
arrives in M19P5, and deny-by-default session enforcement arrives in M19P3.
Do not treat this intermediate development branch as a completed authentication
release.

## Operator-controlled bootstrap

A fresh `local` installation starts with `setupRequired: true`. Visiting the
HTTP service does not create an owner and the server never prints a setup secret
in its normal logs. While setup is required, every notebook, file, asset,
search, Git, SSH, settings, cleanup, and maintenance API is blocked. Only the
static application shell, liveness, minimal auth status, and token-authorized
setup endpoint remain reachable.

The operator creates a one-time token from a trusted container or host terminal:

```sh
docker compose exec repoquill repoquill auth bootstrap-token
```

The command writes the plaintext token exactly once to its own terminal. The
database stores only a SHA-256 digest of 32 random bytes. Creating another token
invalidates the previous one; a token expires after 15 minutes and is consumed
atomically with successful password setup. No token can be created after setup
has completed or while authentication is disabled.

The setup frontend added in M19P5 will submit the token and the chosen password
to `POST /api/auth/setup`. `GET /api/auth/status` exposes only the configured
mode and whether setup is required. Neither endpoint exposes credential,
notebook, Git, SSH, host, or owner metadata.

## Password policy and storage

RepoQuill accepts pasted passphrases, Unicode, and leading or trailing
whitespace without modification. It requires at least 12 Unicode characters
and rejects inputs larger than 1024 UTF-8 bytes before password hashing. It
does not impose composition rules or scheduled password changes.

Passwords use Argon2id from `golang.org/x/crypto/argon2` with:

```text
algorithm version: 19 (0x13)
memory:            65536 KiB (64 MiB)
iterations:        3
parallelism:       2
salt:              16 random bytes per hash
derived key:       32 bytes
```

The memory and iteration profile follows
[RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html)'s constrained-memory
recommendation and exceeds the
[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
minimum. Parallelism is tuned for a small two-vCPU self-hosted container. A
RepoQuill container should have at least 128 MiB available; 256 MiB or more is
recommended when Git operations and image handling overlap authentication. The
implementation uses the maintained
[`golang.org/x/crypto/argon2`](https://pkg.go.dev/golang.org/x/crypto/argon2)
package rather than a RepoQuill-specific cryptographic implementation.

Algorithm version, costs, salt, and derived hash are stored separately so a
successful future login can transparently replace weaker parameters with the
current profile and a fresh salt. Password plaintext is never stored or logged.
Derived values are compared in constant time. A missing credential still runs
the same Argon2id profile before returning the same authentication error, while
oversized inputs are rejected before hashing to bound unauthenticated resource
consumption.

Run the local benchmark on release hardware with:

```sh
go test -run '^$' -bench BenchmarkArgon2idDefaultParameters ./internal/auth
```

Release review should keep a single derivation comfortably below one second on
the minimum supported CPU while retaining at least the documented memory-hard
profile. Any cost reduction requires a security review; increases are applied
through the transparent upgrade path.

## Transitional limitation

M19P2 protects the restricted first-run state but deliberately does not
implement sessions. After setup completes, the general deny-by-default session
boundary remains an M19P3 responsibility. Alpha 2 remains release-blocked until
all M19 phases and the adversarial M19P9 gate are complete.
