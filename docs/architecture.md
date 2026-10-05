# RepoQuill architecture

This is a code map and current data-flow summary. For user-facing behavior and
deployment, see [`../README.md`](../README.md). For security details, use the
focused guides under [`security/`](security/).

## Data boundaries

- A notebook is a Git working tree. Markdown notes, note-owned `.assets`
  directories, and other repository files remain normal filesystem content.
- The filesystem is authoritative for the server's saved note state. Git
  records and synchronizes that state; it is not part of the editor save path.
- Notebook registration and image-presentation preferences are application
  metadata. Authentication state uses a separate SQLite database. Neither is
  canonical note content.
- The browser editor serializes to Markdown. API writes carry a content version;
  the backend rejects stale versions and writes accepted content atomically.
- Git synchronization fetches and integrates remote work after local changes
  are saved. A conflict pauses sync for an explicit decision; a remote failure
  does not undo a successful local save.

## Code map

| Area | Responsibility | Start here |
| --- | --- | --- |
| `cmd/repoquill/` | Process startup, configuration, and operator auth commands | `main.go` |
| `internal/app/` | HTTP routes, middleware, notebook registry, presentation metadata | `handler.go`, `notebooks.go` |
| `internal/files/` | Confined note/filesystem operations, assets, links, search, trash, cleanup | `repository.go`, `root.go` |
| `internal/git/` | Git CLI, sync state, conflicts/history, SSH keys and host trust | `service.go`, `conflicts.go`, `ssh.go` |
| `internal/auth/` | Local/disabled mode, credentials, sessions, MFA, proxy identity | `config.go`, `service.go` |
| `frontend/src/` | React application, API client, editor, and browser state | `App.tsx`, `api.ts`, `components/editor/MarkdownEditor.tsx` |
| `web/` | Embeds the built frontend into the Go application | `embed.go` |

## Change tracing

- Note editing crosses `frontend/src/`, `/api/repository/file` in
  `internal/app/handler.go`, and `internal/files/repository.go`.
- Image insertion crosses the editor/API client and `internal/files/assets.go`;
  image presentation preferences are separate metadata in
  `internal/app/presentations.go`.
- Filesystem path and destructive-operation safeguards live in
  `internal/files/`; read its scoped `AGENTS.md` before changing those paths.
- Git behavior is implemented in `internal/git/` and exposed through
  `internal/app/handler.go`. Read its scoped `AGENTS.md` for sync and conflict
  constraints.
- Authentication behavior spans `internal/auth/` and the route boundary in
  `internal/app/handler.go`. The current threat model and deployment details
  are in `docs/security/authentication-architecture.md` and
  `docs/security/reverse-proxy.md`.

Prefer the existing package boundaries. Check the adjacent tests before
changing a cross-package flow; do not infer current API shape from the archived
initial project plan.
