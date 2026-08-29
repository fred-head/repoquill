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
- a single-owner authentication boundary by Alpha 2 that can be explicitly
  disabled for separately protected deployments.

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
- multi-user account management,
- email-based password reset,
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

Alpha 2 introduces a deliberately small built-in authentication boundary for a
single-owner self-hosted instance. This is an explicit architectural decision
made after Alpha 1 demonstrated that interactive forward-auth layers can expire
or intercept browser/PWA API requests without RepoQuill being able to understand
or recover the authentication state reliably.

Supported authentication modes are:

```text
local     -> RepoQuill password with optional TOTP MFA; recommended default
disabled  -> explicit operator choice for LAN, VPN, or external protection
oidc      -> possible future direct integration, not required for Alpha 2
```

Local authentication must remain single-owner. Do not add registration,
usernames, email addresses, invitations, roles, organizations, email recovery,
or general account lifecycle. An internal fixed owner principal is allowed, but
must not become canonical note metadata.

Authentication metadata and sessions may use SQLite. They MUST NOT contain
canonical note content or the only copy of an asset. Losing or resetting auth
metadata must not make the Git-backed Markdown notebooks unreadable outside
RepoQuill.

The built-in boundary does not replace HTTPS. Internet-facing deployments must
terminate TLS at a correctly configured reverse proxy. Proxy-derived client IP
or scheme headers may be trusted only from explicitly configured proxy
addresses or networks.

`disabled` mode must require explicit configuration and produce a clear startup
and UI warning. It is suitable only when access is otherwise constrained. Do
not silently infer that an external authentication proxy is secure.

Future OIDC must be a direct RepoQuill integration so the application knows the
session state. MFA for OIDC remains the identity provider's responsibility.
Do not implement a custom OAuth/OIDC protocol, local MFA cryptography, or a
password/session algorithm where a focused, maintained library or standard
primitive exists.

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

The Alpha 1 application still requires an external HTTPS authentication layer
and must not be exposed directly to the public Internet. Milestone 19 replaces
this Alpha 1 limitation with the Alpha 2 single-owner authentication boundary;
HTTPS remains required for Internet-facing deployment.

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
- ensure `README.md` documents the Alpha 1 status, supported deployment model,
  installation, persistent volumes, upgrades, backup/recovery, and the warning
  not to expose that release without HTTPS and external authentication,
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
- the Alpha 1 release notes clearly state that the release has no built-in
  authentication and must be deployed behind an appropriate HTTPS
  authentication layer.

---

# 45. Alpha 2 Milestones

Alpha 2 should close the remaining trust and everyday-navigation gaps without
expanding RepoQuill into a general-purpose productivity platform. These
milestones must continue to treat ordinary Markdown files, folders, assets, and
Git history as the canonical data model.

Milestones 16, 17, 19, 20, and 21 are the highest-priority Alpha 2 milestones.
Conflict handling, understandable synchronization, the authentication boundary,
continuous vulnerability management, and the final dependency baseline are
trust and data-safety features, not optional polish, and should be implemented
before lower-risk convenience work where practical. Milestones 19, 20, and 21
are Alpha 2 release blockers and must receive dedicated security review.

## Milestone 12 - Recoverable Deletion and Trash

Replace immediate destructive deletion in normal notebook workflows with a
recoverable notebook-local trash mechanism.

Implementation status: completed on the Alpha 2 development branch. Normal
deletion now moves notes, folders, and owned assets into a confined
notebook-local Trash with explicit restore and permanent-delete workflows.

Requirements:

- move deleted notes and folders into a notebook-local `.trash` area by
  default,
- move a note's owned `.assets` directory together with the note,
- provide a clear Trash view with Restore and permanently Delete actions,
- provide recovery directly in RepoQuill and never use `recover it with Git`
  as the only normal-user recovery instruction,
- retain enough ordinary filesystem information to restore an item to its
  original location where safe,
- handle name collisions explicitly and never overwrite an existing restored
  target silently,
- require confirmation before permanent deletion,
- preserve notebook-root confinement and reject symlink or traversal escapes,
- keep trash operations visible to Git as ordinary filesystem changes,
- exclude trashed content from the normal tree, search, editor links, and
  unreferenced-asset cleanup.

Do not implement a proprietary content store for deleted notes. Recovery must
remain understandable at the filesystem and Git level.

Completion criteria:

- accidental deletion is recoverable from desktop and mobile,
- notes, folders, and note-owned assets restore together safely,
- permanent deletion is deliberate, confirmed, confined, and tested.

## Milestone 13 - Note Version History and Restore

Expose the history Git already provides in a note-oriented interface.

Implementation status: completed on the Alpha 2 development branch. The active
note can now show its provider-independent Git history, readable historical
content and differences, and restore a selected version as a new version-checked
working-tree change.

Requirements:

- show commits that affected the active Markdown note,
- display timestamp and a useful commit summary,
- allow viewing a historical note version and a readable diff,
- allow restoring an earlier version without resetting or rewriting repository
  history,
- expose restoration as a direct note action rather than requiring the user to
  identify or operate on a Git commit,
- save a restoration as a new ordinary working-tree change that can be synced
  normally,
- preserve unsaved editor content and never replace it without explicit user
  confirmation,
