# RepoQuill

RepoQuill is a self-hosted browser interface for ordinary Git-backed Markdown repositories. Markdown files and regular assets remain the canonical data, so a notebook stays usable without RepoQuill.

> **Alpha software:** `0.1.0-alpha.1` is intended for evaluation and careful
> self-hosted testing. Back up the complete `/data` volume, pin deployments to
> an immutable version, and review the [known limitations](KNOWN-LIMITATIONS.md)
> before using RepoQuill with important notebooks.

This repository contains the RepoQuill notes workspace: a Go HTTP backend, a React/TypeScript/Vite frontend, a secure repository API, a live Milkdown editor with autosave and responsive editing controls, file and folder operations, screenshot/image insertion, deliberate unused-asset cleanup, provider-independent Git synchronization with isolated SSH credentials, search, a responsive online-first PWA, Docker packaging, and CI.

On mobile, use the menu button in the note header to open the notebook drawer. Supporting browsers offer an in-app **Install app** action when RepoQuill meets their installation requirements and is served over HTTPS (or localhost). The service worker caches only the application shell; note contents and API responses are not cached for offline editing. If the browser or backend connection is unavailable, RepoQuill shows an explicit offline warning and editing/synchronization should wait until connectivity returns.

## Run with Docker

Requirements: Docker with the Compose plugin.

After the first public alpha is published, use either the immutable release tag:

```yaml
image: ghcr.io/fred-head/repoquill:0.1.0-alpha.1
```

or the moving convenience channel for the newest successful 0.1.0 alpha:

```yaml
image: ghcr.io/fred-head/repoquill:0.1.0-alpha
```

Published images support `linux/amd64` and `linux/arm64`. RepoQuill does not
publish `latest` during alpha and does not yet claim 32-bit ARM support.

```sh
docker compose up --build
```

Open <http://localhost:8080>. The named `repoquill-data` volume is mounted at `/data`. The backward-compatible directly configured notebook remains at `/data/repos`, cloned notebooks live below `/data/notebooks`, and the active-notebook registry is stored below `/data/app`.

Compose publishes only to `127.0.0.1` by default. This is appropriate for local use or a reverse proxy on the same host. If a protected proxy requires a different bind address, set `REPOQUILL_PUBLISH_ADDR` deliberately; never use a public bind without external HTTPS authentication.

The application expects the repository at `/data/repos`. To test with an existing host repository, use a bind mount instead of the named volume:

```yaml
volumes:
  - /absolute/path/to/your/notes:/data/repos
```

The application needs write access for autosave and file operations. Use a dedicated notes repository and ensure its files are owned by the container user when using Docker.

To use an explicit host directory instead, replace the volume in `compose.yaml` with a bind mount such as `./data:/data`. Keep that directory backed up and persistent across container replacement.

## Local development

Requirements: Go 1.26+, Node.js 20.19+ or 22+, and npm.

The convenient development launcher prepares the local data directories, installs frontend dependencies when needed, and starts the Go backend plus Vite together:

```sh
./scripts/dev.sh
```

It uses a disposable, Git-ignored notebook below `testdata/demo-notes` by default
and creates a minimal welcome note when that directory does not exist. Pass
another existing notebook directory when needed:

```sh
./scripts/dev.sh /absolute/path/to/notes
```

Open <http://localhost:5173> and press `Ctrl+C` to stop both processes. `make dev` runs the same launcher.

The equivalent manual setup is shown below.

In one terminal:

```sh
mkdir -p .repoquill-data/app .repoquill-data/notebooks .repoquill-data/keys
touch .repoquill-data/keys/known_hosts
chmod 700 .repoquill-data/keys
chmod 600 .repoquill-data/keys/known_hosts

REPOQUILL_REPOSITORY=/absolute/path/to/your/notes \
REPOQUILL_NOTEBOOKS_DIR="$PWD/.repoquill-data/notebooks" \
REPOQUILL_NOTEBOOK_METADATA="$PWD/.repoquill-data/app/notebooks.json" \
REPOQUILL_KEYS_DIR="$PWD/.repoquill-data/keys" \
REPOQUILL_SSH_KNOWN_HOSTS="$PWD/.repoquill-data/keys/known_hosts" \
go run ./cmd/repoquill
```

Keep `.repoquill-data` persistent during local development. It contains cloned working trees, notebook registration, and server-side managed SSH private keys. The directory is ignored by Git.

