# Known Alpha Limitations

RepoQuill Alpha 2 remains evaluation software. The following limitations are
deliberate or currently accepted and should be understood before using it with
important notebooks.

## Deployment and access

- Alpha 2 adds a single-owner password boundary with optional TOTP MFA. It is
  not a multi-user authorization system, and TLS termination remains the
  operator's responsibility for Internet-facing deployments.
- Explicit `disabled` mode has no built-in authentication and is suitable only
  behind a deliberately managed LAN, VPN, or external access boundary.
- OIDC is deferred. RepoQuill has no multi-user accounts, roles, registration,
  email recovery, or phishing-resistant authentication factor.
- A stolen authenticated session retains owner authority until it expires or is
  revoked. TOTP does not protect an already stolen session, and TOTP itself is
  not phishing-resistant.
- The V0.1 ownership model assumes one active backend instance for each notebook
  working tree. Multiple backend writers are unsupported.
- Managed SSH deploy keys and approved host identities live on the persistent
  `/data` volume. Losing that volume can require credential re-enrollment even
  when notes remain recoverable from a Git remote.
- Local-auth metadata and the separate MFA encryption key also live on the
  persistent volume. Loss of the key requires an explicit operator MFA reset;
  neither auth recovery nor auth metadata loss changes notebook files.

## Editing and synchronization

- The PWA is online-first. The application shell may load without a connection,
  but offline note editing and queued synchronization are not supported.
- Standard Markdown images may reference external HTTP(S) servers. Opening such
  a note can contact that server and disclose the client's IP address even
  though RepoQuill sends a no-referrer policy. Use note-owned assets when this
  privacy tradeoff is not acceptable.
- Browser-close synchronization is best effort because a browser may terminate
  before delivering the request. It is not a backup guarantee.
- Concurrent edits to the same note are not merged collaboratively. Version
  checks prevent known stale browser writes, while overlapping changes stop
  automatic synchronization and open RepoQuill's guided conflict review. The
  original versions and a Git recovery point are preserved while the owner
  chooses the resulting note or asset.
- In-progress guided conflict decisions are retained only in the current tab's
  browser session so an accidental reload can be recovered. They are cleared
  on logout/session expiry and are not an offline queue or durable backup.
- RepoQuill does not provide collaborative editing, CRDT merging, or multiple
  backend writers. External tools can still create overlapping versions that
  require the guided conflict review.
- Git synchronization groups pending working-tree changes into ordinary
  commits. RepoQuill does not expose staging or per-file commit composition.
- Removing an image reference does not automatically delete its stored asset.
  Unreferenced asset cleanup is a separate, explicit maintenance operation.
- Image presentation sizes are optional RepoQuill metadata and therefore do not
  appear in other Markdown applications. Repeated references to the same asset
  in one note share a size. Trashing and later restoring a note preserves its
  Markdown and assets but resets those image sizes to the default presentation.

## Portability and compatibility

- Notes are stored as ordinary CommonMark/GFM Markdown, but rendering details can
  differ between Markdown applications.
- Image ownership follows the `<note>.assets/` convention. Assets outside this
  convention are not managed as note-owned uploads.
- Symbolic links are intentionally rejected or ignored rather than followed.
- Provider-specific repository creation is not included; notebook onboarding
  requires an existing compatible SSH Git repository.
- GitHub Apps, OAuth, HTTPS/PAT Git credentials, and automatic remote creation
  are not implemented. GitHub's guided setup is an SSH deploy-key workflow;
  other compatible Git services remain supported through SSH.

## Release expectations

- Only the newest alpha is expected to receive fixes.
- Alpha configuration and UI behavior may change between prereleases. Canonical
  Markdown and asset files will remain application-independent.
- Test upgrades with a backup or disposable copy before replacing an important
  installation.

Accepted limitations should be tracked publicly rather than hidden. Security
issues must be reported privately as described in [SECURITY.md](SECURITY.md).
