# Alpha 3 candidate ideas (archived plan)

This file preserves roadmap material from the former root `AGENTS.md`. It is not a current commitment or reliable list of unfinished work: items may already be implemented, deferred, or dropped. Before planning from it, check the current `README.md`, `CHANGELOG.md`, `KNOWN-LIMITATIONS.md`, source, and tests.

---

# 46. Alpha 3 Roadmap

Alpha 3 should extend deployment flexibility and maintainability without
weakening RepoQuill's single-owner model, portable Git-backed data model, or
existing local authentication modes.

The recommended implementation order is:

1. split the oversized frontend application component,
2. expose the running version clearly in the UI,
3. establish expanded version-controlled user documentation,
4. add direct OIDC authentication,
5. add local-only notebooks,
6. add managed SSH key rotation,
7. add an optional document outline for long notes,
8. improve code blocks with language selection, syntax highlighting, and copy,
9. refresh safely opened notes after receiving external synchronized changes,
10. correct document statistics so they reflect visible note content,
11. keep the editor formatting toolbar visible while scrolling in the PWA,
12. add a collapsible notebook sidebar for focused and narrow desktop layouts,
13. make GFM task-list checkboxes directly operable with pointer, touch, and
   keyboard input,
14. design and, only after the portability and recovery gates pass, implement
   optional encrypted notes and folders.

OIDC is the highest-priority user-facing Alpha 3 feature. The frontend split is
listed first only as a risk-reducing prerequisite: it must remain a behavior-
preserving refactor and must not delay OIDC through an architectural rewrite.
Documentation may begin in parallel and must be updated as each feature lands.

## Milestone 25 - Behavior-preserving frontend decomposition

Split the oversized `App.tsx` into focused components and hooks while retaining
the existing React state and API architecture where practical.

Initial extraction candidates include:

- notebook onboarding,
- Manage Notebooks,
- conflict resolution,
- synchronization details,
- Trash,
- History,
- Settings and authentication settings.

Requirements:

- preserve all existing UX, accessibility, responsive behavior, and API calls,
- make small reviewable extractions rather than one wholesale rewrite,
- keep shared state ownership explicit and avoid introducing a new global state
  framework without a demonstrated need,
- add or retain regression coverage around every extracted workflow,
- do not combine the refactor with unrelated feature or design changes.

Completion criteria:

- `App.tsx` primarily composes focused application areas instead of containing
  their complete implementations,
- extracted areas remain independently understandable and testable,
- existing frontend, end-to-end, mobile/PWA, authentication, and synchronization
  behavior remains unchanged.

## Milestone 26 - Expanded user documentation

Keep the README as a compact project introduction and quick-start guide. Build
expanded documentation for users and self-hosting operators covering:

- installation and upgrades,
- first-time setup and everyday use,
- local authentication, MFA, recovery, and disabled-auth mode,
- notebook setup for GitHub, GitLab, Gitea, Forgejo, and generic Git servers,
- synchronization states and conflict resolution,
- backup, restore, and disaster recovery,
- PWA installation and limitations,
- reverse proxy and troubleshooting guidance,
- OIDC after Milestone 27 is implemented.

Prefer a version-controlled `docs/` source in the main repository so changes are
reviewed, versioned, searchable, and shipped with the matching release. A GitHub
Wiki may provide an additional presentation layer, but must not become the only
maintained copy of essential operational or recovery documentation.

Completion criteria:

- a new user can deploy, secure, connect, use, back up, and troubleshoot
  RepoQuill without reading milestone specifications,
- documentation distinguishes saved, committed, and remotely synchronized data,
- security-sensitive guidance matches the exact released behavior,
- README links clearly to the expanded documentation.

## Milestone 27 - Direct OIDC authentication

Add standards-based OIDC authentication for providers such as Authentik,
Authelia, Keycloak, and other compatible identity providers.

The IdP authenticates the owner. After a successful callback, RepoQuill creates
and manages its own normal application session. Do not implement this as classic
forward-auth in front of every browser or API request.

