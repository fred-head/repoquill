# RepoQuill

RepoQuill is a self-hosted, single-owner Markdown vault for the browser and
installable PWA. Notes are ordinary Markdown files and images are ordinary
files in the vault. The server filesystem is the canonical copy; devices read
and save through the same server while online. RepoQuill does not synchronize
separate device copies or provide offline editing.

> **Alpha software:** use a pinned release, keep operator-managed backups, and
> read [Known Limitations](KNOWN-LIMITATIONS.md) before storing important
> notes. The operator is responsible for backup, retention, and recovery.

## Features

- CommonMark and GFM editing, document outline, code blocks, task lists, and
  document statistics
- Folders, internal note links, search, rename and move previews, tabs, and
  recoverable Trash
- Clipboard screenshot paste, note-owned image assets, image cleanup, and
  non-destructive image presentation sizes
- Multiple named vault folders on one server
- Create a vault or adopt an existing folder under the configured vault root
- On-demand ZIP export of ordinary vault files
- Online-only note content with version-checked saves and explicit review when
  a browser draft conflicts with the current server file
- Responsive browser and PWA interface, local theme and layout preferences,
  and installable application shell
- Fail-closed, single-owner password authentication with optional TOTP MFA,
  session controls, and trusted reverse-proxy configuration
- Multi-architecture Docker images for `linux/amd64` and `linux/arm64`

## Quick start with Docker

```yaml
services:
  repoquill:
    image: ghcr.io/fred-head/repoquill:0.1.0-alpha
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - repoquill-data:/data
    environment:
      REPOQUILL_NOTEBOOKS_DIR: /data/notebooks
      REPOQUILL_NOTEBOOK_METADATA: /data/app/notebooks.json
      REPOQUILL_AUTH_MODE: local
      REPOQUILL_AUTH_METADATA: /data/app/auth.db
      REPOQUILL_AUTH_ENCRYPTION_KEY_FILE: /data/app/auth.key
      REPOQUILL_SESSION_COOKIE_SECURE: "true"
      # Set only to the exact address/CIDR of your reverse proxy network.
      # REPOQUILL_TRUSTED_PROXIES: 172.20.0.0/24
      # Set only if the proxy rewrites the browser-visible origin.
      # REPOQUILL_TRUSTED_ORIGINS: https://notes.example.com
    read_only: true
    tmpfs:
      - /tmp:rw,nosuid,nodev,noexec,size=64m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true

volumes:
  repoquill-data:
```

The example expects an HTTPS reverse proxy. For a localhost-only HTTP test,
set `REPOQUILL_SESSION_COOKIE_SECURE` to `"false"` and open
<http://localhost:8080>. Restore `"true"` before serving RepoQuill through
HTTPS. Never expose the backend port directly to the public Internet.

Start the service:

```sh
docker compose pull
docker compose up -d
```

On first start with local authentication, create the one-time setup token in a
trusted terminal and enter it on the setup screen with your owner password:

```sh
docker compose exec repoquill repoquill auth bootstrap-token
```

The token is shown once and expires after 15 minutes. Passwords require at
least 15 characters. Security settings let the owner change the password,
configure session lifetimes, inspect sessions, enable TOTP MFA, and revoke
other devices.

After signing in, create a vault or adopt an existing direct child folder under
`REPOQUILL_NOTEBOOKS_DIR`. Adoption keeps the existing Markdown and assets in
place. A legacy `.git` directory is left untouched and is not used by the
application. Its old commits may still contain deleted notes or secrets.

The vault is now available from other devices by signing into the same server.
The browser does not keep a local note replica or queue edits for later. If the
server becomes unavailable, unsaved text stays only in that open browser
session and is not reported as saved.

The running alpha image tag is convenient for upgrades; use an immutable
release tag or digest when you need a fixed version. Alpha releases do not
publish a `latest` tag.

### Persistent storage and environment

Back up the complete `/data` volume. It contains vaults, the vault registry,
authentication metadata, and the separate MFA encryption key. The operator
must choose backup schedule, retention, off-site storage, and restore testing.
The ZIP export is a portable copy initiated by the owner; it is not an
automatic backup and does not contain authentication data or Trash.

| Variable | Purpose and safe default |
| --- | --- |
| `REPOQUILL_AUTH_MODE` | `local` by default; `disabled` removes built-in authentication. |
| `REPOQUILL_AUTH_METADATA` | Authentication database, normally `/data/app/auth.db`. |
| `REPOQUILL_AUTH_ENCRYPTION_KEY_FILE` | MFA key path; defaults beside `auth.db`. |
| `REPOQUILL_SESSION_COOKIE_SECURE` | Keep `true` behind HTTPS; use `false` only for localhost HTTP testing. |
| `REPOQUILL_TRUSTED_PROXIES` | Exact proxy IPs/CIDRs allowed to supply forwarding headers. |
| `REPOQUILL_TRUSTED_ORIGINS` | Exact public origins when proxy host rewriting requires them. |
| `REPOQUILL_NOTEBOOKS_DIR` | Vault storage root, normally `/data/notebooks`. |
| `REPOQUILL_NOTEBOOK_METADATA` | Vault registry, normally `/data/app/notebooks.json`. |
| `REPOQUILL_DEV_VAULT_PATH` | Optional initial vault path used by `scripts/dev.sh`; omit in production. |
| `REPOQUILL_NOTEBOOK_NAME` | Optional display name for the legacy single-vault path. |
| `REPOQUILL_PUBLISH_ADDR` | Compose host bind address; defaults to `127.0.0.1`. |
| `REPOQUILL_ADDR` | Internal HTTP listen address; normally `:8080`. |