- handle renamed or moved notes where Git can identify the history reliably,
- report unavailable, shallow, missing, or invalid history clearly,
- do not expose arbitrary revisions, paths, or Git arguments to command
  execution.

The first version does not need a repository-wide Git client or commit browser.

Completion criteria:

- a user can inspect and safely restore a previous version of a note,
- restoration never performs a destructive reset or silent overwrite,
- history remains ordinary provider-independent Git history.

## Milestone 14 - Portable Internal Note Links

Make links between notes convenient while retaining standard Markdown
portability.

Implementation status: completed on the Alpha 2 development branch. Internal
links remain ordinary relative Markdown links; RepoQuill provides a searchable
picker and editor suggestions, opens links in the current or a new note tab,
marks missing targets, and requires an exact review token before rename/move
rewrites are applied. Link discovery and rewriting stay notebook-confined and
conservatively leave images, code, external URLs, anchors, and unsupported
syntax untouched.

Requirements:

- provide a searchable note picker from the existing link action,
- offer note suggestions when typing an internal-link trigger where practical,
- serialize new internal links as ordinary relative Markdown links rather than
  opaque application IDs,
- open internal note links inside RepoQuill,
- support opening a link in a new note tab with the existing desktop and touch
  interaction patterns,
- detect broken or missing internal-link targets without corrupting Markdown,
- safely update affected relative links when notes or folders are renamed or
  moved,
- preview every ambiguous or broad link rewrite and never guess between
  multiple possible targets,
- preserve external URLs, anchors, images, encoded paths, angle-bracket paths,
  and unsupported Markdown unchanged,
- keep link resolution confined to the active notebook.

Do not add backlinks, graph view, block references, transclusion, proprietary
link IDs, or a canonical link database in this milestone.

Completion criteria:

- users can create and follow links without manually typing paths,
- links remain useful in ordinary Markdown editors and Git forges,
- rename and move operations do not silently leave known links broken.

## Milestone 15 - Complete Notebook Management

Implementation status: completed on the Alpha 2 development branch. Notebook
registrations can be renamed or safely removed, optional local working-copy
deletion requires the exact notebook name, and compact actionable health checks
keep remote and technical details out of the normal management view.

Turn the existing Manage Notebooks overview into a small, safe management
surface.

Requirements:

- retain the current notebook details and active-state overview,
- allow changing the human-readable notebook display name,
- allow removing an inactive notebook registration from RepoQuill,
- clearly distinguish removing registration from deleting a local working
  tree,
- make registration-only removal the safe default and never affect the remote
  repository,
- require stronger explicit confirmation before any optional local working-tree
  deletion,
- refuse removal while a required save or notebook operation is active,
- close or transfer affected UI state safely when a notebook is removed,
- show branch, remote, credential association, and repository health in a
  troubleshooting-oriented but understandable form,
- show a compact health summary for local files, remote connectivity, write
  access, pending work, and the last successful synchronization,
- turn each failed health check into a specific next action such as `Retry`,
  `Check connection`, or `Repair access`,
- keep branch names, repository paths, and raw diagnostics behind optional
  technical details unless the user is editing connection settings,
- preserve the existing Add Notebook, switching, Git/SSH onboarding, and sync
  behavior.

Editing a remote URL or branch in place is not required if safely recloning the
notebook is the clearer model.

Completion criteria:

- Manage Notebooks provides meaningful management rather than only an overview,
- each notebook has an understandable health state and actionable repair path,
- registration removal cannot accidentally delete notebook content,
- all destructive options communicate their exact local and remote impact.

## Milestone 16 - Guided Conflict Resolution

Provide a safe conflict-resolution workflow that is understandable without Git
knowledge. Git remains the underlying mechanism, but the primary UI must speak
only in terms of the user's version, the other version, combined content, and
the resulting note.

Implementation status: completed on the Alpha 2 development branch. Both
optimistic save collisions and remote synchronization conflicts now use the
same plain-language review model. Source versions remain in Git, reviewed
decisions are revalidated against the remote, index, and working tree, and a
durable recovery ref is created before accepted content is applied. Markdown,
modify/delete, binary image, keep-both, and overlapping rename cases are handled
without force pushes, destructive resets, or exposing conflict markers to the
editor.

This milestone covers both conflicts detected by the optimistic file-version
check during save and conflicts produced while integrating remote Git changes.
The two technical sources should use one consistent user-facing mental model:

> Two versions overlap. RepoQuill has preserved both and needs the user to
> choose the resulting content.

Requirements:

- continue resolving unambiguous changes automatically and open the assistant
  only for changes that require a decision,
- stop automatic synchronization while any conflict remains unresolved,
- preserve unsaved editor content, committed local content, and incoming
  content before presenting resolution actions,
- create a durable, identifiable Git safety point before applying a completed
  Git conflict resolution,
- show a notebook-level overview of every affected note, folder, and asset,
- use plain labels such as `Your version`, `Other version`, `Keep note`, and
  `Confirm deletion`; do not expose `ours`, `theirs`, index stages, rebase, or
  conflict-marker terminology in the primary workflow,
- allow the user to postpone resolution without losing either version,
- allow inspecting both complete Markdown versions and a readable highlighted
  text diff,
- provide `Use your version`, `Use other version`, and `Edit combined version`
  actions for Markdown conflicts,
- use the normal RepoQuill editor for combined content where safe, while
  keeping unresolved markers and Git conflict syntax out of the editor,