Requirements:

- retain `local` password authentication and explicit `disabled` mode,
- use a focused, maintained OIDC library and Authorization Code flow with PKCE,
- validate issuer, discovery metadata, state, nonce, signature, audience, and
  redirect URI according to the OIDC specification,
- explicitly bind access to the configured single owner; successful login at
  the IdP must not become open registration or multi-user access,
- keep client secrets and tokens out of frontend storage, URLs, logs, notebook
  repositories, and diagnostics,
- issue the same hardened RepoQuill application-session boundary used by local
  authentication after successful OIDC authentication,
- make MFA, password recovery, and identity lifecycle the IdP's responsibility
  in OIDC mode,
- provide actionable setup and failure diagnostics without leaking secrets,
- preserve safe browser/PWA session-expiry and logout behavior,
- document reverse-proxy, TLS, callback URL, and provider configuration.

Do not add account registration, roles, organizations, invitations, or a custom
OAuth/OIDC implementation.

Completion criteria:

- representative Authentik, Authelia, and Keycloak configurations are tested,
- an unbound IdP identity cannot become the RepoQuill owner,
- replay, callback tampering, invalid issuer/audience, expired tokens, and login
  CSRF are rejected by focused tests,
- local and disabled modes continue to work unchanged,
- OIDC sessions work reliably in browser and installed PWA usage.

## Milestone 28 - Local-only Git notebooks

Allow creation of a notebook without a remote service. The notebook must still
be an ordinary local Git repository, but initially has no `origin` remote.

Requirements:

- initialize a normal repository and branch inside the managed notebook root,
- keep notes and assets fully portable and visible as regular Git content,
- retain local commits, History, Trash/Restore, and recovery behavior,
- describe the notebook as local-only rather than reporting missing remote sync
  as a failure,
- hide or adapt remote-only synchronization actions and scheduling clearly,
- provide a deliberate later workflow for adding and validating a remote,
- never require provider APIs or silently create a hosted repository,
- preserve all path-safety, concurrency, and data-safety rules.

Completion criteria:

- a local-only notebook can be created, edited, versioned, restored, restarted,
  backed up, and removed from RepoQuill safely,
- absence of `origin` never produces a misleading synchronization error,
- adding a compatible remote later preserves existing history and never force
  pushes or discards either side silently.

## Milestone 29 - Managed SSH key rotation

Add a guided, non-destructive rotation workflow for managed notebook SSH keys.

Required sequence:

1. generate a new managed key without modifying the old key,
2. show the new public key for registration at the Git provider,
3. test host trust and repository access with the new key,
4. switch selected notebooks only after a successful test and confirmation,
5. leave the old key unassigned or assigned to notebooks not yet migrated,
6. instruct the operator to remove the old public key at the provider,
7. optionally delete the unassigned local private key through the existing
   deliberate key-management safeguards.

Requirements:

- never replace key material in place,
- never make the current key unusable before the replacement is verified,
- support rotating notebooks independently and show remaining assignments,
- prevent deletion of keys that are still assigned,
- avoid logging, exporting, or exposing private key material,
- preserve explicit SSH host fingerprint trust and repository connection tests,
- provide recovery guidance when a provider update or test fails midway.

Completion criteria:

- a key can be rotated without notebook downtime or loss of repository access,
- partial and failed rotations leave the previous working configuration intact,
- key assignment, cleanup, audit-safe diagnostics, and mobile/PWA workflows are
  covered by focused tests.

## Milestone 30 - Visible application version

Show the exact running RepoQuill version in a discoverable, unobtrusive place in
the application UI, such as an About area in Settings and a compact application
footer or equivalent mobile-safe location.

Requirements:

- use the backend-provided build version as the single source of truth,
- display the immutable release version, including alpha and maintenance
  suffixes, without inventing a separate frontend version,
- show `dev` clearly for unversioned local development builds,
- keep the version accessible on desktop and mobile/PWA without competing with
  note content or document save/synchronization state,
