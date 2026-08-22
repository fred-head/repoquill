# AGENTS.md

# Project: Git-Backed Markdown Notes

## 1. Purpose

This project is a self-hosted, browser-based notes application whose canonical data store is a normal Git repository containing plain Markdown files and regular image/assets files.

The application should feel closer to a lightweight mix of Obsidian and Trilium, while preserving a fundamentally portable data model.

The core product idea is:

> The application is an interface for ordinary Git-backed Markdown repositories, not the owner of the user's notes.

A notebook maps to exactly one Git repository.

The application may maintain internal metadata for configuration, UI state, sync state, or notebook registration, but user note content MUST remain fully usable without this application.

---

# 2. Non-Negotiable Design Principle

The following rule is the most important rule in the entire project:

> The application must never require itself to recover, interpret, migrate, or export user note content.

If the application is permanently deleted, the user must still be able to:

- clone the repository,
- browse its folders,
- open Markdown files in any editor,
- read images and attachments,
- edit the repository with VS Code, Obsidian, GitHub, GitLab, or any other Markdown-capable tool.

Any future feature that breaks this guarantee must not be implemented in that form.

The Git repository is the canonical source of truth.

The web application is replaceable.

---

# 3. Primary Goals

The application MUST provide:

- browser-based access,
- responsive desktop and mobile UI,
- PWA support,
- a hierarchical folder/file tree,
- Markdown notes stored as real `.md` files,
- live WYSIWYG-style Markdown editing,
- common formatting controls,
- clipboard screenshot/image insertion,
- image upload from mobile devices,
- notebook separation via independent Git repositories,
- full-text search,
- Git synchronization,
- simple sync status reporting,
- self-hosted deployment,
- no mandatory built-in authentication layer in V0.1.

The application SHOULD feel simple and fast.

It must not become a general-purpose productivity platform.

---

# 4. Explicit Non-Goals

Do NOT implement the following in V0.1 unless explicitly requested:

- graph view,
- knowledge graphs,
- backlinks,
- bidirectional relationships,
- databases,
- Notion-style collections,
- Kanban boards,
- task management systems,
- calendars,
- AI features,
- embeddings,
- vector databases,
- chat with notes,
- collaborative editing,
- multiple concurrent backend writers,
- CRDTs,
- Y.js,
- WebRTC collaboration,
- WebSockets unless truly required,
- PostgreSQL for note content,
- MongoDB for note content,
- object storage as the primary note store,
- S3 as the primary note store,
- GraphQL,
- Redis,
- microservices,
- Kubernetes-specific architecture,
- built-in account registration,
- password reset,
- MFA,
- local password authentication,
- OAuth provider implementation,
- plugin systems,
- themes marketplace,
- public sharing platform,
- publishing engine,
- mobile-native apps,
- offline editing,
- automatic repository creation through GitHub/GitLab APIs.

Do not add infrastructure merely because it is common in modern web applications.

Prefer boring, explicit, understandable solutions.

---

# 5. Initial Technology Stack

## Frontend

Use:

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui where useful
- Milkdown as the preferred Markdown editor
- ProseMirror-based extensions where appropriate
- `vite-plugin-pwa` or an equivalent lightweight PWA integration

Do not switch editor frameworks without a concrete technical reason.

Tiptap may be evaluated only if Milkdown proves unsuitable for required editor behavior.

Do not use CodeMirror as the primary editing experience because the product should provide rendered, live WYSIWYG-style editing rather than Markdown source editing.

A raw Markdown/source mode may be added later as an optional feature.

---

## Backend

Use:

- Go
- standard library where practical
- minimal third-party dependencies
- regular filesystem APIs
- regular `git` CLI invocation

The backend should preferably build into one application binary.

Do not add Node.js to the backend unless there is a compelling technical requirement.

---

# 6. Deployment Model

The intended deployment model is:

```text
Browser / PWA
      |
      | HTTPS
      v
Reverse Proxy / External Auth
      |
      v
Notes Application
      |
      v
Local Git Working Trees
      |
      v
GitHub / GitLab / Forgejo / Gitea / other Git remote
```

The application should be deployable as a single Docker container.

The container should contain:

- the compiled backend,
- the compiled frontend,
- the `git` executable,
- required CA certificates,
- minimal runtime dependencies.

Notebook repositories should live on a persistent mounted volume.

Example:

```text
/data/
├── app/
│   └── metadata.db
└── repos/
    ├── 01ABCDEF...
    ├── 01GHIJKL...
    └── 01MNOPQR...
```

The application itself must not depend on ephemeral container storage for important data.

---

# 7. Notebook Model

A notebook is exactly one Git repository.

Examples:

```text
Private       -> git@github.com:user/private-notes.git
Work          -> git@gitlab.example.com:user/work-notes.git
Homelab       -> git@github.com:user/homelab-docs.git
```

The application must support multiple notebooks.

Each notebook must be independently configurable.

Required notebook metadata may include:

```json
{
  "id": "01ABC...",
  "name": "Private",
  "localPath": "/data/repos/01ABC...",
  "remoteUrl": "git@github.com:user/private-notes.git",
  "branch": "main"
}
```

Additional internal metadata is allowed where useful.