- handle modify/delete conflicts with explicit `Keep note` and `Confirm
  deletion` decisions, defaulting to the non-destructive choice,
- handle rename and move conflicts with human-readable paths and the existing
  safe folder picker,
- update note-owned assets and portable internal links consistently after a
  chosen rename or move,
- show conflicting images side by side where the browser supports preview and
  offer `Use your image`, `Use other image`, and `Keep both`,
- give retained duplicate assets new collision-resistant names instead of
  overwriting either file,
- collect and review all decisions before mutating the working tree or
  continuing synchronization,
- revalidate the remote state and every affected path immediately before
  applying decisions,
- stop safely and request a new review if the remote or working-tree state
  changed during resolution,
- continue the existing Git operation and push automatically only after every
  conflict has a valid decision,
- report a clear success state and make the most recent resolution reversible
  through its safety point where practical,
- keep technical Git diagnostics available behind optional details for support
  without making them part of the normal decision flow,
- support keyboard, touch, narrow mobile/PWA layouts, and accessible labels,
- never use force push, destructive reset, silent deletion, or automatic
  preference for local or incoming content.

Implementation safety rules:

- never parse rendered editor HTML as the source for conflict resolution,
- obtain historical conflict inputs through validated direct Git arguments and
  confined notebook-relative paths,
- do not expose arbitrary revisions, ref names, paths, or Git arguments through
  frontend input,
- serialize conflict-application operations per notebook,
- do not allow ordinary automatic sync to resume while the repository still
  contains unresolved entries or an incomplete Git operation,
- preserve recovery information if the browser closes, the backend restarts,
  the network fails, or applying a resolution is interrupted,
- treat binary files as choose-one-or-keep-both decisions rather than attempting
  a textual merge,
- never write conflict markers into a note as an accepted resolution unless
  the user deliberately typed those characters as normal content.

Completion criteria:

- a user with no Git knowledge can understand why synchronization paused and
  complete every supported resolution through RepoQuill,
- ordinary text, modify/delete, rename/move, and image conflict variants have
  explicit safe workflows,
- both original versions remain recoverable until the completed resolution is
  safely recorded,
- closing or refreshing the browser does not discard pending conflict choices
  or the source versions,
- a second remote update during resolution cannot cause stale decisions to be
  applied silently,
- focused backend, frontend, integration, and interruption-recovery tests cover
  the conflict lifecycle,
- the resulting notebook remains an ordinary readable Git repository without
  proprietary conflict metadata in canonical note content.

## Milestone 17 - Git-Invisible Save and Synchronization UX

Make everyday save, synchronization, remote-change, and failure states
understandable to users who have no Git knowledge. Git remains visible only in
notebook connection settings, optional diagnostics, and other deliberately
technical views.

Implementation status: completed on the Alpha 2 development branch. The compact
status bar now opens a human-readable synchronization panel, successful external
changes are summarized without replacing the active note, and technical Git
details remain optional.

Requirements:

- clearly distinguish `saved on this RepoQuill server` from `synchronized with
  the connected service` without implying that a local save already exists on
  the remote,
- keep the compact document status bar, but use human-readable primary labels
  and accessible explanations,
- replace primary-interface states such as `Clean`, `Local changes`, `Remote
  changes`, `Diverged`, `Dirty working tree`, `Upstream`, and `Rebase` with
  phrases such as `Everything is up to date`, `Changes waiting to sync`, `New
  changes available`, and `Changes need your review`,
- provide a central synchronization details panel reachable from the status
  bar,
- show local-save state, connection state, pending synchronization state, last
  successful synchronization, next scheduled attempt where applicable, and a
  clear `Sync now` action,
- expose raw branch, ahead/behind counts, operation names, sanitized command
  diagnostics, and other Git terminology only under optional technical details,
- structure every important error around three questions: what happened,
  whether the user's note content is safe, and what the user can do next,
- never show raw Git stderr as the only user-facing explanation,
- provide specific safe actions such as `Retry`, `Check connection`, `Review
  changes`, and `Open notebook settings`,
- state explicitly when changes remain saved locally but have not reached the
  remote service,
- announce successfully integrated external changes in a non-blocking summary,
  including added, updated, moved, and deleted notes where known,
- allow opening an affected note from that summary without interrupting the
  current note unexpectedly,
- route overlapping external changes into Milestone 16 rather than describing
  them as a technical synchronization failure,
- use notebook, note, folder, saved, and synchronized terminology throughout
  the primary note-taking UI,
- reserve repository, remote, branch, SSH, commit, fetch, rebase, and push for
  connection setup, diagnostics, and advanced details,
- reorganize Settings into understandable sections such as General, Notebooks,
  Storage and recovery, and Advanced,
- place SSH keys, host trust, Git diagnostics, and other setup internals in the
  Advanced or notebook-connection area after successful onboarding,
- retain accessible text for every state and never communicate save or sync
  safety through color or icons alone,
- keep all existing synchronization scheduling, serialization, conflict
  protection, provider independence, and local-save behavior unchanged unless a
  safety correction is required.

Suggested normal-user states:

```text
Saved on this server
Waiting to synchronize
Synchronizing…
Everything is up to date
New changes were received
Synchronization could not finish
Your decision is required
Notebook is currently unavailable
```