- provide a copyable version value for support and diagnostics,
- do not expose commit, host, path, or other deployment details unless they are
  deliberately added to a separate sanitized diagnostics view.

Completion criteria:

- the owner can identify the exact running release from the UI,
- container build metadata, backend API, UI, changelog, and Git tag agree for a
  release,
- version rendering and the `dev` fallback have focused tests.

## Milestone 31 - Optional encrypted notes and folders

Investigate and add deliberate opt-in encryption for selected notes and folders.
This milestone requires an explicit design and threat-model review before code
is implemented because opaque ciphertext changes RepoQuill's ordinary-Markdown
portability guarantee.

Design gates:

- define whether encryption protects Git remotes and backups, the server's disk,
  or also a compromised running RepoQuill server; do not claim protections the
  chosen design cannot provide,
- select a documented, interoperable encrypted file format that can be decrypted
  with maintained tools outside RepoQuill; recovery must never require the
  RepoQuill application itself,
- document which metadata remains visible, including filenames, folder layout,
  file sizes, modification patterns, Git history, and asset relationships,
- define password/key creation, unlocking, rotation, backup, export, and loss
  recovery before encrypted content can be created,
- decide how encrypted images/assets, search, History, Trash, conflict
  resolution, PWA behavior, autosave, and Git synchronization work without
  leaking plaintext,
- obtain an explicit product decision for the limited portability exception:
  encrypted content remains ordinary repository files but is not directly
  readable as plain Markdown until decrypted with compatible external tooling.

Security requirements:

- use a focused, maintained cryptographic library and established authenticated
  encryption; never design custom cryptography or silently downgrade encryption,
- never commit plaintext copies, keys, passwords, recovery material, editor
  caches, previews, search indexes, temporary files, or logs to the notebook,
- keep encrypted and unencrypted content clearly distinguishable and require
  deliberate confirmation when changing protection state,
- fail closed on corrupt data, missing keys, authentication failure, interrupted
  writes, and unsupported format versions while preserving the original bytes,
- use atomic writes and retain a documented external recovery/decryption path,
- prevent sensitive plaintext from entering browser-persistent storage or the
  service-worker cache,
- cover key handling, path confinement, tampering, rollback, mixed encrypted and
  plain folders, backups, conflicts, and recovery with adversarial tests and an
  independent security review.

Completion criteria:

- selected notes and complete folder trees can be encrypted, unlocked, edited,
  synchronized, backed up, restored, and deliberately decrypted without data
  loss,
- an external documented tool can recover the Markdown and assets without
  RepoQuill,
- losing the encryption secret is clearly explained as unrecoverable and cannot
  silently damage unencrypted notebooks,
- encrypted content never appears in plaintext in Git, application metadata,
  logs, caches, recovery artifacts, or unencrypted assets,
- the feature does not ship until its threat model, format, recovery procedure,
  migration behavior, and security review are complete.

## Milestone 32 - Document outline / table of contents

Add an optional, contextual document outline generated from the headings of the
currently open note. Treat this as navigation UI rather than persisted note
content.

Desktop interaction:

- add a clear Outline / Table of contents button to the note editor toolbar,
- open a collapsible panel on the right side of the editor,
- keep the panel visually subordinate to the note and allow it to be closed at
  any time,
- remember the local open/closed preference without writing UI state into the
  notebook repository.

Mobile/PWA interaction:

- use the same toolbar action,
- open the outline as a touch-friendly drawer or sheet instead of permanently
  reducing the editor width,
- close the drawer after the user chooses a heading and move focus safely back
  to the note.

Requirements:

- derive the hierarchy from ordinary Markdown Heading 1-6 nodes in the active
  Milkdown/ProseMirror document,
- update the outline while headings are added, renamed, removed, or reordered,
- clicking an entry scrolls to the exact heading without inserting generated
  anchors, `[TOC]` syntax, IDs, frontmatter, or other proprietary Markdown,
- handle duplicate heading text by document position rather than assuming that
  heading labels are unique,
