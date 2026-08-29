# RepoQuill

RepoQuill is a self-hosted note-taking app for plain Markdown notebooks backed
by Git. Write and organize notes from your browser, paste screenshots directly
into them, and keep the underlying Markdown files and assets fully portable.
Each notebook is an ordinary Git repository, so your notes remain readable and
versioned even without RepoQuill.

> **Alpha software:** RepoQuill is ready for careful self-hosted testing. Alpha
> 2 development includes a security-reviewed single-owner local authentication
> boundary. Each exact release candidate must still pass the complete CI,
> vulnerability-scan, container, and manual preflight gate before publication.
> Back up `/data`, pin a release version, and read the
> [known limitations](KNOWN-LIMITATIONS.md) before using important notebooks.

## Features

- Live rendered Markdown editing with CommonMark and GFM
- Folders, note creation, rename, move, recoverable Trash, and multiple open note tabs
- Formatting toolbar and keyboard-/touch-friendly slash commands
- Clipboard screenshot paste and mobile image selection
- Portable per-note `.assets` directories with explicit unused-asset cleanup
- Full-size image lightbox and optional responsive presentation sizes without changing Markdown or image files
- Multiple independent Git-backed notebooks
- Managed SSH deploy keys and explicit SSH host fingerprint approval
- Manual and configurable automatic commit, pull/rebase, and push workflows
- Conflict-safe saves with visible local-save and Git-sync status
- Guided conflict resolution for notes, deletions, renames, and images without requiring Git knowledge
- Note-focused Git version history with readable comparison and safe restore
- Portable internal note links with search, broken-link detection, and safe rename/move updates
- Full-text search across note names, folders, and Markdown content
- Responsive desktop/mobile UI, dark/light mode, and installable online-first PWA
- Fail-closed single-owner password authentication with optional TOTP MFA and session administration
- Multi-architecture Docker images for `linux/amd64` and `linux/arm64`

RepoQuill intentionally does not add a proprietary note database. Notes remain
ordinary UTF-8 `.md` files, and images remain ordinary files beside them.

## Quick start with Docker

The published alpha image is available from GitHub Container Registry:

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
      REPOQUILL_KEYS_DIR: /data/keys
      REPOQUILL_SSH_KNOWN_HOSTS: /data/keys/known_hosts
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

This secure deployment example expects an HTTPS reverse proxy. For a deliberate
localhost-only HTTP test, change `REPOQUILL_SESSION_COOKIE_SECURE` to `"false"`
before starting and open <http://localhost:8080>. Change it back to `"true"`
before serving RepoQuill through HTTPS.

Start it with:

```sh
docker compose pull
docker compose up -d
```

On the first start in `local` authentication mode, create the short-lived setup
token in a trusted terminal and enter it on the setup screen with your chosen
owner password:

```sh
docker compose exec repoquill repoquill auth bootstrap-token
```

The token is printed once and expires after 15 minutes. Later sign-ins need only
the password. New passwords require at least 15 characters and reject a small
local set of commonly guessed values. Security settings let the owner change
the password, configure session lifetimes, inspect browser sessions, and revoke
other devices. **Remember this device** extends the absolute session lifetime;
idle expiry and explicit revocation still apply. An expired browser or installed
PWA session returns to RepoQuill's login screen.

After signing in, choose **Add Notebook**. For the recommended GitHub flow:

1. Create or open a private GitHub repository.
2. Choose **Code → SSH** and copy the `git@github.com:…` address.
3. Enter it in RepoQuill and generate a dedicated managed SSH key.
4. Copy only the displayed public key to **Repository Settings → Deploy keys**
   and enable **Allow write access**.
5. Review the Git host fingerprint, test the connection, and choose
   **Connect notebook**.

The private key never leaves the RepoQuill server. GitHub is the guided beginner
path, but normal SSH repositories on GitLab, Forgejo, Gitea, and compatible Git
services are supported too. RepoQuill does not create the remote repository.

`REPOQUILL_SESSION_COOKIE_SECURE=true` is the safe default for an HTTPS reverse
proxy. For deliberate plain-HTTP localhost testing only, set it to `false`.
Internet-facing deployments must use TLS and explicitly configure only their
actual proxy addresses through `REPOQUILL_TRUSTED_PROXIES`; see the
[reverse-proxy security guide](docs/security/reverse-proxy.md).