Completion criteria:

- a user can tell whether edits are saved locally and whether they reached the
  connected service without understanding Git,
- a synchronization failure explains that saved notes remain safe whenever
  that is true and offers a concrete next step,
- no primary workflow requires interpreting `clean`, `dirty`, `diverged`,
  `ahead`, `behind`, `rebase`, or raw Git output,
- external changes are visible and understandable instead of appearing as
  unexplained content changes,
- the synchronization panel and reorganized settings work on desktop and
  mobile/PWA layouts.

## Milestone 18 - Guided Notebook Connection Onboarding

Implementation status: completed on the Alpha 2 development branch. The
provider-independent clone flow is presented as a five-step assistant with
provider-specific examples, retained progress, guided managed SSH keys, explicit
host trust, actionable connection failures, and a final review.

Make connecting an existing Git-backed notebook achievable without prior Git or
SSH knowledge while keeping the underlying synchronization provider-independent.

Requirements:

- present a step-by-step connection assistant rather than one dense technical
  form,
- begin with approachable choices such as GitHub, GitLab, Forgejo/Gitea, and
  another Git server,
- treat provider choices as instructional presets only; cloning, fetching, and
  pushing must continue to use normal provider-independent Git,
- explain that the remote repository must already exist and that RepoQuill does
  not create it through a provider API in Alpha 2,
- provide provider-appropriate SSH URL examples and detect common HTTPS, SSH,
  malformed, pasted-link, and escaped-address mistakes,
- infer the host and default branch where it can be discovered safely instead
  of requiring unnecessary input,
- guide managed-key creation, public-key copying, provider-side deploy-key
  placement, write-access selection, and connection testing one step at a time,
- preserve the existing explicit SSH host fingerprint approval and explain in
  plain language why the host must be trusted,
- translate authentication, host trust, missing repository, missing branch,
  read-only key, network, and clone failures into distinct actionable messages,
- provide direct actions such as `Copy public key`, `Open setup instructions`,
  `Test again`, and `Back`,
- tell the user which completed onboarding steps are safe and retained after a
  failure,
- allow advanced users to choose existing server SSH configuration without
  making that option the unexplained default,
- show a final review containing notebook name, service/host, repository
  address, branch, and credential choice before cloning,
- after success, open the notebook and show the health summary from Milestone
  15 plus the synchronization explanation from Milestone 17,
- keep credentials out of frontend responses, logs, repository content, and
  browser persistence,
- remain usable by keyboard, touch, mobile/PWA, and assistive technology.

Completion criteria:

- a first-time GitHub user can connect a private repository by following only
  the instructions shown in RepoQuill,
- common connection failures identify the failed step and a concrete repair
  action instead of returning a generic connection-test error,
- an advanced provider-independent SSH workflow remains available,
- no provider API, mandatory cloud integration, or proprietary notebook format
  is introduced.

## Milestone 19 - Single-Owner Authentication and Optional TOTP MFA

Implement a small built-in authentication boundary designed for one owner of a
self-hosted RepoQuill instance. The goal is reliable browser and PWA behavior
without depending on an interactive forward-auth proxy. This is a security
milestone and must be developed in the phases below; later phases must not begin
by weakening incomplete safeguards from an earlier phase.

The supported Alpha 2 modes are:

```text
local     -> built-in password and optional TOTP; recommended
disabled  -> explicit operator choice for a separately protected deployment
```

Direct OIDC is deferred. Do not add registration, usernames, multiple users,
roles, invitations, email addresses, or email-based recovery.

### Phase 1 - Architecture and persistent security metadata

- record the authentication decision, threat model, trust boundaries, public
  routes, protected routes, proxy assumptions, and recovery model before
  implementation,
- introduce a dedicated internal authentication service rather than scattering
  password and session checks through HTTP handlers,
- store only authentication configuration, sessions, one-time recovery data,
  throttling state where needed, and security events in an application metadata
  database such as SQLite,
- keep canonical Markdown, assets, Git repositories, SSH private keys, and Git
  credentials outside authentication tables,
- use a fixed internal owner principal without exposing unnecessary username or
  account management concepts,
- make schema migrations atomic, versioned, restart-safe, and backed up before
  destructive changes,
- define `local` and `disabled` configuration semantics and a safe migration
  path for existing Alpha 1 deployments,
- never silently enable unauthenticated public access during migration or after
  damaged/missing authentication metadata.

### Phase 2 - Secure first-run setup and local password

- make fresh local-auth installations start in a restricted `setup required`
  state,
- prevent first-visitor instance takeover with a cryptographically random,
  short-lived, one-time bootstrap token supplied through an operator-controlled
  channel such as a Docker secret, a root-readable file on the persistent
  volume, or an operator-only CLI command; log only retrieval instructions and
  never the token value,
- invalidate the bootstrap token permanently after successful setup and reject
  every repeated setup attempt,
- use Argon2id from a maintained cryptographic library with a unique random
  salt and stored versioned cost parameters,
- select memory and CPU parameters suitable for the minimum supported container
  size and benchmark them in CI or a documented release process,
- support transparent parameter upgrades after a later successful login,
- compare derived credentials in constant time and return uniform failure
  messages and materially similar failure timing,
- allow long passphrases, whitespace, Unicode, paste, and password managers;
  do not impose arbitrary composition or periodic-change rules,