- show the current document section while scrolling where this can be done
  reliably without disrupting editing,
- preserve indentation and heading-level relationships while remaining readable
  when levels are skipped,
- provide a compact empty state when the note contains no headings,
- work in both Edit and Read only modes,
- expose semantic navigation, keyboard operation, visible focus, accessible
  labels, and adequate touch targets,
- avoid expensive full-document reparsing on every keystroke and test behavior
  with long notes.

Completion criteria:

- the outline opens from the editor toolbar only when a note is active,
- desktop uses the collapsible right-side panel and mobile/PWA uses a drawer or
  equivalent narrow-layout presentation,
- heading selection navigates accurately for nested and duplicate headings,
- live editing updates the hierarchy without changing serialized Markdown,
- opening, closing, navigation, empty state, accessibility, Read only behavior,
  and responsive presentation have focused tests.

## Milestone 33 - Code block language and copy UX

Improve fenced code blocks while keeping standard Markdown as the canonical
representation.

Requirements:

- show a compact `Copy` action on code blocks in both Edit and Read only modes,
- copy only the literal code content without fence markers, language metadata,
  line numbers, or formatting,
- provide readable success and failure feedback that does not rely on color and
  does not trigger browser modal dialogs,
- expose a contextual language selector when a code block is selected in Edit
  mode,
- offer `Plain text` plus a focused initial set of common languages such as
  Shell/Bash, PowerShell, Python, JavaScript, TypeScript, JSON, YAML, Markdown,
  HTML, CSS, SQL, Go, and Dockerfile,
- serialize the selected language through the ordinary fenced-code info string,
  for example ` ```python ` or ` ```bash `,
- preserve valid unknown language identifiers already present in imported
  Markdown even when RepoQuill cannot highlight them,
- apply syntax highlighting as presentation only; it must never rewrite code,
  execute code, fetch language definitions from untrusted locations, or persist
  generated HTML into Markdown,
- use a maintained highlighting library with an explicitly controlled language
  set, safe token rendering, acceptable bundle size, and compatible licensing,
- keep unrecognized or malformed language metadata readable as unhighlighted
  plain code,
- make Copy and language selection keyboard-accessible and touch-friendly
  without obscuring code on narrow/mobile layouts,
- retain the existing Enter behavior for writing and leaving code blocks.

Completion criteria:

- newly selected languages round-trip through portable fenced Markdown,
- imported recognized and unknown language tags survive load/edit/save without
  silent loss,
- highlighting never changes copied or serialized code content,
- Copy works reliably in browser and installed PWA contexts with accessible
  feedback and a safe failure state,
- plain, highlighted, long, horizontally scrolling, duplicate, Read only, and
  mobile code blocks have focused tests.

## Milestone 34 - Collapsible notebook sidebar

Allow users to hide the left notebook and file-tree sidebar when they need more
horizontal space, especially on portrait-oriented or otherwise narrow desktop
monitors.

Requirements:

- provide a clear, keyboard-accessible control that collapses the complete
  notebook/file-tree sidebar without closing the active note,
- keep a compact and discoverable control available to restore the sidebar,
- preserve the active notebook, selected note, open note tabs, unsaved editor
  state, and expanded folder state while the sidebar is hidden,
- remember the user's local collapsed/expanded preference without storing UI
  state in a notebook repository,
- let the editor and its toolbars use the released horizontal space without
  introducing fixed-width gaps or horizontal page scrolling,
- retain the existing mobile drawer behavior instead of treating a hidden
  desktop sidebar as a replacement for mobile navigation,
- use accessible labels, visible focus, suitable touch targets, and state
  semantics such as `aria-expanded`,
- avoid hiding save, synchronization, authentication, or conflict status along
  with the navigation.

Completion criteria:

- the sidebar can be collapsed and restored without navigating away from or
  reloading the active note,
- editor width responds correctly on landscape, portrait, and narrow desktop
  layouts,
- the preference survives a browser reload on the same client,
- desktop keyboard interaction and the existing mobile/PWA drawer behavior have
  focused tests.