User notes must never be stored in this metadata database.

---

# 8. Internal Metadata Database

SQLite is allowed for application metadata.

SQLite MAY contain:

- registered notebooks,
- notebook names,
- repository URLs,
- default branches,
- local repository paths,
- last successful sync timestamps,
- UI preferences,
- application configuration,
- optional cached search metadata.

SQLite MUST NOT contain canonical note contents.

SQLite MUST NOT contain the only copy of user images or attachments.

Deleting the SQLite database must not destroy the user's notes.

---

# 9. Repository Structure

There is no mandatory global note hierarchy beyond regular folders and files.

Example:

```text
Network/
├── BGP.md
├── BGP.assets/
│   ├── 01ABC.png
│   └── 01DEF.png
├── OSPF.md
└── OSPF.assets/
    └── 01GHI.png

Linux/
├── Debian.md
└── Docker.md
```

Markdown files are ordinary UTF-8 text files.

Directories are ordinary filesystem directories.

---

# 10. Asset Model

Prefer per-note asset directories.

For:

```text
Network/BGP.md
```

use:

```text
Network/BGP.assets/
```

for note-owned images.

Example Markdown:

```markdown
## Topology

![](BGP.assets/01ABCDEF.png)
```

Benefits:

- asset ownership is obvious,
- note deletion can remove its asset directory,
- note movement can move its asset directory,
- notes remain portable,
- no global opaque media database is needed.

Asset filenames should preferably use:

- ULID,
- UUID,
- or another collision-resistant identifier.

Preserving the original filename may be considered later.

---

# 11. Asset Ownership Rules

In V0.1, an asset should belong to exactly one Markdown note.

This simplifies lifecycle management.

When a note is deleted:

- delete its `.md` file,
- delete the corresponding `.assets` directory if present.

When a note is moved:

- move the `.md` file,
- move its `.assets` directory with it.

When a note is renamed:

- rename the note,
- rename the asset directory accordingly where safe,
- update relative Markdown links when required.

When an image reference is removed from a note:

- automatic deletion of the now-unreferenced asset MAY be implemented,
- but this must be conservative,
- never delete a file if reference ownership is uncertain.

A later garbage-collection feature may detect unreferenced assets.

Data safety is more important than automatic cleanup.

---

# 12. Editor Requirements

The main editor must provide a live rendered Markdown editing experience.

The user should normally see:

- rendered headings,
- bold text,
- italic text,
- inline code,
- code blocks,
- lists,
- links,
- tables,
- images,
- blockquotes,
- horizontal rules,

while editing.

The user should not normally need to switch between "source" and "preview".

The persisted representation must still be Markdown.

Editor state must serialize cleanly back to Markdown.

Avoid proprietary syntax where possible.

If custom syntax becomes necessary, it must degrade gracefully when opened outside this application.

---

# 13. Formatting Toolbar

The editor should eventually provide a formatting toolbar.

Suggested controls:

- Undo
- Redo
- Heading
- Bold
- Italic
- Strikethrough
- Inline code
- Code block
- Link
- Image
- Bullet list
- Numbered list
- Task list
- Quote
- Table
- Horizontal rule

V0.1 does not require every control immediately.

Core formatting should be implemented first.

Toolbar buttons must work with text selection and cursor context.

---

# 14. Slash Commands

Slash commands are planned but are not required for the earliest usable build.

Typing:

```text
/
```

should eventually open a command picker.

Examples:

```text
/heading
/code
/table
/image
/quote
/list
/task
```

Typing a prefix should filter commands.

Example:

```text
/co
```

could show:

- Code block
- Inline code

The slash-command architecture should support custom snippets later.

Example future snippet:

```text
/iptable
```

could insert:

```markdown
| Hostname | IP | VLAN |
|----------|----|------|
|          |    |      |
```

Do not implement a full plugin system merely to support slash commands.

---

# 15. Screenshot and Image Paste

Clipboard image paste is a core V0.1 feature.

Desktop flow:

```text
Ctrl+V
  |
  v
Clipboard contains image/png
  |
  v
Frontend detects image
  |
  v
Upload to backend
  |
  v
Backend stores file in note asset directory
  |
  v
Backend returns relative path
  |
  v
Editor inserts Markdown image
  |
  v
Image renders immediately
```

The user should not need to:

- save the screenshot manually,
- browse for the screenshot file,
- type Markdown image syntax,
- choose an asset directory.

Mobile should support:

- image selection,
- camera/gallery upload where supported by the browser,
- touch-friendly insertion.

Clipboard support on mobile may vary by browser and must not be the only image workflow.

---

# 16. File Tree

Desktop layout:

```text
+------------------+------------------------------------+
| Notebooks / Tree | Toolbar                            |
|                  +------------------------------------+
| Private          |                                    |
|   Network        |                                    |
|     BGP.md       |             Editor                 |
|     OSPF.md      |                                    |
|   Linux          |                                    |
|                  |                                    |
+------------------+------------------------------------+
```

The file tree must support:

- nested folders,
- nested Markdown files,
- create note,
- create folder,
- rename,
- delete,
- move,
- expand/collapse,
- refresh.

Desktop may support drag-and-drop.