`REPOQUILL_AUTH_MODE=disabled` is only suitable for localhost, a private
LAN/VPN, or a deliberately configured external access boundary. It is not
inferred from proxy headers.

## Storage, export, and deletion

A vault is a normal directory of Markdown notes, folders, and assets:

```text
Network/
├── BGP.md
├── BGP.assets/
│   └── 7baccbcda0bd134b.jpg
└── OSPF.md
```

Uploaded images use relative Markdown links such as
`![](BGP.assets/7baccbcda0bd134b.jpg)`. Vault files remain usable with Obsidian,
VS Code, and other Markdown applications. Image presentation sizes are
application metadata; they do not resize or duplicate the original asset.

Use **Manage Vaults → Export ZIP** to download the active or another registered
vault. Export preserves relative paths and file bytes. It excludes `.git`
internals, Trash, symlinks, dependency directories, and application/auth data.
Archive import is not supported; to add a vault, place its folder beneath the
configured root and adopt it in the app.

Moving an item to Trash is recoverable in the app. Emptying Trash or permanent
deletion removes the item from the active vault, but operator backups may keep
older copies. Deleting a note reference does not automatically delete its
image assets; unused-asset cleanup is a separate, explicit operation.

When two browser sessions edit the same note, the server rejects a stale save.
The open browser draft and current server version remain available for an
explicit choice or a manually edited combined version. RepoQuill does not
create an in-app version history or retain a hidden save archive. Recovery
after app-level deletion depends on operator backups.

## Security

RepoQuill provides single-owner local authentication by default, optional TOTP
MFA, session expiry and revocation, and trusted-proxy controls. It does not
provide multiple users or roles, and it does not terminate TLS. Put it behind a
TLS reverse proxy and restrict backend reachability to that proxy. See the
[reverse-proxy guide](docs/security/reverse-proxy.md) and
[local-authentication guide](docs/security/local-authentication-setup.md).

If the owner password is forgotten, an operator can reset the credential:

```sh
docker compose exec -it repoquill repoquill auth reset-password
```

To reset MFA separately:

```sh
docker compose exec repoquill repoquill auth reset-mfa
```

Back up `/data/app/auth.db` and `/data/app/auth.key` together. Authentication
recovery changes do not modify vault files. Report security issues privately as
described in [SECURITY.md](SECURITY.md).

## Upgrade from a Git-backed RepoQuill release

1. Before stopping the old container, save open notes and resolve any recovery-draft or conflict
   prompt in the old browser app. The new release clears legacy browser-stored
   note drafts at startup; browser storage is not part of the `/data` backup.
2. Stop the old container and back up the complete `/data` volume.
3. Replace the image while keeping the same `/data` mount and metadata paths.
4. Sign in and verify each registered vault, existing notes, and assets.
5. Review the migration notice for every vault that contains `.git`.

The new app reads and writes the existing registered vault directories as
ordinary folders. It does not run Git or SSH, and it does not modify or remove
legacy `.git` directories or stored SSH key files. Old commits can still
contain content that was deleted from the current vault, including secrets.
On first startup, old remote URLs, branch settings, and SSH-key assignments are
removed from the vault registry; the referenced key files themselves remain.
The app cannot erase those commits or copies retained by operator backups.
Review and remove legacy data only under an operator-managed migration and
backup plan. The new application does not provide Git history or remote sync.

The PWA caches the application shell only. API responses, note files, and image
assets use no-store/network-only handling. If a rollback requires prior
application metadata, restore the matching `/data` backup before starting the
older image. See [ALPHA-RELEASE.md](ALPHA-RELEASE.md) for the operator checklist.

## Local development and testing

Requirements: Go 1.26+, Node.js 24 LTS, and npm.

```sh
./scripts/dev.sh
```

For local authentication, create a setup token in another terminal:

```sh
REPOQUILL_AUTH_METADATA="$PWD/.repoquill-data/app/auth.db" \
  go run ./cmd/repoquill auth bootstrap-token
```

Then open <http://localhost:5173>. To pass an existing folder for local
development, use `./scripts/dev.sh /absolute/path/to/notes`. See
[Development and testing](docs/development/testing.md) for focused checks.

## Project documentation

- [Known alpha limitations](KNOWN-LIMITATIONS.md)
- [Git-free reboot roadbook](docs/roadmap/git-free-reboot.md)
- [Alpha 3 roadmap](docs/roadmap/alpha3-candidates.md)
- [Security policy](SECURITY.md)
- [Security maintenance](SECURITY-MAINTENANCE.md)
- [Alpha release and recovery guide](ALPHA-RELEASE.md)
- [Architecture and code map](docs/architecture.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