In another:

```sh
cd frontend
npm install
npm run dev
```

Vite serves the frontend on <http://localhost:5173> and proxies `/api` calls to the Go backend on port 8080.

### Local test notebook

The development launcher creates `testdata/demo-notes` locally when needed.
This directory is intentionally ignored by Git and excluded from Docker builds,
so notes, screenshots, and image metadata created during testing cannot become
part of a release accidentally. Delete the directory whenever you want a fresh
local notebook, or pass an explicit notebook path to the launcher.

Only Markdown files below `REPOQUILL_REPOSITORY` are exposed. `.git`, `node_modules`, non-Markdown files, symlinks, absolute paths, and traversal attempts are excluded or rejected. Existing Markdown files can be edited; saves use an atomic filesystem replacement and a version check to prevent silent overwrites after external changes.

Milestone 3 uses conventional file-explorer selection. `New Note` and `New Folder` create inside the selected folder, beside a selected note, or at repository root when Root is selected. Rename, Move, and Delete are available from the desktop context menu and the touch-friendly toolbar overflow menu. Rename edits the name inline; Move uses a folder picker and never asks for a repository-relative destination path.

Folders start collapsed on first use. Their expanded state is retained across tree refreshes, file operations, and browser reloads. Creating an item inside a folder keeps that folder open. Moving is available through the context or overflow menu and its folder picker.

Moving or deleting a note also handles its conventional `<note>.assets` directory when present. Folder deletion recursively removes its contents and should be used carefully.

### Images and screenshots

With a note open, paste a screenshot or copied image directly into the editor. The `Insert image` button provides the equivalent file picker and offers camera/gallery choices on supported mobile browsers. PNG, JPEG, GIF, and WebP images up to 10 MiB are accepted.

For a note such as `Network/BGP.md`, RepoQuill saves the image as a normal file below `Network/BGP.assets/` and inserts portable Markdown such as:

```markdown
![Screenshot](BGP.assets/4c31a5f2c80f4bc1.png)
```

The browser uses a confined asset endpoint to display that relative path while editing. The stored Markdown and image remain independently usable in other Markdown applications. Removing an image from the document does not automatically delete its file; conservative cleanup avoids accidental data loss.

### Edit safety and auto-lock

An open note can be explicitly switched between `Edit` and `Read only` in the note header. Read-only mode disables typing, deletion, paste, image insertion, and image metadata changes while keeping scrolling and text selection available. This is a UI safety feature, not an access-control or encryption boundary, and it does not change the Markdown file.

The sidebar Settings dialog offers optional auto-lock intervals of Off, 1, 5, 15, or 30 minutes. Auto-lock responds only to document-changing editor activity; scrolling, pointer movement, and text selection do not reset it. The preference is stored in browser local storage, while each newly opened note starts in Edit mode.

### Formatting toolbar

Milestone 4.1 provides a compact, horizontally scrollable editor toolbar for undo/redo, paragraph and Heading 1–6 conversion, bold, italic, strikethrough, inline code, code blocks, bullet/numbered/task lists, blockquotes, links, images, GFM tables, and horizontal rules. Table insertion uses a visual grid for choosing up to 10×10 cells. While the cursor is in a table, contextual controls add or delete rows and columns relative to the current cell or delete the complete table. Structural changes use the normal editor undo history and serialize as portable GFM Markdown. Active marks and block/list context are exposed through pressed states and the block selector. Mutation controls are unavailable in Read only mode.

Image upload now lives in the main toolbar. Selecting an image exposes a sticky contextual toolbar for editing alt text, uploading a replacement asset, or removing the Markdown image node. Replacement creates a new ordinary asset file and preserves the image position and alt text. Removal deliberately leaves the underlying asset file untouched. Formatting continues to serialize through Milkdown as ordinary CommonMark/GFM Markdown.

Milestone 9 adds slash commands to the same editor operations. Type `/` at the start of a text block or after whitespace, then continue typing to filter commands such as `/heading`, `/task`, `/code`, `/image`, or `/table`. Use the arrow keys and Enter, Escape to close, or select an entry directly with pointer or touch. The temporary slash query is removed before the selected operation runs, and only ordinary CommonMark/GFM Markdown is persisted.

Inside a code block, one Enter starts the next code line and two Enters intentionally create a blank line. A third consecutive Enter at the end exits the code block and places the cursor in a normal paragraph below it.

