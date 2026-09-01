# RepoQuill

RepoQuill is a self-hosted note-taking app for plain Markdown notebooks backed
by Git. Write and organize notes from your browser, paste screenshots directly
into them, and keep the underlying Markdown files and assets fully portable.
Each notebook is an ordinary Git repository, so your notes remain readable and
versioned even without RepoQuill.

> **Alpha software:** RepoQuill is ready for careful self-hosted testing, but it
> does not yet include built-in authentication. Back up `/data`, pin a release
> version, and read the [known limitations](KNOWN-LIMITATIONS.md) before using it
> with important notebooks.

## Features

- Live rendered Markdown editing with CommonMark and GFM
- Folders, note creation, rename, move, delete, and multiple open note tabs
- Formatting toolbar and keyboard-/touch-friendly slash commands
- Clipboard screenshot paste and mobile image selection
- Portable per-note `.assets` directories with explicit unused-asset cleanup
- Multiple independent Git-backed notebooks
- Managed SSH deploy keys and explicit SSH host fingerprint approval
- Manual and configurable automatic commit, pull/rebase, and push workflows
- Conflict-safe saves with visible local-save and Git-sync status
- Full-text search across note names, folders, and Markdown content
- Responsive desktop/mobile UI, dark/light mode, and installable online-first PWA
- Multi-architecture Docker images for `linux/amd64` and `linux/arm64`

RepoQuill intentionally does not add a proprietary note database. Notes remain
ordinary UTF-8 `.md` files, and images remain ordinary files beside them.

## Quick start with Docker

The published alpha image is available from GitHub Container Registry:

```yaml
services:
  repoquill:
    image: ghcr.io/fred-head/repoquill:0.1.0-alpha.1.security.2
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - repoquill-data:/data
    environment:
      REPOQUILL_NOTEBOOKS_DIR: /data/notebooks
      REPOQUILL_NOTEBOOK_METADATA: /data/app/notebooks.json
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

Start it with:

```sh
docker compose pull
docker compose up -d
```

Open <http://localhost:8080>, choose **Add Notebook**, and connect an existing
SSH Git repository. RepoQuill can generate a dedicated deploy key and guides
you through approving the Git host fingerprint.

The moving `0.1.0-alpha` image tag tracks the newest successful alpha in the
0.1.0 line. Pin `0.1.0-alpha.1.security.2` or the published digest when
reproducibility is more important than automatic alpha updates. RepoQuill does
not publish `latest` during alpha.

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
registration metadata, managed SSH keys, and trusted host identities.

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

## Git synchronization

Saving and Git synchronization are deliberately separate:

- **Saved** means the Markdown file is safely written to persistent storage.
- **Synced** means changes were committed and pushed to the configured remote.

RepoQuill can synchronize manually, on a schedule, after inactivity, during
navigation, at startup/focus, and best-effort when a browser tab closes. It
fetches and rebases before pushing and never force-pushes through conflicts. A
conflict stops automatic synchronization and leaves the working tree available
for deliberate resolution with a normal Git client.

## Security

RepoQuill has no built-in authentication or TLS termination. **Never expose it
directly to the public Internet.** Put it behind HTTPS and a trusted
authentication layer such as Authentik, Authelia, Keycloak, Cloudflare Access,
or a protected reverse proxy.

The supplied configuration binds to `127.0.0.1` by default. If a reverse proxy
changes the public request origin, configure the exact HTTPS origin through
`REPOQUILL_TRUSTED_ORIGINS`.

See [SECURITY.md](SECURITY.md) for the threat model, deployment responsibilities,
and private vulnerability reporting process.

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
