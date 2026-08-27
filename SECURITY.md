# RepoQuill Security Policy

## Supported versions

RepoQuill is currently alpha software. Only the most recent published alpha is
eligible for security fixes. Older alpha builds are unsupported and should be
upgraded rather than exposed for continued use.

## Alpha security model

The published Alpha 1 line has no built-in authentication. Anyone who can reach
an Alpha 1 HTTP interface can read, change, delete, and synchronize every
configured notebook and administer RepoQuill-managed SSH credentials.

Alpha 2 development adds fail-closed single-owner local authentication. Until
the complete Milestone 19 browser, recovery, MFA, and adversarial release gates
are finished, development builds must not be treated as a production security
release. HTTPS termination and restricted backend reachability remain required
even with built-in authentication.

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
- Git failures do not roll back successfully saved Markdown files. Force-push and automatic conflict resolution are not used.
- The PWA is online-first. Its service worker caches the application shell, never API responses or note contents.

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
- Keep the container image, reverse proxy, host OS, Git provider, and authentication layer patched.
- Verify SSH fingerprints through an independent trusted source before approval.
- Use dedicated deploy keys with access limited to the intended repository.
- Review Git conflicts manually and keep independent backups in addition to the Git remote.
- Do not mount arbitrary host directories or a Docker socket into the container.

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
