# RepoQuill 0.1.0-alpha.2.security.2

This document is the operator and maintainer checklist for the RepoQuill
0.1.0-alpha.2.security.2 release.

Alpha 2 keeps canonical notes as ordinary Markdown and assets in ordinary Git
repositories while adding single-owner authentication, optional TOTP MFA,
guided Git conflict resolution, safer notebook onboarding, recoverable Trash,
note history, portable internal links, image inspection and presentation sizes,
and clearer synchronization details.

## Security and deployment model

`REPOQUILL_AUTH_MODE=local` is the fail-closed default. It provides one owner
password, persistent server-side sessions, CSRF/origin protection, progressive
credential throttling, session revocation, operator password recovery, and
optional TOTP MFA with recovery codes. It is access control, not note
encryption. OIDC and multi-user accounts are not implemented.

`REPOQUILL_AUTH_MODE=disabled` is an explicit operator decision. Use it only on
a constrained LAN/VPN or behind deliberately managed external protection. Mode
changes invalidate local authentication artifacts and require setup again when
returning to `local`.

Neither mode terminates TLS. Internet-facing deployments must use an HTTPS
reverse proxy, keep the backend unreachable from untrusted networks, retain
secure cookies, and configure only the proxy's exact address or smallest
dedicated CIDR in `REPOQUILL_TRUSTED_PROXIES`.

## Fresh installation

1. Select the immutable image tag or digest from the GitHub prerelease. Do not
   use `latest`, which RepoQuill does not publish during alpha.
2. Mount a persistent named volume or host directory at `/data` and start the
   container with the hardened Compose settings from `README.md`.
3. In another trusted terminal create the 15-minute, single-use setup token:

   ```sh
   docker compose exec repoquill repoquill auth bootstrap-token
   ```

4. Open RepoQuill through HTTPS, enter the token, and choose an owner password
   of at least 15 characters.
5. Create or use an existing private Git repository. In GitHub copy **Code →
   SSH**, let RepoQuill generate a dedicated key, add only its public key under
   **Settings → Deploy keys**, enable **Allow write access**, review the host
   fingerprint, test the connection, and connect the notebook.
6. Open and edit a note, wait for **Saved on this server**, synchronize, and
   verify the resulting commit at the Git provider.

The managed private key remains below `/data/keys`. GitHub is not required;
compatible GitLab, Forgejo, Gitea, and other SSH remotes use the same underlying
provider-independent flow.

## Upgrade procedure

1. Stop editing and let any intended synchronization finish.
2. Record the currently running immutable image tag and digest.
3. Stop RepoQuill and create a restorable backup of the complete `/data` volume.
   Confirm it contains `app`, `keys`, `notebooks`, and any legacy `repos` tree.
4. Pull the new immutable image and replace only the container. Do not delete or
   replace its `/data` mount.
5. Start RepoQuill and verify authentication metadata migration completed. A
   failed, corrupt, or unsupported migration must stop startup rather than
   silently disabling authentication.
6. Sign in again if the upgrade invalidated a session. Verify configured session
   lifetimes, MFA, notebook registrations, managed keys, trusted hosts, working
   trees, Trash, note history, and image presentation metadata as applicable.
7. Open an existing note, save a harmless change, synchronize it, and confirm
   the remote commit. Also verify the installed PWA receives the new application
   shell and returns to RepoQuill login if its session has expired.

Authentication reset or migration never rewrites Markdown or assets. The auth
database and MFA encryption key are application metadata, not canonical notes.

## Candidate preflight

Before creating an immutable tag, maintainers must:

1. Make the chosen version identical in the frontend package and lockfile,
   Docker build defaults and OCI label, changelog release section, this heading,
   Git tag, GitHub release title, and image tags.
2. Require protected CI, CodeQL, Dependabot, secret scanning, `govulncheck`,
   `npm audit`, Trivy, container hardening, architecture, runtime, and
   persistence gates to pass for the exact source-SHA candidate digest without
   an expired exception.
3. Exercise a fresh `/data` volume and a sanitized representative Alpha 1 data
   copy, including bootstrap, login, session expiry/renewal, password recovery,
   TOTP/recovery codes, notebook onboarding, Git synchronization, conflict
   review, and PWA reauthentication.
4. Confirm Markdown serialization, image upload/paste, original-image lightbox,
   presentation sizes, internal links, version history, Trash, search, tabs,
   mobile layout, and all destructive confirmations.
5. Prove container replacement preserves data and that rollback with the
   matching backup restores an operable installation.
6. Create a new `vMAJOR.MINOR.PATCH-alpha.NUMBER` tag. Never reuse or move an
   immutable Git or image tag.

The tag-gated workflow builds and pushes one immutable multi-architecture
source-SHA candidate with its SBOM/provenance, resolves its digest, and validates
both `linux/amd64` and `linux/arm64` from that exact digest. Only after both
architecture scans and smoke tests pass does it attach the immutable version
and moving `0.1.0-alpha` aliases to the same manifest and create the signed
GitHub attestation. A failed candidate remains unpromoted. After success, update
the repository variable `REPOQUILL_LATEST_ALPHA_VERSION` to the new immutable
version without `v`.

## Synchronization and conflict recovery

**Saved on this server** means the Markdown file reached RepoQuill's persistent
storage. **Synchronized** means the resulting Git changes were committed and
successfully transferred to the configured remote. One does not imply the
other.

Automatic triggers can run on schedule, after editing inactivity, at startup or
focus, during note/notebook navigation, and best-effort at browser close. A
browser may terminate before the close request completes, so this is not a
backup guarantee.

When external and RepoQuill edits overlap, synchronization pauses without
force-pushing. The normal workflow is **Synchronization → Review affected
items**. RepoQuill preserves **Your version** and **Other version**, supports
guided Markdown, delete/modify, rename/move, image, and binary decisions, and
creates a recovery point before applying a complete review. Postponing is safe.

Draft decisions, including a manually combined note, stay only in the current
tab's `sessionStorage` to survive an accidental reload. Logout, session expiry,
or closing that browser session removes them; Git remains the durable source for
both preserved versions.

Use `git status` and a normal Git client only as an administrator fallback for a
repository state the guided flow cannot represent or if the working tree was
manually altered outside RepoQuill. Preserve `/data` before emergency repair and
never delete it merely to clear an error.

## Rollback and independent recovery

If an upgrade fails, stop the new container and preserve its state for diagnosis.
Restore the pre-upgrade `/data` backup when application metadata is not backward
compatible, then run the previously recorded immutable image tag or digest. Do
not point an older binary at newer metadata it cannot understand.

If RepoQuill itself cannot start, mount or copy `/data` and access notebook
working trees below `/data/notebooks/<id>` directly. They remain normal Git
repositories with Markdown and assets. Lost notebook registration can be rebuilt
after first preserving those directories. Lost managed SSH keys require new
deploy keys at the Git provider but do not destroy notes.

Password recovery:

```sh
docker compose exec -it repoquill repoquill auth reset-password
```

MFA recovery when both authenticator and recovery codes are unavailable:

```sh
docker compose exec repoquill repoquill auth reset-mfa
```

Both operations revoke sessions and change authentication metadata only. They
never modify notebook repositories.