Drag-and-drop must not be the only way to move content.

---

# 17. Mobile UI

Mobile must be treated as a first-class supported interface.

Do not simply compress the desktop layout.

Default mobile layout:

```text
+---------------------------+
| Menu | Note title | More  |
+---------------------------+
|                           |
|          Editor           |
|                           |
+---------------------------+
| B | I | Code | List | +   |
+---------------------------+
```

The notebook/file tree should open as a drawer or sheet.

Requirements:

- touch-friendly targets,
- no hover-only functionality,
- file operations available through menus,
- usable with mobile software keyboards,
- editor remains visible when keyboard opens,
- toolbar must not consume excessive screen height,
- tables may horizontally scroll if required.

Test responsive behavior at common phone widths.

---

# 18. PWA Requirements

The frontend must support installation as a PWA.

V0.1 PWA goals:

- installable,
- standalone window mode,
- responsive icon and manifest,
- appropriate app metadata,
- service worker,
- reliable loading of frontend assets.

V0.1 is ONLINE-FIRST.

Do NOT implement offline editing initially.

Offline editing introduces:

- synchronization queues,
- conflict resolution,
- concurrent history,
- local persistence complexity.

These concerns are intentionally deferred.

When offline, the application should fail clearly and safely rather than pretending edits are synced.

---

# 19. File Save Behavior

Editor changes should be autosaved.

Suggested behavior:

```text
Typing
  |
  v
500-1000 ms debounce
  |
  v
PUT updated Markdown
  |
  v
Backend writes file atomically
```

Use safe file-write patterns where practical.

Avoid partial file corruption.

The UI should expose local/server save state.

Suggested status labels:

```text
Saving...
Saved
Save failed
```

---

# 20. Git Synchronization

Git synchronization is separate from file saving.

This distinction matters.

"Saved" means:

> The Markdown file has been successfully written to the application server's persistent filesystem.

"Synced" means:

> The changes have been committed and successfully pushed to the configured Git remote.

Suggested statuses:

```text
Saved
Syncing...
Synced
Sync failed
Conflict
```

Do not present "Saved" as "Synced".

---

# 21. Git Implementation

Use the installed system `git` executable.

Do not implement Git internals unless absolutely necessary.

Expected operations include:

```text
git clone
git status
git add
git commit
git fetch
git pull --rebase
git push
git log
```

Wrap Git invocation in a clear backend service.

Capture:

- stdout,
- stderr,
- exit code,
- operation type.

Never expose arbitrary shell execution through API inputs.

Repository paths and Git arguments must be validated.

Avoid shell interpolation.

Use direct process argument execution.

---

# 22. Sync Strategy

Do not commit on every keystroke.

Suggested model:

```text
Editor change
   |
   v
Autosave file
   |
   v
Short inactivity period
   |
   v
Git sync job
```

An initial implementation may use:

- 30-60 second inactivity debounce,
- explicit manual sync button,
- sync when switching notes,
- sync when closing or changing notebooks.

Exact behavior may evolve after real-world use.

Avoid excessive meaningless Git commits.

---

# 23. Commit Messages

Commit messages should be understandable.

Examples:

```text
Update Network/BGP.md
Add Linux/Docker.md
Delete Private/Todo.md
Rename OSPF.md to OSPF Routing.md
Update notes
```

An aggregate periodic commit is acceptable.

Do not require the user to understand Git staging for normal use.

Git should be mostly invisible in the primary UX.

---

# 24. Remote Changes and Conflicts

Even with one application backend, remote changes may happen through:

- GitHub,
- GitLab,
- code-server,
- local Git clients,
- another editor.

Before pushing, fetch or rebase as appropriate.

If an automatic rebase succeeds:

- continue sync.

If a conflict occurs:

- STOP automatic sync,
- preserve all user data,
- report the conflict clearly,
- do not silently choose local or remote content.

V0.1 conflict handling may simply pause sync and require manual repository resolution.

Future UI may offer:

- Keep local
- Keep remote
- Open conflict editor

Do not build a complex merge editor before the core application works.

---

# 25. Concurrency Model

V0.1 assumes:

> One active backend application instance owns a notebook working tree.

Do not design for multiple simultaneous backend writers.

Do not add distributed locks.

Do not add CRDTs.

Do not add collaborative cursors.

Multiple browser tabs/users talking to the same backend may happen, but real-time collaborative editing is not a goal.

Prevent obvious accidental overwrites where practical.

A file version/hash check may be added later.

---

# 26. Search

Initial search should be simple.

Preferred V0.1 implementation:

- `ripgrep` if available,
- or a lightweight Go filesystem text search.

Search should cover:

- filenames,
- folder names,
- Markdown contents.

Return:

- notebook,
- relative path,
- matching line or excerpt.

Do not build Elasticsearch.

Do not build a vector search system.

Do not build semantic search in V0.1.

---

# 27. Authentication and Security

V0.1 should NOT implement a local authentication system.

The intended deployment is behind a trusted authentication layer such as:

- Authentik,
- Authelia,
- Keycloak,
- Cloudflare Access,
- reverse-proxy basic auth,
- another trusted identity-aware proxy.

The application must document clearly:

> Do not expose the application directly to the public Internet without an appropriate authentication layer.

Future versions may support OIDC.

Avoid implementing password handling, MFA, password recovery, WebAuthn, or local account lifecycle unless there is a strong future requirement.

---

# 28. Repository Credentials

Git credentials require careful handling.

Preferred approaches:

- SSH deploy keys,
- mounted SSH keys,
- SSH agent where practical,
- provider tokens supplied through environment variables or secrets,
- credential helper if explicitly configured.

Do not store plaintext tokens inside note repositories.

Do not commit secrets.

Do not expose credentials through frontend APIs.

Do not log secret tokens.

---

# 29. Path Security

All filesystem API calls must defend against path traversal.

Never trust user-supplied paths.

Reject attempts involving:

```text
../
..\
absolute paths
symlink escapes
```

All note operations must remain inside the configured notebook root.

Resolve and validate paths before filesystem operations.

Symlinks should either:

- be disabled,
- ignored,
- or explicitly constrained to remain inside the repository root.

Data safety and host security take priority over symlink flexibility.

---

# 30. API Shape

Prefer a boring REST API.

Suggested initial routes:

```text
GET    /api/health

GET    /api/notebooks
POST   /api/notebooks
GET    /api/notebooks/:id
DELETE /api/notebooks/:id

GET    /api/notebooks/:id/tree

GET    /api/notebooks/:id/files/*
PUT    /api/notebooks/:id/files/*
POST   /api/notebooks/:id/files/*
DELETE /api/notebooks/:id/files/*

POST   /api/notebooks/:id/move

POST   /api/notebooks/:id/assets

GET    /api/notebooks/:id/search?q=

GET    /api/notebooks/:id/git/status
POST   /api/notebooks/:id/git/sync
```

Route structure may evolve.

Do not introduce GraphQL without a specific demonstrated need.

---

# 31. Suggested Backend Modules

Keep backend boundaries explicit.

Suggested packages/services:

```text
internal/
├── app/
├── config/
├── notebooks/
├── files/
├── assets/
├── git/
├── search/
├── database/
└── httpapi/
```

Responsibilities:

## notebooks

- register notebook,
- clone repository,
- validate notebook configuration,
- resolve notebook root.

## files

- list tree,
- read Markdown,
- write Markdown,
- create,
- delete,
- move,
- rename.

## assets

- save clipboard images,
- determine note asset directory,
- validate media type,
- delete assets safely.

## git

- clone,
- status,
- commit,
- fetch,
- pull/rebase,
- push,
- sync state,
- conflict reporting.

## search

- query notebook content,
- format results.

Do not create abstractions for hypothetical future storage engines.

---

# 32. Suggested Frontend Structure

A possible structure:

```text
src/
├── app/
├── components/
│   ├── editor/
│   ├── file-tree/
│   ├── notebook-switcher/
│   ├── toolbar/
│   ├── search/
│   └── sync-status/
├── hooks/
├── api/
├── state/
├── pwa/
└── types/
```

Keep state management simple.

Use React state/context first.

Do not introduce Redux or another global state library unless complexity actually requires it.

---

# 33. Error Handling

Errors must be visible and understandable.

Never silently lose edits.

Important errors include:

- file save failure,
- repository unavailable,
- invalid path,
- Git authentication failure,
- remote unavailable,
- merge conflict,
- image upload failure,
- disk full,
- repository dirty/invalid state.

Prefer explicit user-facing states over silent retries.

Automatic retry is acceptable for transient failures where safe.

---

# 34. Logging

Backend logging should include:

- startup,
- notebook operations,
- file write failures,
- Git operation result,
- sync failures,
- conflict detection,
- malformed requests,
- security-related path rejection.

Do not log note contents by default.

Do not log credentials.

Do not log complete sensitive HTTP bodies.

---

# 35. Backup Philosophy

Git remote is a major durability mechanism but should not be described as the only possible backup.

The application itself does not own backup policy.

Because notebooks are normal Git repositories, users can additionally:

- clone them elsewhere,
- back up repository volumes,
- mirror repositories,
- use GitHub/GitLab backup workflows.

The application should never make backup harder.

---

# 36. Git Provider Independence

Core Git functionality must be provider-independent.

The following must work with any normal compatible Git remote:

- clone,
- pull,
- commit,
- push.

Provider-specific integrations belong in optional layers.

Future providers may include:

- GitHub,
- GitLab,
- Forgejo,
- Gitea.

Do not couple the core notebook model to GitHub-specific APIs.

---

# 37. Future Provider Integration

A later version may support:

```text
Create Notebook
    |
    +-- Existing Git Repository
    |
    +-- Create on GitHub
    |
    +-- Create on GitLab
    |
    +-- Create on Forgejo/Gitea
```

Provider integrations may create remote repositories through provider APIs.

This is NOT required for V0.1.

V0.1 should accept an existing Git remote URL.

---

# 38. Notebook Creation - V0.1

Initial workflow:

```text
Create notebook

Name:
[ Private ]

Repository:
[ git@github.com:user/private-notes.git ]

Branch:
[ main ]

[ Clone and Add ]
```

Backend:

1. validate input,
2. create notebook ID,
3. clone repository into `/data/repos/<id>`,
4. register metadata,
5. return notebook,
6. render repository tree.

Local-only repositories may be considered later.

---

# 39. UX Principles

The application should feel like a notes application, not an IDE.

Prefer:

- clean content area,
- minimal chrome,
- quick navigation,
- readable typography,
- obvious save/sync status,
- keyboard-friendly desktop use,
- touch-friendly mobile use.

Git concepts should stay mostly out of the primary workflow.

Avoid requiring users to think about:

- staging,
- index,
- detached HEAD,
- rebasing,
- refspecs.

Expose technical Git information only when needed for troubleshooting.

---

# 40. Accessibility

Use accessible components.

Requirements should include:

- keyboard navigation,
- visible focus states,
- semantic controls,
- ARIA labels where required,
- reasonable contrast,
- no essential hover-only actions.

Mobile and keyboard usability are both important.

---

# 41. Testing Strategy

Do not attempt perfect test coverage immediately.

Prioritize tests for destructive or security-sensitive behavior.

Backend tests should cover:

- path traversal prevention,
- note create/read/write/delete,
- move/rename,
- asset ownership,
- notebook root confinement,
- Git command argument handling,
- sync error handling.

Frontend tests should prioritize:

- core file-tree behavior,
- editor loading/saving,
- image insertion,
- mobile drawer behavior,
- save/sync status rendering.

End-to-end tests may be added after the primary workflow stabilizes.

---

# 42. Data Safety Rules

These rules override convenience:

1. Never silently overwrite known conflicting remote content.
2. Never delete assets unless ownership is sufficiently certain.
3. Never write outside a notebook repository.
4. Never store canonical notes only in application metadata.
5. Never discard unsaved editor contents because of a failed Git operation.
6. Git sync failure must not imply file save failure.
7. Deleting the application must not make notebooks unreadable.
8. Destructive operations should be deliberate.
9. Prefer recoverable behavior where practical.
10. Do not hide serious synchronization failures.

---

# 43. V0.1 Definition

V0.1 should be intentionally small.

A successful V0.1 allows a user to:

1. run the application in Docker,
2. connect an existing private Git repository,
3. browse folders and Markdown files,
4. create folders,
5. create notes,
6. open a note,
7. edit it in a live rendered Markdown editor,
8. format basic text,
9. paste a screenshot,
10. save changes,
11. search notes,
12. commit and push changes,
13. use the interface on desktop,
14. install/use it as a PWA on mobile.

That is enough for an alpha.

---

# 44. Recommended Development Milestones

## Milestone 0 - Repository Bootstrap

Create:

- Go backend,
- React/TypeScript/Vite frontend,
- Docker build,
- basic CI,
- basic README,
- this AGENTS.md.

Goal:

```text
docker compose up
```

shows the application.

---

## Milestone 1 - Filesystem Browser

Backend:

- open configured local repository,
- list directory tree,
- read Markdown file.

Frontend:

- display tree,
- open note,
- show note contents.

No editing required yet.

---

## Milestone 2 - WYSIWYG Markdown Editor

Add Milkdown.

Requirements:

- render Markdown while editing,
- load Markdown from backend,
- serialize back to Markdown,
- save file.

Test carefully that Markdown does not become unnecessarily reformatted or corrupted.

---

## Milestone 3 - File Operations

Implement:

- create note,
- create folder,
- rename,
- delete,
- move.

Ensure all path-security rules exist before exposing these operations.

---

## Milestone 4 - Image and Screenshot Paste

Implement:

- clipboard image detection,
- upload endpoint,
- per-note asset directory,
- Markdown insertion,
- immediate rendering,
- mobile image picker/upload.

This milestone makes the application genuinely useful.

---

## Milestone 4.1 - Core Editor Toolbar

Consolidate common Markdown editing actions into one compact toolbar while
keeping Markdown as the canonical representation.

Requirements:

- undo and redo,
- paragraph and Heading 1-6 selector with active block feedback,
- bold, italic, strikethrough, inline code, and code block,
- bullet, numbered, and task lists,
- blockquote, link, image, GFM table, and horizontal rule,
- active states that are accessible and not communicated through color alone,
- contextual image and table actions shown only for the selected object,
- a sticky desktop toolbar and a touch-friendly responsive mobile layout,
- no editor mutation while the note is in Read only mode,
- all changes flow through the existing autosave and status-bar behavior.

Image insertion must retain clipboard paste, file/mobile selection, per-note asset
directories, upload validation, secure serving, and portable relative paths.
Removing an image node must not automatically delete its asset.

Tables remain ordinary GFM tables. Do not add formulas, sorting, filtering,
typed cells, or database behavior.

Completion criteria:

- core formatting is available without typing Markdown syntax,
- toolbar and contextual controls serialize to portable Markdown,
- desktop, mobile, keyboard, and Read only behavior are tested,
- no proprietary document state or duplicate standalone image action is added.

---

## Milestone 4.2 - Unreferenced Asset Cleanup

Add a deliberate maintenance workflow for reviewing and deleting unused image
assets without weakening the conservative asset lifecycle.

Requirements:

- scan only supported images inside note-specific `.assets` directories,
- resolve ordinary relative Markdown references, including encoded and
  angle-bracket paths,