## Milestone 35 - Accurate document statistics

Correct the editor status-bar statistics so they describe the content a user
can actually read instead of counting the raw serialized Markdown source.

Current defect:

- `documentStats` operates directly on Markdown source text,
- serialized hard-break syntax such as `<br />` contributes several characters
  and the false word `br`,
- an empty new paragraph can therefore increase the word count,
- image alt text, generated asset names, and relative asset paths are counted
  even though the image is a single non-text document node.

Required behavior:

- derive statistics from parsed Markdown/editor document semantics rather than
  applying a word expression to the complete Markdown source,
- count visible prose, headings, list text, quotations, link labels, inline
  code, and code-block contents while excluding their Markdown delimiters,
- exclude link destinations and Markdown metadata from word and character
  counts,
- count every image node as zero words and zero characters regardless of its
  alt text, title, source filename, generated asset filename, or path,
- treat soft breaks, hard breaks, empty paragraphs, and line-ending encodings as
  zero words and zero characters; they may affect only the line count,
- count user-perceived Unicode characters consistently where browser support
  permits, rather than inflating composed characters or emoji sequences,
- define line count from logical document lines/blocks consistently in Edit and
  Read only modes without changing serialized Markdown,
- update statistics live without adding noticeable work to normal typing,
- keep the status-bar labels and responsive layout unchanged.

Completion criteria:

- Enter and Shift+Enter never create phantom words or characters,
- a blank line changes only the documented line statistic,
- inserting, replacing, resizing, or changing metadata for an image does not
  change word or character counts,
- Markdown syntax and asset/link destinations do not inflate visible-text
  statistics,
- prose, Unicode text, headings, lists, links, inline/code blocks, line endings,
  empty paragraphs, hard breaks, and images have focused unit tests,
- Edit and Read only modes report identical statistics for the same note.

## Milestone 36 - Refresh opened notes after external synchronization

Refresh the editor after a successful synchronization receives an external
change to the note currently being viewed, without weakening draft or conflict
protection.

Current defect:

- Git synchronization updates the notebook working tree and reloads the file
  tree but does not reload the active note,
- `receivedChanges` informs the user about the remote update while the editor
  continues showing its pre-sync `FileResponse`, content, and version,
- the note becomes current only after a full browser reload or after navigating
  away and opening it again,
- the existing synchronization UI test explicitly preserves this stale-view
  behavior and must be replaced with the intended safe-refresh behavior.

Required behavior:

- after a successful, conflict-free synchronization, inspect received `added`,
  `updated`, `moved`, and `deleted` changes against the active note,
- when the active note was updated externally and has no unsaved local editor
  changes, fetch its current server representation and atomically replace the
  displayed content, version, active draft baseline, and editor document,
- force Milkdown to consume the refreshed document without requiring browser
  reload, tab switching, or note switching,
- refresh identically after manual, scheduled, inactivity, startup, focus, and
  safe note-switch synchronization triggers,
- never replace editor content when typing or another unsaved local change
  occurred while synchronization was running,
- revalidate the active notebook, selected path, note version, and local-change
  generation before applying an asynchronous reload so a late response cannot
  replace a newly selected note,
- preserve the current optimistic version/conflict workflow whenever local and
  external edits overlap; never silently prefer the remote copy,
- handle external rename/move by updating the relevant open tab and selected
  path where the received-change metadata proves the identity safely,
- handle external deletion with a clear non-destructive state that preserves
  any local draft and lets the user deliberately close or recover it,
- keep unrelated open tabs available; inactive tabs must load the latest server
  content when activated,
- retain the received-changes notice as useful history, but do not require it as
  the mechanism for refreshing a safely reloadable active note.

Completion criteria:

- an externally modified active note updates immediately after successful sync,
- the refreshed version becomes the new save baseline and subsequent edits do
  not cause a false conflict,
- external changes to inactive tabs appear when those tabs are activated,
- edits made before or during synchronization are never discarded,
- update, rename/move, deletion, unrelated-note changes, multi-tab behavior,
  Read only mode, and every automatic sync trigger have focused tests,