- reject unreasonably short and excessively large password inputs before
  expensive hashing to prevent weak credentials and resource exhaustion,
- never log passwords, derived hashes, setup tokens, request bodies, or other
  authentication secrets.

### Phase 3 - Server-side sessions and API boundary

- use a maintained server-side session library and cryptographically random
  opaque tokens rather than inventing a token or JWT format,
- persist production sessions so a normal container restart does not force an
  unexplained logout,
- store only the opaque session identifier in a cookie and keep authentication
  state on the server,
- set `HttpOnly`, `Secure`, an appropriate `SameSite` value, and a confined
  cookie path in production,
- never store session IDs, refresh credentials, password material, or MFA
  secrets in `localStorage`, `sessionStorage`, IndexedDB, URLs, or frontend
  application state,
- renew the session identifier after password and MFA authentication and every
  authentication-level change to prevent fixation,
- implement idle and absolute expiration plus an explicit `Remember this
  device` duration,
- provide login, logout, authentication status, current-session revocation, and
  all-session revocation endpoints with stable JSON responses,
- protect every notebook, note, asset, search, Git, SSH, maintenance, and
  management API through deny-by-default middleware,
- keep only the minimum setup, login, static shell, and non-sensitive liveness
  surface public,
- return a stable JSON `401` for expired or missing sessions rather than HTML or
  redirects from API routes,
- do not describe authentication expiration as a Git synchronization failure.

### Phase 4 - CSRF, request origin, throttling, and proxy trust

- bind a CSRF token to the authenticated session and require it for every
  state-changing browser request,
- retain and strengthen same-origin validation; never rely on `SameSite`
  cookies as the only CSRF defense,
- ensure GET and HEAD routes have no state-changing side effects,
- apply progressive login delays and rate limits per trustworthy client address
  plus a global limit suitable for a single-owner account,
- avoid a permanent attacker-triggerable account lockout that could deny the
  owner access indefinitely,
- log authentication success, failure, throttling, setup, password change, MFA
  change, session revocation, and recovery without logging credentials or note
  content,
- accept `X-Forwarded-For`, `X-Real-IP`, and `X-Forwarded-Proto` only from
  explicitly configured trusted proxy IPs or CIDRs,
- ignore or replace spoofed forwarding headers from all other clients,
- document TLS termination and trusted-proxy configuration for common Docker
  reverse-proxy deployments,
- keep the backend unreachable except through the intended proxy where the
  deployment exposes it to the Internet.

### Phase 5 - Browser and PWA authentication lifecycle

- show first-run setup and login as first-class responsive RepoQuill screens,
- handle an expired session inside the SPA/PWA without relying on an external
  redirect or hard refresh,
- distinguish authentication required, backend unavailable, browser offline,
  frontend update required, local save failure, and Git sync failure,
- stop editing and automatic Git triggers safely when authentication expires,
- preserve an unsaved editor draft before any logout, reload, or reauthentication
  flow could discard it,
- treat a browser recovery draft as temporary data-loss protection, not offline
  editing or a canonical sync queue,
- associate recovery drafts with notebook ID, note path, and loaded file version
  and never overwrite changed server content silently,
- reconcile a recovery draft after login through the normal version check and
  route overlapping content to Milestone 16,
- remove a recovery draft only after the note is saved successfully or the user
  deliberately discards it,
- retry authentication status on browser `online`, focus, and visibility
  changes without creating request loops,
- keep the service worker limited to the application shell and never cache auth
  APIs, API responses, sessions, notes, or credentials,
- show the running RepoQuill version unobtrusively at the bottom of Settings,
  using the backend-reported build version as the source of truth and displaying
  `dev` for unversioned local builds,
- optionally show a shortened build/commit identifier when it is supplied by
  the release build, without exposing host or repository metadata; a version
  link may point to the matching public GitHub release,
- keep version information secondary to application and security state, but
  make it selectable and accessible so users can include it in diagnostics,
- verify that a stale frontend and newer backend can be distinguished without
  misreporting the condition as an authentication, save, or Git sync failure,
- support multiple tabs, installed PWA windows, mobile browsers, password
  managers, keyboard navigation, and assistive technology.

### Phase 6 - Password and session administration

- add a Security settings section for changing the password, choosing session
  durations within safe bounds, viewing active sessions, revoking another
  session, revoking all other sessions, and logging out,
- require recent password authentication and, when enabled, MFA for password or
  MFA changes and other sensitive authentication operations,
- invalidate all other sessions after a password change by default,
- identify sessions with creation time, last activity, approximate client/device
  description, and revocation state without invasive fingerprinting,
- provide an operator-only CLI recovery command through the RepoQuill binary for
  forgotten-password recovery,
- require filesystem/container administrative access for CLI recovery,
- make password reset revoke all sessions and make MFA reset a separate explicit
  decision,
- never alter, encrypt, delete, or relocate notebook contents during auth
  recovery,
- document that Git-backed notes remain independently recoverable even if all
  RepoQuill authentication metadata is lost.

### Phase 7 - Optional TOTP MFA and recovery codes

- use a maintained TOTP implementation rather than implementing the algorithm,
- require recent password verification before beginning enrollment,
- generate the TOTP secret with a cryptographically secure random source and
  render the enrollment QR code locally without an external service,