- treat ambiguous ownership or references as in use,
- exclude symlinks and anything outside the active notebook,
- show path and size for each candidate,
- require explicit selection and a second confirmation before deletion,
- revalidate every candidate immediately before deletion to prevent races,
- retain referenced, changed, unsupported, uncertain, or invalid files,
- remove only asset files selected by the user and empty resulting directories,
- report deleted, retained, and failed items clearly,
- keep cleanup separate from editor image removal and Git synchronization,
- support desktop and mobile/PWA interaction.

Cleanup produces ordinary Git-visible filesystem deletions but must never commit
or push automatically.

Completion criteria:

- referenced assets are not offered or deleted intentionally,
- uncertain files are retained,
- path traversal and symlink escapes are blocked,
- cleanup remains reviewable, explicit, and tested.

---

## Milestone 5 - Git Basics

Implement provider-independent synchronization using the system Git executable.

Requirements:

- clone and register an existing SSH repository,
- report clean, dirty, remote-change, failure, and conflict states,
- commit working-tree changes, fetch, rebase, and push without force,
- keep local file save separate from Git synchronization,
- preserve local files when authentication, network, rebase, or push fails,
- stop automatic synchronization on conflict,
- sanitize credentials and sensitive diagnostics,
- use direct process arguments and disable repository hooks,
- support managed per-notebook SSH keys and existing server SSH configuration,
- require explicit SSH host fingerprint approval,
- validate remote URLs, branches, key IDs, repository paths, and Git arguments.

Do not expose staging concepts or implement a merge editor for V0.1.

---

## Milestone 6 - Multiple Notebooks and Sync Triggers

A notebook remains exactly one Git repository with an independent working tree,
remote, branch, and credential association.

Requirements:

- persistent notebook registration and active-notebook selection,
- notebook switcher with Add and Manage workflows,
- switching completes any required local save before replacing editor state,
- Git failure must not trap navigation or discard saved content,
- configurable browser-local scheduled, inactivity, startup, focus,
  note-switch, notebook-switch, and best-effort tab-close sync triggers,
- serialize overlapping sync requests and avoid redundant recent clean syncs,
- run note-navigation Git work in the background,
- pull remote changes before normal work where configured,
- preserve and report conflicts instead of choosing local or remote content.

Browser-close synchronization is best effort and must never be described as a
backup guarantee.

---

## Milestone 7 - Search

Implement case-insensitive search in the active notebook across:

- folder names,
- Markdown filenames,
- Markdown content with line-aware excerpts,
- clickable results that open the matching note.

Exclude Git metadata, dependencies, note asset directories, symlinks,
non-Markdown files, and oversized files. Prefer a simple confined filesystem
search; do not add a search service, vector index, or semantic search.

---

## Milestone 8 - Responsive Online-First PWA

Finish the mobile and installable browser experience:

- notebook tree in a touch-friendly drawer,
- responsive main and contextual editor toolbars,
- practical touch targets and software-keyboard behavior,
- PWA manifest, responsive icon, service worker, install flow, and standalone
  display mode,
- reliable frontend-shell loading,
- explicit offline/backend-unavailable messaging,
- mobile image picker and camera/gallery support.

The service worker may cache only the application shell. Do not cache note
contents or API responses and do not implement offline editing or sync queues.

---

## Milestone 9 - Editor Productivity

Improve editing speed by extending the existing Milkdown/ProseMirror commands
rather than creating parallel formatting logic.

Requirements:

- a keyboard- and touch-accessible slash-command picker,
- filtering, Arrow Up/Down, Enter, and Escape behavior,
- commands for headings, lists, tasks, quotes, inline code, code blocks, links,
  images, tables, and horizontal rules,
- slash commands and toolbar actions invoke equivalent editor transformations,
- conventional Enter and Shift+Enter paragraph/line-break behavior,
- predictable code-block line creation and an explicit multi-Enter exit,
- inline-code typing that can be entered and exited at an empty cursor,
- contextual table and image controls remain visible while their object is
  selected,
- every result serializes as ordinary CommonMark/GFM Markdown,
- Read only mode prevents all mutations.

Potential snippets or additional shortcuts must expand to ordinary Markdown and
must not execute code. Do not add collaboration, CRDTs, AI writing, arbitrary
scripting, a plugin runtime, proprietary syntax, or Notion-style blocks.

Completion principle:

> Markdown is storage. The editor is convenience.

---

## Milestone 10 - Alpha Hardening

Prepare an auditable alpha without claiming that all vulnerabilities are
eliminated.

Requirements:

- enforce notebook path confinement and symlink rejection,
- validate Git remotes, branches, request bodies, and upload types/sizes,
- apply same-origin mutation protection and defensive HTTP security headers,
- set server limits and timeouts,
- disable repository Git hooks for automated operations,
- preserve notes through save, Git, network, and conflict failures,
- harden the non-root container and persistent-volume defaults,
- exclude runtime data and credentials from Git and Docker build contexts,
- run backend, frontend, race, build, and dependency-audit checks,
- document security boundaries, recovery, persistence, and alpha limitations,
- keep application, package, binary, changelog, and image versions consistent.