- delayed fetch and note-switch race tests prove that stale asynchronous
  responses cannot replace the wrong editor document.

## Milestone 37 - Sticky editor toolbar in mobile/PWA layouts

Keep the Milkdown formatting toolbar available while scrolling through a long
note, including in the installed standalone PWA and narrow mobile layouts.

Current defect:

- the note-level Edit/Read only, Save, History, and Sync header is sticky,
- the Milkdown formatting and contextual toolbars remain ordinary content
  inside the note article and scroll out of view,
- `--editor-toolbar-top` is calculated from the app-header/tab layout but is not
  currently applied to the editor-toolbar container.

Required behavior:

- make the primary editor formatting toolbar sticky below the app header and
  optional note-tab row while a note is open,
- calculate the offset from the actual visible header/tab layout so the toolbar
  never hides underneath or overlaps those controls,
- keep contextual table, image, and internal-link toolbars directly below the
  primary formatting toolbar when their respective content is selected,
- allow toolbar actions to remain horizontally scrollable on narrow screens
  without causing the complete page or editor to scroll sideways,
- preserve the current document scroll position, editor selection, focus, and
  software-keyboard interaction when using a toolbar action,
- account for installed-PWA safe areas and changing mobile visual viewport
  height without adding permanent empty space,
- avoid covering the selected text, document heading, slash-command menu,
  dialog, or contextual controls with stacked sticky elements,
- show the toolbar only where document editing context is meaningful and retain
  all existing Read only disabling rules,
- use the same behavior in browser and standalone display modes rather than
  maintaining a PWA-specific duplicate toolbar.

Completion criteria:

- the formatting toolbar remains visible after scrolling to the bottom of a
  long note in the installed PWA,
- layouts with and without note tabs use the correct sticky offset,
- contextual table and image toolbars remain reachable and do not overlap the
  primary toolbar,
- portrait phone, landscape phone, narrow desktop, standalone PWA, browser,
  and opened software-keyboard layouts have focused responsive tests,
- scrolling, formatting, editor focus, and touch interaction continue working
  without document jumps or hidden controls.

## Milestone 38 - Markdown-aware paste UX

Make pasted Markdown optionally become the corresponding rendered editor
structure instead of always inserting its syntax as ordinary text.

Current behavior and cause:

- Milkdown's CommonMark and GFM parsers are used when a note document is
  loaded, but RepoQuill does not currently pass pasted plain text through that
  Markdown parser,
- ProseMirror therefore preserves plain clipboard text literally; input rules
  that react while typing do not retrospectively parse a pasted block,
- clipboard HTML may retain schema-supported rich structure through
  ProseMirror's normal paste path, while the existing upload plugin separately
  handles pasted image files,
- raw Markdown copied from a source editor normally arrives as `text/plain`
  and is consequently shown as literal `#`, `-`, backtick, and table syntax.

Required behavior:

- support an explicit, discoverable **Paste as Markdown** path on desktop and
  mobile/PWA,
- parse `text/markdown` clipboard content as Markdown when the browser provides
  that unambiguous media type,
- preserve ordinary paste and paste-as-plain-text behavior so text containing
  incidental Markdown characters is not reformatted unexpectedly,
- only consider conservative smart detection for `text/plain` after ambiguous
  examples such as shell commands, source code, and prose punctuation are
  covered by tests; an explicit choice is preferable to destructive guessing,
- support portable CommonMark/GFM structures already understood by the editor,
  including headings, emphasis, lists, task lists, blockquotes, fenced code,
  links, tables, and horizontal rules,
- insert the parsed result at the current selection as one undoable editor
  operation and keep the existing autosave/status behavior,
- retain the current clipboard screenshot/image upload workflow and never
  download or upload arbitrary URLs merely because pasted Markdown references
  an image,
- keep HTML handling schema-constrained and do not introduce unsafe raw-HTML
  insertion or `dangerouslySetInnerHTML`,