- keep enrollment pending and MFA disabled until the user successfully verifies
  a generated code,
- encrypt the stored TOTP secret with an application key kept outside the
  metadata database and never return it after enrollment completes,
- use a small documented clock-skew window and strict attempt throttling,
- accept password first and then TOTP or a one-time recovery code without
  revealing which credential failed,
- generate high-entropy one-time recovery codes, display them once, store only
  hashes, and consume each code atomically,
- require the user to confirm recovery-code storage before completing MFA
  activation,
- require recent password plus TOTP or a recovery code to disable or replace
  MFA,
- provide regeneration of recovery codes that invalidates every previous code,
- never log TOTP secrets, QR payloads, submitted codes, or recovery codes,
- do not claim that TOTP protects a stolen authenticated session; retain session
  revocation and secure-cookie controls.

### Phase 8 - Disabled mode and deployment migration

- require an explicit `disabled` setting; do not infer it from forwarding
  headers or an accessible authentication portal,
- show a persistent security warning in Settings and startup logs while auth is
  disabled,
- document disabled mode for localhost, private LAN, VPN, Tailscale, or a
  deliberately configured external authentication layer,
- warn that interactive forward-auth can still expire independently and return
  HTML or redirects to API clients,
- ensure switching authentication modes cannot accidentally leave active local
  sessions or setup tokens valid,
- define a safe upgrade flow for existing Alpha 1 installations without silently
  exposing them or irreversibly locking out the operator,
- keep HTTPS and network isolation guidance applicable in every mode.

### Phase 9 - Security verification and release gate

Implementation status: completed on the Alpha 2 development branch. The exact
release candidate must still pass the full CI, scan, container, and manual
preflight gate before an Alpha 2 tag may be published.

The post-review cleanup additionally applies persistent progressive throttling
to sensitive password and MFA checks, bounds and coalesces security-event
storage, binds expiring MFA enrollment to the initiating session, prevents
expired-session resurrection during activity updates, fails closed on
authentication-state read errors, raises the new-password minimum to 15
characters with basic weak-value rejection, and quarantines a malformed MFA key
only during an explicit recovery operation.

- add focused unit, integration, frontend, and end-to-end tests for setup,
  login, logout, expiration, remember-me, revocation, restart persistence,
  password changes, recovery, and PWA reauthentication,
- test setup takeover prevention, session fixation, session theft impact,
  timing-sensitive comparisons, CSRF, Origin validation, brute-force
  throttling, permanent-lockout resistance, proxy-header spoofing, and malformed
  input/resource exhaustion,
- test TOTP enrollment, clock windows, repeated-code handling, recovery-code
  atomicity, MFA disable/reset, secret redaction, and interrupted enrollment,
- test that all protected API routes deny unauthenticated access and every
  intentionally public route exposes no notebook, Git, SSH, or host metadata,
- test authentication metadata loss and CLI recovery without modifying note
  repositories,
- test login and session expiry in normal tabs, multiple tabs, mobile layouts,
  and installed PWA mode,
- run dependency, static, container, and vulnerability scans with no ignored
  critical result,
- perform a dedicated manual security review against current OWASP
  authentication, password-storage, session-management, CSRF, and MFA guidance,
- document the remaining threat model and accepted limitations in the release
  notes,
- do not publish Alpha 2 until the complete authentication test and review gate
  passes.

### Milestone 19 completion criteria

- a fresh instance cannot be claimed without operator-controlled bootstrap
  authority,
- the owner can sign in with a password and optionally TOTP from desktop,
  mobile, and installed PWA,
- expiration and reauthentication never masquerade as Git failure or silently
  discard an editor draft,
- password hashes, session tokens, TOTP secrets, submitted codes, and recovery
  codes are never stored or logged in plaintext outside their strictly required
  protected form and lifetime,
- password, session, MFA, recovery, CSRF, throttling, and trusted-proxy behavior
  meets the requirements above and is covered by adversarial tests,
- `disabled` mode is explicit, visibly warned, and documented,
- container restart, auth reset, or loss of auth metadata cannot destroy or make
  the underlying Git-backed Markdown notebooks unreadable,
- Alpha 2 receives a dedicated security review before release.

## Milestone 20 - Continuous Vulnerability and Supply-Chain Management

Turn the existing point-in-time CI and release checks into a continuous process
that also detects vulnerabilities disclosed after an image was built.
Automation may discover, propose, test, and report updates; it must not silently
merge security-sensitive changes or deploy an unreviewed image.

### Phase 1 - Dependency inventory and update proposals

- add `.github/dependabot.yml` coverage for Go modules at the repository root,
  npm in `/frontend`, Docker base images, and GitHub Actions,
- enable the GitHub dependency graph, Dependabot alerts, and Dependabot security
  updates in repository settings,
- create security-update pull requests as soon as a supported advisory becomes
  available,
- check ordinary dependency updates on a controlled weekly schedule and group
  only low-risk development-tool updates where this improves reviewability,
- keep authentication, session, cryptography, TOTP, SQLite, Git execution,
  editor, PWA/service-worker, and container-base updates separately reviewable,
- retain reproducible `go.sum` and `package-lock.json` state and reject builds
  that require uncommitted dependency resolution,
- inventory direct and transitive runtime dependencies in the release SBOM,
- do not enable unattended dependency auto-merge.