The application still requires an external HTTPS authentication layer and must
not be exposed directly to the public Internet.

---

## Milestone 11 - Public Alpha Release and Container Publishing

Prepare and publish RepoQuill as a public alpha release in small, auditable
steps. Public repository creation, pushes, tags, releases, package publication,
and changes to external services require explicit user authorization before they
are performed.

### Phase 1 - Public repository audit

Before the first public push:

- inspect every tracked file and the complete Git history for credentials,
  private SSH keys, access tokens, personal paths, private repository URLs,
  personal notes, screenshots, email addresses, and other unintended data,
- confirm runtime directories such as `.repoquill-data/`, `data/`, generated
  frontend output, local environment files, and editor state are ignored,
- confirm runtime data and secrets are excluded from the Docker build context,
- run an automated secret scan against both the working tree and Git history,
- remove secrets from history rather than only deleting them in the latest
  commit, and rotate any credential that may already have been exposed,
- verify that example configuration and demo content contain only deliberate,
  publishable placeholder data,
- review repository links, module paths, image labels, and container metadata
  for the intended public repository owner and name.

Do not publish while a suspected credential or private document remains
unresolved.

### Phase 2 - Project and community metadata

Prepare the files expected in a public repository:

- select and add an explicit open-source `LICENSE`; do not assume a license on
  the user's behalf,
- ensure `README.md` documents the alpha status, supported deployment model,
  installation, persistent volumes, upgrades, backup/recovery, and the warning
  not to expose RepoQuill without HTTPS and external authentication,
- keep `SECURITY.md` current with supported versions and a private vulnerability
  reporting path,
- add contribution and code-of-conduct documents if public contributions are
  intended,
- ensure `CHANGELOG.md` contains the alpha version and release date,
- document known alpha limitations and deferred features,
- verify package, binary, manifest, OCI image, and displayed application
  versions consistently use the chosen release version.

### Phase 3 - Reproducible release gates

The release workflow must fail closed unless all required checks pass:

- install dependencies from lock files using reproducible commands,
- run Go tests, security-sensitive tests, `go vet`, and the race detector where
  practical,
- run frontend linting, unit/component tests, TypeScript compilation, and the
  production PWA build,
- audit Go and npm dependencies using maintained vulnerability scanners,
- scan the repository and produced image for secrets and known vulnerabilities,
- build the Docker image from a clean checkout,
- smoke-test the built image through its health endpoint,
- verify the container runs as a non-root user with the documented hardened
  Compose configuration,
- verify notebook data survives container replacement and remains ordinary,
  independently usable Markdown and asset files,
- retain enough build output or attestations to diagnose a failed release.

Pin third-party GitHub Actions to immutable commit SHAs for the publishing
workflow. Keep workflow permissions read-only by default and grant package write
access only to the publishing job. Never expose repository secrets to workflows
triggered by untrusted pull requests.

### Phase 4 - GitHub Actions container publishing

Add a dedicated release workflow that:

- runs only for an explicit release tag such as `v0.1.0-alpha.1` or by a clearly
  controlled manual dispatch,
- validates that the tag, changelog, package version, binary version, manifest,
  and image metadata agree,
- builds one multi-architecture image manifest for `linux/amd64` and
  `linux/arm64`, covering normal Intel/AMD hosts and 64-bit ARM systems such as
  current ARM servers, Apple Silicon Docker environments, and Raspberry Pi 4/5
  installations using a 64-bit operating system,
- does not claim support for `linux/arm/v7`, `arm/v6`, or other 32-bit targets
  until the complete dependency, build, scan, and runtime test chain succeeds
  for each added architecture,
- authenticates to GitHub Container Registry using the short-lived
  `GITHUB_TOKEN`, not a committed personal token,
- publishes to `ghcr.io/<owner>/repoquill`,
- applies immutable version tags such as `0.1.0-alpha.1` and the matching Git
  SHA so a deployment can be reproduced or rolled back exactly,
- applies the moving `0.1.0-alpha` convenience tag only after the matching
  immutable image and all architecture builds have succeeded; this tag points
  to the newest published alpha in the `0.1.0` line and is intended for users
  who deliberately prefer easier alpha updates over exact pinning,
- does not introduce a broader moving `alpha` tag initially because it could
  later cross minor-version compatibility boundaries,
- does not publish `latest` while the project is alpha unless explicitly
  requested,
- generates an SBOM and provenance attestation where supported,
- signs or attests published images using GitHub's OIDC-based mechanism where
  practical,
- publishes nothing if tests, scans, the image build, or smoke tests fail.

Avoid unnecessary registry credentials. The minimum expected workflow
permissions are:

```yaml
permissions:
  contents: read
  packages: write
  id-token: write # only when provenance/signing requires it
```

### Phase 5 - First public alpha

After explicit approval:

1. create or confirm the public GitHub repository,
2. configure the intended default branch and basic branch protection,
3. push the reviewed source history,
4. confirm ordinary branch CI succeeds in GitHub,
5. create and push the signed or annotated alpha tag,
6. let the release workflow build and publish the image,
7. verify the GHCR package visibility and pull the image by its immutable tag,
8. perform a fresh-install smoke test using empty persistent storage,
9. perform an upgrade/restart test using non-empty test notebook storage,
10. create a GitHub prerelease with changelog-derived notes, installation
    commands, known limitations, and rollback instructions.