The moving `0.1.0-alpha` image tag tracks the newest successful alpha in the
0.1.0 line. For controlled upgrades, replace it with the newest immutable tag
shown on the GitHub release or pin its digest. RepoQuill does not publish
`latest` during alpha, and immutable release tags are never moved or reused.

### Use a host directory for persistent data

To keep all data at a known host path, replace the named volume with a bind
mount:

```yaml
volumes:
  - /opt/docker/repoquill:/data
```

The container runs as an unprivileged user. Ensure that this user owns the host
directory and can write to it; do not solve permission errors with `chmod 777`.
Back up the complete directory because it contains notebook working trees,
registration and image-presentation metadata, authentication metadata and its
MFA encryption key, managed SSH keys, and trusted host identities.

### Important environment variables

| Variable | Purpose and safe default |
| --- | --- |
| `REPOQUILL_AUTH_MODE` | `local` by default; `disabled` explicitly removes the built-in access boundary. |
| `REPOQUILL_AUTH_METADATA` | Authentication SQLite database, normally `/data/app/auth.db`. |
| `REPOQUILL_AUTH_ENCRYPTION_KEY_FILE` | Optional MFA-key path; defaults beside `auth.db`. |
| `REPOQUILL_SESSION_COOKIE_SECURE` | Keep `true` behind HTTPS; use `false` only for plain-HTTP local development. |
| `REPOQUILL_TRUSTED_PROXIES` | Exact comma-separated proxy IPs/CIDRs whose forwarding headers may be trusted. |
| `REPOQUILL_TRUSTED_ORIGINS` | Optional exact public origins when proxy host rewriting requires them. |
| `REPOQUILL_NOTEBOOKS_DIR` | Managed notebook working trees, normally `/data/notebooks`. |
| `REPOQUILL_NOTEBOOK_METADATA` | Notebook registry, normally `/data/app/notebooks.json`. |
| `REPOQUILL_KEYS_DIR` | RepoQuill-managed SSH keys, normally `/data/keys`. |
| `REPOQUILL_SSH_KNOWN_HOSTS` | Explicitly approved SSH host identities. |
| `REPOQUILL_PUBLISH_ADDR` | Compose host bind address; defaults to `127.0.0.1`. |
| `REPOQUILL_ADDR` | Internal HTTP listen address; normally `:8080` and rarely changed. |

`REPOQUILL_REPOSITORY` and `REPOQUILL_NOTEBOOK_NAME` remain available for
legacy or local single-notebook operation. Normal deployments should use the
notebook registry. Never enable the test-only `REPOQUILL_ALLOW_LOCAL_REMOTES`
in a deployment.

## Local development and testing

Requirements:

- Go 1.26+
- Node.js 20.19+ or 22+
- npm

The development launcher prepares disposable local data and starts the Go
backend and Vite frontend together:

```sh
./scripts/dev.sh
```

Open <http://localhost:5173>. Pass an existing local notebook directory when
needed:

```sh
./scripts/dev.sh /absolute/path/to/notes
```

The default test notebook and runtime metadata live in Git-ignored local
directories. Press `Ctrl+C` to stop both processes.

To test the production container built from the current source instead:

```sh
docker compose up --build
```

## How notebook data is stored

Each RepoQuill notebook maps to one ordinary Git repository:

```text
Network/
├── BGP.md
├── BGP.assets/
│   └── 7baccbcda0bd134b.jpg
└── OSPF.md
```

Uploaded images use relative Markdown references such as:

```markdown
![](BGP.assets/7baccbcda0bd134b.jpg)
```

The repository can be cloned and edited with VS Code, Obsidian, GitHub, GitLab,
or another Markdown-capable application. Deleting RepoQuill does not make the
notes unreadable.

Selecting an image provides a non-destructive lightbox for viewing the original
and optional Small, Medium, Large, or Full inline presentation. Those sizes live
in RepoQuill metadata, not Markdown. They never resize or duplicate the asset;
other Markdown applications display the ordinary image using their own layout.

## Git synchronization

Saving and Git synchronization are deliberately separate:

- **Saved** means the Markdown file is safely written to persistent storage.
- **Synced** means changes were committed and pushed to the configured remote.

RepoQuill can synchronize manually, on a schedule, after inactivity, during
navigation, at startup/focus, and best-effort when a browser tab closes. It
fetches remote changes before pushing and never force-pushes through conflicts.
Note switching waits only for a required local save, not background Git work.