- keep Read only mode non-mutating and provide touch-accessible behavior that
  does not depend only on a desktop keyboard shortcut,
- define clear behavior for invalid or unsupported Markdown: preserve the
  original clipboard text and explain any explicit conversion failure without
  losing clipboard content.

Completion criteria:

- pasted explicit Markdown can become the expected Milkdown document nodes
  without requiring the user to retype it,
- normal plain-text, rich HTML, image, code, and Read only paste paths retain
  their intended behavior,
- relative links and image references remain portable Markdown and no external
  asset is fetched implicitly,
- conversion, selection replacement, undo/redo, autosave serialization,
  mobile/PWA access, and ambiguous clipboard inputs have focused tests.

Status: completed on 2026-09-29. RepoQuill now provides an explicit
touch-accessible Paste as Markdown dialog, handles unambiguous `text/markdown`
clipboard data, preserves ordinary paste paths, inserts conversions as one
undoable transaction, and refuses active raw HTML or external image references
without discarding their source text.

## Milestone 39 - Unambiguous internal-note link trigger

Prevent ordinary square brackets and Markdown task-list syntax from opening or
leaving behind the internal-note suggestion menu.

Current behavior and cause:

- the internal-note trigger currently accepts either `[[` or a single `[`,
  because Milkdown may normalize two typed opening brackets before the existing
  document listener observes them,
- this also treats ordinary bracketed text and task-list input such as
  `- [ ]` or `- [x]` as possible note-link queries,
- the suggestion menu has no independent outside-click, blur, or timeout
  cleanup, so a task-list transformation can leave `No matching notes` visible
  after the original trigger context is gone.

Required behavior:

- activate internal-note suggestions only after an intentional `[[` sequence,
  detected before editor input normalization loses that distinction,
- never open the note suggestions for a single bracket, ordinary bracketed
  prose, Markdown links, or unchecked and checked task-list syntax,
- keep the existing portable result: selecting a note must still serialize to
  an ordinary relative Markdown link rather than proprietary wiki-link syntax,
- close the menu when the trigger becomes invalid, including after `]`, Escape,
  focus loss, an outside interaction, selection movement, block conversion,
  note change, and Read only transition,
- keep keyboard navigation, touch selection, missing-note behavior, editor
  focus, and autosave behavior intact,
- use one implementation in browser and standalone PWA layouts.

Completion criteria:

- typing `[[` opens note suggestions and selecting a result produces the same
  portable relative Markdown link as today,
- typing `[ordinary text]`, `- [ ] Task`, and `- [x] Task` never opens or leaves
  behind the note-suggestion menu,
- empty results cannot remain visible after their trigger context disappears,
- trigger, dismissal, keyboard, pointer/touch, task-list, Read only, and note-
  switching behavior have focused regression tests.

## Milestone 40 - Transient received-changes notification

Keep users informed when synchronization receives external notebook changes
without leaving a permanent informational banner above the editor.

Current behavior and cause:

- successful synchronization stores received-change metadata in one
  `receivedChanges` state value,
- that same value controls both the persistent top-level notification and the
  useful `Recently received changes` list in synchronization details,
- the banner has a manual dismissal action but no automatic lifetime, and
  dismissing it also discards the detail list for the current session.

Required behavior:

- separate received-change history from the transient banner's visibility,
- automatically hide the informational banner after a short, documented
  interval such as 10-15 seconds while retaining the changes in synchronization
  details,
- restart the visibility interval when a later synchronization receives a new
  batch of external changes,
- pause or defer automatic dismissal while the banner or one of its controls is
  hovered, keyboard-focused, or actively touched,
- keep manual dismissal available and make it hide only the banner,
- opening a changed note from the banner must remain available and may dismiss
  the banner without removing the retained detail history,
- clear retained history at the appropriate notebook boundary so changes from
  one notebook are never shown for another,
- never auto-dismiss conflicts, failures, recovery drafts, destructive-action
  confirmations, or any state that requires a user decision,