### Phase 2 - GitHub repository security controls

- enable and verify Dependabot security alerts and maintainer notifications,
- enable GitHub secret scanning and push protection where available,
- enable CodeQL default setup for Go and JavaScript/TypeScript and evaluate the
  `security-extended` query suite for authentication code,
- run CodeQL for pull requests, the default/protected branch, and its scheduled
  cadence,
- configure branch protection or repository rulesets so required backend,
  frontend, secret, image, and code-scanning checks must pass before merge,
- prevent routine dependency updates from bypassing required checks,
- keep GitHub Actions pinned to immutable commit SHAs while allowing Dependabot
  to propose reviewed SHA updates,
- periodically verify in GitHub's tool-status views that scanners remain active
  and cover the expected files and languages.

### Phase 3 - Scheduled source and published-image scanning

- add a scheduled security workflow that runs at least weekly and preferably
  daily for known-vulnerability data,
- run `govulncheck ./...`, `npm audit`, secret scanning, and relevant static
  analysis even when no source commit occurred,
- build and scan a fresh production container with Trivy,
- separately rescan the newest published immutable Alpha image and moving Alpha
  channel tag so newly disclosed base-image or OS-package issues are detected,
- retain HIGH and CRITICAL findings as failing results unless a documented,
  time-limited, reviewed exception explains reachability and mitigation,
- never suppress a CRITICAL authentication, remote-code-execution, credential,
  traversal, or container-escape finding merely to make CI green,
- produce an actionable signal containing the affected tag, digest, component,
  advisory, severity, and fixed version where known,
- distinguish scanner/advisory-database outages from a clean result and fail
  closed for releases when required scan results are unavailable.

### Phase 4 - Dependency pull-request safety policy

- treat every automated update as an untrusted code change that must pass normal
  pull-request review and complete CI,
- require Go tests, race detection, `go vet`, `govulncheck`, frontend lint and
  tests, production PWA build, `npm audit`, secret scanning, CodeQL, container
  build, Trivy, and runtime smoke tests before merge,
- require Milestone 19 authentication unit, integration, adversarial, and PWA
  session tests for every update that can affect authentication,
- review upstream release notes, advisories, maintenance status, license, and
  relevant transitive changes before merging a security-critical dependency,
- do not assume SemVer guarantees compatibility; patch and same-release-line
  updates are lower risk but can still alter behavior, defaults, serialization,
  timing, or security semantics,
- separate major and security-sensitive updates from unrelated changes and do
  not group multiple authentication or cryptographic libraries opaquely,
- require human approval for production runtime dependencies and every auth,
  session, MFA, cryptographic, database, Git, PWA, and container update,
- permit auto-merge only after a later explicit policy names a narrow class of
  development-only updates and proves that required review is not weakened.

### Phase 5 - Release and deployment safety

- publish only from an explicit immutable release tag after source,
  architecture, image, runtime, and security gates pass,
- never overwrite or move an immutable version tag,
- move the Alpha convenience tag only after its immutable multi-architecture
  image has passed every validation,
- do not let Dependabot, CI, or a successful merge deploy directly to user
  installations,
- recommend immutable image pinning for production-like Alpha deployments and
  document automatic channel-tag updaters as an explicit operator risk,
- test a release candidate with fresh storage and representative existing
  persistent data,
- test auth schemas, sessions, notebook metadata, Git credentials, PWA updates,
  migration, and rollback for dependency changes touching persistence or
  security,
- publish image digest, SBOM, provenance, limitations, migration, and rollback
  instructions with each Alpha release.

### Phase 6 - Vulnerability response and maintenance policy

- define triage for Dependabot, CodeQL, Trivy, `govulncheck`, npm, secret scans,
  and privately reported vulnerabilities,
- evaluate reachability and relevance without dismissing a finding solely
  because an automated tool cannot prove exploitability,
- identify affected and fixed versions clearly and ship fixes as new immutable
  releases,
- rotate any credential that may have been disclosed; removing it from the
  latest commit is insufficient,
- keep private reports confidential until remediation and coordinated
  disclosure are ready,
- periodically verify that dependency feeds, scanners, pinned actions, base
  images, and security libraries remain maintained,
- state explicitly that automation detects known advisories and patterns, not
  every unknown vulnerability, logic flaw, unsafe deployment, or auth design
  mistake.

### Milestone 20 completion criteria

- Go, npm, Docker, and GitHub Actions dependencies receive automated update and
  security proposals,
- CodeQL, Dependabot alerts/security updates, secret scanning, and push
  protection are enabled and verified where GitHub provides them,
- source and published images are rescanned independently of repository
  activity,
- no dependency pull request can merge without required functional, build,
  runtime, and security checks plus the required human review,
- no dependency automation directly publishes or deploys an image,
- newly disclosed HIGH or CRITICAL issues produce an actionable maintainer
  signal identifying affected artifacts,
- vulnerability response, supported-version, remediation, migration, and
  rollback procedures are documented and exercised,
- Milestones 19 and 20 pass their complete gates before Alpha 2 publication.

## Milestone 21 - Final Alpha 2 Dependency and Toolchain Review

Perform a deliberate final review of every dependency and build-tool release
line after the Alpha 2 functionality and authentication work is complete. The
goal is a current, maintained, reproducible, and vulnerability-free release
baseline, not blindly selecting the numerically newest major version.