If edits from GitHub, VS Code, another Git client, or another editor overlap
with RepoQuill changes, synchronization pauses. Guided review preserves and
labels **Your version** and **Other version**, supports Markdown,
delete/modify, rename/move, and image decisions, and creates a recovery point
before applying the result. RepoQuill never silently chooses a winner. A normal
Git client remains an administrator fallback for unsupported or damaged Git
states, not the normal conflict workflow.

Automatic synchronization cannot prevent every overlap created by external
writers. A failed fetch or push never discards Markdown that was already saved
on the RepoQuill server.

## Security

Alpha 2 uses fail-closed single-owner local authentication by default, but it
does not provide TLS termination. **Never expose the backend port directly to
the public Internet.**
Terminate HTTPS at a reverse proxy and restrict backend reachability to that
proxy.

The supplied configuration binds to `127.0.0.1` by default. Configure the
proxy's exact address or smallest dedicated network through
`REPOQUILL_TRUSTED_PROXIES` before accepting forwarded IP or scheme headers.

If the owner password is forgotten, an operator with container/filesystem
administration can reset only the authentication credential:

```sh
docker compose exec -it repoquill repoquill auth reset-password
```

The command requires an interactive terminal, revokes every browser session,
and never modifies notebook repositories. Optional TOTP MFA can be enabled in
Security settings; its ten one-time recovery codes are shown only once. If the
authenticator and recovery codes are both lost, reset MFA separately:

```sh
docker compose exec repoquill repoquill auth reset-mfa
```

The TOTP secret is encrypted with `/data/app/auth.key`, outside SQLite. Back up
that file with `/data/app/auth.db`; neither contains notebook content. An
explicit `reset-mfa` quarantines a malformed key before generating its
replacement. See the
[local authentication guide](docs/security/local-authentication-setup.md).

`REPOQUILL_AUTH_MODE=disabled` is accepted only as an explicit operator choice
for localhost, a private LAN/VPN/Tailscale network, or deliberately configured
external protection. It is not inferred from proxy headers. Switching modes
invalidates all sessions, setup tokens, passwords, MFA, and recovery artifacts;
returning to `local` therefore requires a new bootstrap setup. Interactive
forward-auth can still expire independently and return HTML to the browser/PWA.
HTTPS and backend network isolation remain necessary in either mode.

OIDC is not implemented in Alpha 2. In `local` mode RepoQuill understands its
own browser and PWA session expiry. With an external interactive forward-auth
layer in `disabled` mode, that layer may still return HTML or redirects that
RepoQuill cannot convert into native reauthentication.

See [SECURITY.md](SECURITY.md) for the threat model, deployment responsibilities,
and private vulnerability reporting process.

## Upgrade, backup, and recovery

Before replacing an alpha image, stop editing, back up the complete `/data`
volume, and record the current immutable image tag or digest. Replace only the
container, retain the same `/data` mount, then verify login, notebooks, SSH host
trust, an existing note, and synchronization.

Authentication migrations or mode changes may invalidate sessions; they do not
change notebook content. The online-first service worker updates the application
shell after deployment, while API responses and notes remain network-only. If a
rollback needs older application metadata, restore the matching `/data` backup
before starting the previous immutable image.

If RepoQuill cannot start, directories below `/data/notebooks` remain ordinary
Git working trees containing readable Markdown and assets. Password and MFA
recovery change authentication metadata only. See the
[Alpha release guide](ALPHA-RELEASE.md) for the full operator checklist.

## Project documentation

- [Known alpha limitations](KNOWN-LIMITATIONS.md)
- [Security policy](SECURITY.md)
- [Security maintenance and vulnerability response](SECURITY-MAINTENANCE.md)
- [Alpha release and recovery guide](ALPHA-RELEASE.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Architecture and project constraints](AGENTS.md)

## Checks

```sh
go test ./...
go vet ./...
cd frontend
npm ci
npm run lint
npm test
npm run build
npm audit
```

CI additionally performs race detection, vulnerability and secret scanning,
container hardening checks, persistence smoke tests, and separate AMD64/ARM64
release validation.

## License

Copyright 2026 fred-head.

RepoQuill is licensed under the [Apache License 2.0](LICENSE) and is provided on
an "AS IS" basis, without warranties or conditions of any kind.