Do not rewrite or move an already published immutable version tag. A failed
release must receive a new version.

### Phase 6 - Post-release verification

After publication:

- verify the documented `docker compose` flow using the published image,
- confirm health, notebook onboarding, editing, image handling, search, Git
  synchronization, PWA installation, restart persistence, and recovery,
- confirm the public image contains no source credentials, private keys, local
  runtime data, development dependencies, or unintended files,
- record the image digest in the release notes,
- verify vulnerability reporting and dependency update automation,
- create issues for accepted alpha limitations rather than hiding them,
- document how to roll back to the previous immutable image tag,
- monitor initial CI, package, and security reports before promoting another
  alpha tag.

### Milestone 11 completion criteria

Milestone 11 is complete when:

- the public repository contains only deliberately publishable content,
- license, security, installation, recovery, and alpha-status documentation are
  present,
- branch CI and release gates pass from a clean checkout,
- `v0.1.0-alpha.1` or its explicitly chosen successor is published as a GitHub
  prerelease,
- matching multi-architecture images are available from GHCR by immutable
  version and digest for `linux/amd64` and `linux/arm64`,
- the `0.1.0-alpha` convenience tag resolves to the same multi-architecture
  manifest as the newest successful immutable `0.1.0-alpha.N` release,
- a fresh deployment and a persistence/upgrade test have succeeded,
- no credentials are stored in Git, workflow files, release artifacts, or the
  container image,
- the release notes clearly state that RepoQuill has no built-in authentication
  and must be deployed behind an appropriate HTTPS authentication layer.

---

# 45. Alpha Release Criteria

Before calling a build "alpha", verify:

- notes survive container replacement,
- repositories survive application deletion,
- a notebook can be cloned and read independently,
- Markdown is standards-friendly,
- images render outside the application,
- repository history is valid,
- failed push does not lose edits,
- path traversal is blocked,
- mobile layout is usable,
- image paste works,
- Docker volume behavior is documented,
- Git credentials are not leaked,
- no note content is stored only in SQLite.

---

# 46. Future Features After Alpha

Potential later features:

- raw Markdown/source mode,
- configurable sync intervals,
- manual sync,
- commit history UI,
- diff view,
- basic conflict editor,
- OIDC authentication,
- provider-specific repository creation,
- GitHub integration,
- GitLab integration,
- Forgejo/Gitea integration,
- custom slash snippets,
- templates,
- orphaned asset cleanup,
- optional note metadata/frontmatter,
- configurable editor preferences,
- light/dark theme,
- import helpers,
- export convenience tools,
- repository health diagnostics,
- WebDAV-like access only if it remains non-invasive.

Every future feature must preserve the core portability principle.

---

# 47. Features Requiring Special Scrutiny

Before implementing any of the following, explicitly verify that they do not compromise plain-file portability:

- custom note properties,
- embedded databases,
- transclusion,
- block references,
- shared attachments,
- encrypted note bodies,
- generated metadata,
- custom Markdown extensions,
- collaborative editing,
- offline editing.

Do not let convenient application features quietly turn the repository into an opaque application database.

---

# 48. Coding-Agent Rules

When an AI coding agent works on this project, it MUST:

1. Read this file before making architectural changes.
2. Prefer the simplest implementation that meets current requirements.
3. Avoid adding dependencies without need.
4. Avoid speculative abstractions.
5. Preserve plain Markdown compatibility.
6. Preserve provider-independent Git support.
7. Preserve one-repository-per-notebook semantics.
8. Preserve application-independent readability.
9. Avoid modifying unrelated code.
10. Keep commits focused.
11. Add tests for destructive or security-sensitive behavior.
12. Never silently change the canonical storage model.
13. Never replace filesystem/Git storage with a database.
14. Never introduce collaborative editing architecture without an explicit project decision.
15. Never add authentication complexity to V0.1 without an explicit project decision.
16. Never introduce a cloud dependency for core functionality.
17. Treat data loss risks as higher priority than UI convenience.
18. Ask for clarification only when a decision would materially alter architecture or risk data loss; otherwise choose the simplest interpretation consistent with this document.
19. Write a CHANGELOG.md in the Keep a Changelog format

---

# 49. Agent Change Checklist

Before finishing a change, verify:

- Does this preserve plain Markdown files?
- Are assets still normal files?
- Can the repository still be used without the app?
- Does this stay inside the notebook root?
- Can this operation lose data?
- Is Git failure separated from save failure?
- Did this introduce unnecessary infrastructure?
- Does this work reasonably on mobile?
- Does this create a hidden proprietary dependency?
- Is this feature actually required now?

If any answer is problematic, redesign before merging.

---

# 50. Project Philosophy

The application should stay boring in all the right ways.

Markdown is storage.

Folders are structure.

Git is history and synchronization.

The browser is the interface.

The application should provide convenience without taking ownership of the data.

The preferred failure mode is:

> The application disappears and the user still has a perfectly ordinary Git repository containing readable Markdown files and images.

That is the product.