Inline code works both on selected text and as a typing mode at an empty cursor. Activate it from the toolbar or `/inline code`, type the code, then use the same toolbar action or Escape to return to normal text.

### Unreferenced asset cleanup

Milestone 4.2 adds `Settings → Maintenance → Scan` for reviewing unused PNG, JPEG, GIF, and WebP files in note-specific `.assets` directories. Scan results show repository-relative paths and file sizes. Files are selected explicitly and require a second confirmation before deletion.

The backend independently validates every submitted path and re-scans references before deleting each file. Referenced, ineligible, changed, or symlink-reached files are retained and reported. Only empty `.assets` directories are removed; non-selected files and non-empty directories remain. Cleanup changes the ordinary repository working tree but does not commit or push anything automatically.

### Notebook search

Use the search field above the notebook tree to find folders, Markdown filenames, and text inside notes. Content results include the matching line and a short excerpt; selecting a file or content result opens that note. Search is case-insensitive and limited to the active notebook. Git metadata, note asset folders, dependencies, symlinks, non-Markdown files, and oversized notes are excluded.

### Git synchronization

Milestone 5 keeps filesystem saving and Git synchronization separate. `Saved` means the Markdown file is on the persistent working tree; the adjacent Git status independently reports `Clean`, `Local changes`, `Remote changes`, `Synced`, `Sync failed`, or `Git conflict`. The explicit `Sync` action first finishes the current note save, commits working-tree changes as `Update notes`, fetches `origin`, rebases the active branch when required, and pushes without force.

Settings allows each browser/PWA installation to configure automatic Git behavior independently: scheduled sync (Off/5/15/30/60 minutes), sync after editing inactivity (Off/1/2/5/10 minutes), sync when RepoQuill opens, when a tab regains focus, in the background after opening another note, around notebook switching, and best-effort sync when closing a tab. Automatic sync uses the same serialized, conflict-safe commit/fetch/rebase/push service as the manual action; overlapping triggers share one in-flight operation rather than launching concurrent Git work. Note navigation waits only for any required local file save. Git network work then runs independently, and a clean sync from the last 45 seconds suppresses redundant note-switch fetches. Start/focus/note-open sync substantially reduces the stale-remote window after editing through GitHub or another clone, but cannot eliminate a true simultaneous edit conflict.

Notebook switching first autosaves the old note. When enabled, RepoQuill syncs the notebook being left, activates the target notebook, and then syncs the target so remote changes are pulled before normal work continues. A Git failure does not discard the local save or trap the user in the old notebook. Closing a browser is inherently different: browsers cannot wait for Git. RepoQuill therefore sends a small `keepalive` request, after which the backend completes the captured notebook's sync using its own timeout. This is best effort because the browser may terminate before even delivering the trigger; it is not presented as a backup guarantee. If editor content is still unsaved, RepoQuill shows the existing leave warning instead of pretending that Git sync can preserve it.

If fetch, authentication, or push fails, locally saved files remain usable. Rebase conflicts are preserved in the working tree, affected files are reported in the Git status, and automatic synchronization stops for manual resolution. RepoQuill never resets or force-pushes through a conflict.

`Add Notebook` can clone an existing repository URL and optional branch when `REPOQUILL_NOTEBOOKS_DIR` and `REPOQUILL_NOTEBOOK_METADATA` are configured. Docker Compose configures both on the persistent `/data` volume.

Notebook onboarding now lives in the notebook switcher beneath the RepoQuill title rather than in Settings. The switcher lists registered notebooks, marks the active one, and provides `Add Notebook` plus a lightweight `Manage Notebooks` details view. Switching first completes the existing local save path, then clears the previous note/tree state and loads the selected notebook without requiring a page reload. A pending Git sync does not block switching because locally saved and remotely synced remain separate states.

`Add Notebook` reuses the existing clone, SSH authentication, host-trust, and connection-test backend. It can generate a new per-notebook key or select an existing unassigned managed key with its creation date and SHA256 fingerprint. Assigned keys are filtered from the selector and independently rejected by the backend. Settings retains editor, maintenance, managed-key, and SSH administration instead of duplicating notebook onboarding.

