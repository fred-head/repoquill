# RepoQuill Security Policy

## Supported versions

RepoQuill is currently alpha software. Only the most recent published alpha is
eligible for security fixes. Older alpha builds are unsupported and should be
upgraded rather than exposed for continued use.

## Alpha security model

Alpha 2 provides fail-closed single-owner local authentication with optional
TOTP MFA. It has no registration, usernames, roles, email recovery, multi-user
authorization, or note encryption. `REPOQUILL_AUTH_MODE=disabled` deliberately
removes this boundary and is safe only when the operator constrains access by a
private network, VPN, or external protection.

Authentication does not replace transport security. HTTPS termination and
restricted backend reachability remain required for Internet-facing instances.
OIDC is deferred and is not an implemented Alpha 2 authentication mode.

The supplied Compose configuration publishes port 8080 on `127.0.0.1` by default. Set `REPOQUILL_PUBLISH_ADDR` only when deliberate network exposure is protected separately.

## Security boundaries

- Markdown files and assets remain inside the configured notebook working tree.
- Symlinks, traversal paths, absolute paths, `.git`, and `node_modules` are rejected or excluded from note operations.
- Local-auth sessions use server-side state, confined secure cookies, and a
  session-bound CSRF token. Mutations also enforce exact request origins.
- Forwarded IP and scheme headers are ignored unless the direct peer matches an
  explicitly configured `REPOQUILL_TRUSTED_PROXIES` address or CIDR.
- Notebook onboarding accepts SSH repository URLs only. Embedded credentials, local paths, option-like values, unsafe protocols, and malformed branches are rejected.
- SSH host keys require explicit fingerprint review and strict host verification.
- Managed private keys stay below `/data/keys`, use restrictive permissions, and are never returned by the API.
- Git failures do not roll back successfully saved Markdown files. RepoQuill
  never force-pushes or silently chooses a conflict winner; its guided review
  preserves both versions and requires an explicit owner decision.
- Local password and MFA recovery revoke sessions and change only authentication
  metadata. They never rewrite, encrypt, or delete notebook content.
- The PWA is online-first. Its service worker caches the application shell, never API responses or note contents.
- Unsaved reauthentication recovery and in-progress conflict decisions are
  limited to tab-scoped `sessionStorage`. Conflict decisions are cleared when
  authentication ends; neither mechanism stores credentials or creates an
  offline note database.

`REPOQUILL_ALLOW_LOCAL_REMOTES=true` exists only for isolated automated tests. Do not enable it in a deployed instance.

## Repository security controls

The public source repository uses layered controls for proposed changes:

- GitHub Actions may run only GitHub-owned actions and the explicitly allowed
  Docker, Aqua Security, and Gitleaks actions. Every action reference must use a
  full commit SHA.
- Pull requests targeting `main` must pass the backend, frontend, repository
  secret, and hardened container gates against the current branch state.
- CodeQL default setup scans Go, JavaScript/TypeScript, and GitHub Actions on
  pull requests, protected-branch changes, and its weekly schedule. The Extended
  query suite is enabled, and new High or Critical security findings block
  merging.
- Secret scanning, push protection, Dependabot alerts, and Dependabot security
  update proposals are enabled. Dependency pull requests are never merged or
  deployed automatically.
- Force-pushes and deletion of `main` are blocked. Review conversations must be
  resolved before merging, and the ruleset has no bypass actor.

Scanner findings are triaged with their data flow and existing validation in
view. Alerts are not bulk-suppressed merely to make a check pass; any dismissal
must retain a specific technical justification in GitHub's audit trail.

The complete dependency-review, exception, remediation, credential-rotation,
and coordinated-disclosure process is documented in
[SECURITY-MAINTENANCE.md](SECURITY-MAINTENANCE.md).

## Operator responsibilities

- Protect and back up the complete `/data` volume. It contains working trees, notebook registration, trusted SSH hosts, and managed private keys.
- Terminate TLS at the reverse proxy, keep the backend unreachable from
  untrusted networks, and configure only the actual proxy addresses as trusted.
- Keep the container image, reverse proxy, host OS, and Git provider patched.
- Verify SSH fingerprints through an independent trusted source before approval.
- Use dedicated deploy keys with access limited to the intended repository.
- Resolve reported overlaps through RepoQuill's guided conflict review, inspect
  the optional technical details when troubleshooting, and keep independent
  backups in addition to the Git remote.
- Do not mount arbitrary host directories or a Docker socket into the container.
- Prefer note-owned local assets when opening a notebook from an untrusted
  source. Ordinary Markdown can contain external image URLs that contact their
  server when rendered.

## Reporting a vulnerability

Do not open a public issue containing credentials, private repository details,
note contents, or an exploitable proof of concept. Use
[GitHub private vulnerability reporting](https://github.com/fred-head/repoquill/security/advisories/new)
and include the affected version, impact, reproduction conditions, and suggested
mitigation if known. Remove real credentials and private note contents from the
report whenever they are not essential to reproduction.

If private vulnerability reporting is temporarily unavailable, do not publish
the report as an issue. Wait for the private channel to be restored or contact
the maintainer through a separately verified private channel.

This is alpha software. Security controls reduce known risk but are not a guarantee that defects do not exist.