### Phase 1 - Complete inventory and currency review

- inventory direct and transitive npm dependencies, Go modules, Docker base
  images, system packages, and pinned GitHub Actions from the final lockfiles,
  image, and SBOM,
- record installed, permitted, and latest available versions for direct
  dependencies and identify unsupported or unmaintained release lines,
- review the final Vite, React, Milkdown, TypeScript, ESLint, Vitest, jsdom,
  Tailwind, PWA, authentication, session, MFA, cryptographic, and SQLite-related
  versions explicitly,
- distinguish production runtime dependencies from build-, test-, and
  development-only tooling,
- review licenses and maintenance status for newly introduced Alpha 2
  dependencies.

### Phase 2 - Controlled updates

- apply compatible patch and minor updates where their release notes and
  transitive changes are acceptable,
- evaluate major upgrades such as Vite, TypeScript, ESLint, Vitest, jsdom, or
  related plugins separately and never combine unrelated majors merely to make
  the version inventory appear current,
- adopt a major upgrade only when its supported runtime requirements,
  compatibility, migration cost, and security benefit justify it,
- document any intentionally retained older major with its reason, support
  status, and a follow-up trigger; an older maintained release without known
  vulnerabilities is acceptable,
- regenerate and commit lockfiles reproducibly and ensure a clean install does
  not create uncommitted dependency changes,
- do not weaken scanner policy, suppress findings, or use force/legacy peer
  resolution merely to complete an upgrade.

### Phase 3 - Full regression and release gate

- run the complete Milestone 20 pull-request and release checks after the final
  dependency set is selected,
- exercise editor serialization, image and asset handling, PWA installation and
  update behavior, Git synchronization and conflict recovery, and all
  Milestone 19 authentication/session/MFA flows,
- build, scan, and smoke-test the final production image for every supported
  CPU architecture,
- require zero unresolved known vulnerabilities at the release policy threshold
  across npm, Go, container OS packages, CodeQL, Dependabot, and secret scans,
- produce the final Alpha 2 SBOM, provenance, dependency inventory, and release
  notes from the exact immutable release candidate,
- publish Alpha 2 only after intentional deferrals are documented and every
  required functional, security, image, and recovery gate passes.

### Milestone 21 completion criteria

- every direct dependency and toolchain component has been reviewed against its
  current maintained releases,
- accepted updates are tested and reflected reproducibly in lockfiles and the
  release image,
- retained older majors have a documented technical reason and remain supported
  without known release-blocking vulnerabilities,
- the final multi-architecture image and complete Alpha 2 application pass all
  Milestone 19 and 20 security and regression gates,
- the released SBOM accurately describes the dependency baseline shipped to
  users.

## Alpha 2 completion criteria

Alpha 2 is ready when:

- the existing multiple-note tab workflow remains stable,
- normal deletion is recoverable through Trash,
- an earlier Git version of a note can be inspected and restored safely,
- portable internal links can be created, followed, and maintained across
  ordinary rename and move operations,
- notebooks can be renamed and safely removed from RepoQuill,
- overlapping file saves and Git synchronization conflicts can be completely
  resolved through a non-technical guided workflow,
- save, synchronization, external-change, and failure states are understandable
  without Git terminology,
- a private notebook can be connected through a guided, actionable onboarding
  flow,
- a single owner can securely authenticate with an optional second factor and
  recover access without placing notebook content under the auth system,
- authentication expiry is handled natively and safely in browser and PWA
  workflows,
- continuous dependency, source, secret, and published-image monitoring is
  active and proposes reviewed updates without unattended merges,
- the final dependency and toolchain baseline has been deliberately reviewed,
  updated where justified, and documented where a maintained older major is
  retained,
- all ten milestones work on desktop and mobile/PWA layouts where a user
  interface is applicable,
- destructive, path-sensitive, Markdown-rewriting, Git-history, and conflict
  recovery behavior plus synchronization wording and onboarding failures are
  covered by focused tests,
- Milestones 19, 20, and 21's dedicated security verification and release gates
  pass,
- no milestone introduces opaque canonical content or weakens Git/provider
  independence.

---

# 46. Alpha Release Criteria

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

# 47. Future Features After Alpha

Potential later features:

- raw Markdown/source mode,
- configurable sync intervals,
- manual sync,
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
- WebDAV-like access only if it remains non-invasive.

Every future feature must preserve the core portability principle.

---

# 48. Features Requiring Special Scrutiny

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

# 49. Coding-Agent Rules

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
15. Keep authentication within the explicit single-owner scope and Milestone 19 security requirements; do not add general account management without another project decision.
16. Never introduce a cloud dependency for core functionality.
17. Treat data loss risks as higher priority than UI convenience.
18. Ask for clarification only when a decision would materially alter architecture or risk data loss; otherwise choose the simplest interpretation consistent with this document.
19. Write a CHANGELOG.md in the Keep a Changelog format

---

# 50. Agent Change Checklist

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

# 51. Project Philosophy

The application should stay boring in all the right ways.

Markdown is storage.

Folders are structure.

Git is history and synchronization.

The browser is the interface.

The application should provide convenience without taking ownership of the data.

The preferred failure mode is:

> The application disappears and the user still has a perfectly ordinary Git repository containing readable Markdown files and images.

That is the product.