Milestone 5.1 recommends a dedicated RepoQuill-managed Ed25519 key. Generate it in the dialog, copy the displayed public key into the repository's deploy-key/access-key settings with read and write permission, test the connection, and then clone. Its private half is created below `/data/keys`, never returned by the HTTP API, and selected only for its associated notebook. A failed test or clone keeps the generated key available for retry. Existing operator-managed server SSH configuration remains available as an advanced option; RepoQuill does not accept uploads of personal private keys.

`Settings → Git / SSH` provides conservative managed-key administration. It lists the short key ID, creation time, notebook assignment, and public key, and allows the public half to be copied again. Keys assigned to a notebook cannot be deleted. Unused keys can be removed only after explicit confirmation; the backend rechecks notebook assignments and refuses deletion if registry integrity cannot be established or the key directory contains unexpected files. Removing an unused key deletes its server-side public/private key pair, so any corresponding deploy-key entry should also be removed from the Git provider.

SSH host verification is strict in both workflows. On first contact, RepoQuill discovers the host's presented public keys, displays their SHA256 fingerprints, and requires explicit approval before storing those exact keys in `/data/keys/known_hosts` (or the path configured by `REPOQUILL_SSH_KNOWN_HOSTS`). Discovery with `ssh-keyscan` does not verify identity: compare the displayed fingerprint with your Git provider or administrator through a trusted channel before choosing `Trust host`. RepoQuill then scans again, rejects a discovery/approval key change, persists the approved key, and retries the connection test.

RepoQuill deliberately does not silently trust a first connection or use `StrictHostKeyChecking=no`. A key that differs from an already trusted identity is shown as a higher-severity changed-host warning and cannot be replaced through the normal one-click flow. The connection remains blocked for administrator review. Host trust includes a non-default SSH port, so `host:22` and `host:2222` remain separate identities. The connection test continues to distinguish host trust, authentication failure, missing repository access, branch errors, and network errors. Read access is tested without modifying the remote; write access is finally verified by a normal non-force push.

For Docker with the named volume, approved host keys persist in `/data/keys/known_hosts`. With a bind-mounted `/data`, the trust store is available at `<host data directory>/keys/known_hosts`. Keep the entire `/data` volume persistent and backed up: notebook-specific private keys, approved host identities, and notebook associations must survive container replacement. Manual administrator editing is only expected when deliberately reviewing a changed or rotated trusted host key.

## Checks

```sh
go test ./...
go vet ./...
go test -race ./...
cd frontend && npm ci && npm run lint && npm test && npm run build && npm audit
```

With `govulncheck` and Docker installed, `make release-check` runs the complete
local release gate, including vulnerability audits, Compose validation, a clean
image build, non-root/read-only startup, health verification, and a container
replacement persistence test. GitHub CI additionally scans the complete Git
history with Gitleaks and the built image with Trivy. Release gates fail on
detected secrets or high/critical image vulnerabilities.

The production image builds the frontend and embeds it into a single Go application binary. Its runtime image also includes Git, OpenSSH, and CA certificates for later notebook synchronization work.

## Security

RepoQuill does not include authentication in V0.1. **Do not expose it directly to the public Internet.** Deploy it behind a trusted reverse proxy and authentication layer such as Authentik, Authelia, Keycloak, Cloudflare Access, or proxy-level basic authentication.

The backend rejects cross-site mutation requests, unsafe Git onboarding URLs, malformed branch names, path traversal, symlink escapes, unsupported uploads, and oversized bodies. Responses include a restrictive Content Security Policy and related browser protections. These controls are defense in depth and do not replace authentication.

If the public reverse proxy changes the request host, add the exact HTTPS origin to `REPOQUILL_TRUSTED_ORIGINS`; multiple origins are comma-separated. Do not enable `REPOQUILL_ALLOW_LOCAL_REMOTES` outside isolated automated tests.

See [SECURITY.md](SECURITY.md) for the threat model,
[ALPHA-RELEASE.md](ALPHA-RELEASE.md) for release and recovery procedures,
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) for alpha limitations, and
[CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.

## Data model

- One notebook maps to exactly one Git repository.
- Notes are UTF-8 `.md` files.
- Images and attachments are regular files stored alongside notes.
- SQLite may eventually hold application metadata, never canonical note content.

See [AGENTS.md](AGENTS.md) for the complete architecture and product constraints.

## License

Copyright 2026 fred-head.

RepoQuill is licensed under the
[Apache License 2.0](LICENSE). It is provided on an "AS IS" basis, without
warranties or conditions of any kind. The license text included in this
repository is authoritative.