- retain accessible status text and avoid communicating receipt or dismissal
  through animation or color alone.

Completion criteria:

- a successful sync with external changes shows a concise notification and it
  disappears automatically without a refresh or manual close,
- the same received changes remain available under synchronization details
  after automatic or manual banner dismissal,
- a newer received-change batch replaces or clearly updates the previous
  transient notification and receives a fresh display interval,
- timer cleanup, hover/focus/touch pausing, manual dismissal, changed-note
  opening, notebook switching, and non-dismissible error/conflict states have
  focused browser and PWA regression tests.

## Milestone 41 - Interactive and accessible task-list checkboxes

Fix task-list items so users can mark them complete directly inside the note
editor while retaining ordinary portable GFM Markdown.

Current behavior and cause:

- Milkdown's GFM schema already parses `- [ ]` and `- [x]` into a `checked`
  list-item attribute and serializes that attribute back to Markdown correctly,
- RepoQuill currently draws the visible checkbox only with a CSS `::before`
  pseudo-element,
- that pseudo-element is not a focusable or actionable control and no editor
  pointer, touch, or keyboard handler changes the `checked` attribute,
- the existing Task list toolbar action changes between a normal list item and
  a task item; it does not mark an existing task complete.

Required behavior:

- provide a real, clearly discoverable task-checkbox control for every GFM task
  item in Edit mode,
- toggle unchecked and checked state with mouse, touch, Space, and Enter,
- expose appropriate checkbox semantics and state to assistive technology and
  retain a visible focus indicator,
- use a touch-friendly target without making clicks on the task text itself
  toggle the checkbox unexpectedly,
- update the list item's `checked` attribute through one normal undoable
  ProseMirror transaction so existing autosave and document status behavior
  continue to apply,
- serialize only standard GFM task markers (`[ ]` and `[x]`) with an ordinary
  Markdown bullet marker; do not add custom syntax, application metadata, or
  backend state,
- show checked state clearly in Read only mode while preventing every mutation
  path there,
- preserve cursor placement, text selection, nested task lists, mixed ordinary
  and task lists, list indentation, toolbar actions, and slash commands,
- preserve existing task state across save, reload, external editors, Git
  synchronization, history, and conflict resolution,
- evaluate Milkdown's list-item block component where useful, but do not adopt
  it blindly if it changes ordinary-list behavior or fails RepoQuill's keyboard,
  accessibility, mobile, or Read only requirements,
- use the same implementation in browser and installed PWA layouts.

Completion criteria:

- clicking or tapping an unchecked task changes its GFM marker to `[x]`, and
  toggling it again restores `[ ]`,
- Space and Enter operate a focused task checkbox without moving or corrupting
  the note text,
- each toggle participates in Undo/Redo and the normal autosave state flow,
- regular bullet and numbered lists remain unchanged and their markers do not
  become interactive task controls,
- Read only mode cannot change task state through pointer, touch, or keyboard
  input,
- checked, unchecked, nested, mixed-list, reload, selection, Undo/Redo,
  autosave, desktop, mobile/PWA, and assistive-technology semantics have focused
  regression tests.

Status: completed on 2026-09-29. RepoQuill now renders GFM task items with a
real accessible checkbox control, toggles their standard Markdown state through
undoable editor transactions, retains state after serialization and reload, and
keeps normal and Read only list behavior intact. Focused regression coverage
includes pointer and keyboard activation, text-click isolation, Undo/Redo,
nested and mixed lists, reload, and non-mutating Read only behavior.

---


# 48. Future Features After Alpha

Potential later features:

- raw Markdown/source mode,
- OIDC authentication,
- provider-specific repository creation,
- GitHub integration,
- GitLab integration,
- Forgejo/Gitea integration,
- custom slash snippets,
- templates,
- optional note metadata/frontmatter,
- configurable editor preferences,
- import helpers,
- export convenience tools,
- WebDAV-like access only if it remains non-invasive.

Every future feature must preserve the core portability principle.

---

# 49. Features Requiring Special Scrutiny

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
