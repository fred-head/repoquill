# Known Alpha Limitations

RepoQuill `0.1.0-alpha.1` is an evaluation release. The following limitations
are deliberate or currently accepted and should be understood before using it
with important notebooks.

## Deployment and access

- RepoQuill has no built-in authentication, authorization, account isolation, or
  TLS termination. It must run behind a trusted HTTPS authentication layer.
- The V0.1 ownership model assumes one active backend instance for each notebook
  working tree. Multiple backend writers are unsupported.
- Managed SSH deploy keys and approved host identities live on the persistent
  `/data` volume. Losing that volume can require credential re-enrollment even
  when notes remain recoverable from a Git remote.

## Editing and synchronization

- The PWA is online-first. The application shell may load without a connection,
  but offline note editing and queued synchronization are not supported.
- Browser-close synchronization is best effort because a browser may terminate
  before delivering the request. It is not a backup guarantee.
- Concurrent edits to the same note are not merged collaboratively. Version
  checks prevent known stale browser writes, while Git conflicts stop automatic
  synchronization and require manual resolution with a normal Git client.
- Git synchronization groups pending working-tree changes into ordinary
  commits. RepoQuill does not expose staging or per-file commit composition.
- Removing an image reference does not automatically delete its stored asset.
  Unreferenced asset cleanup is a separate, explicit maintenance operation.

## Portability and compatibility

- Notes are stored as ordinary CommonMark/GFM Markdown, but rendering details can
  differ between Markdown applications.
- Image ownership follows the `<note>.assets/` convention. Assets outside this
  convention are not managed as note-owned uploads.
- Symbolic links are intentionally rejected or ignored rather than followed.
- Provider-specific repository creation is not included; notebook onboarding
  requires an existing compatible SSH Git repository.

## Release expectations

- Only the newest alpha is expected to receive fixes.
- Alpha configuration and UI behavior may change between prereleases. Canonical
  Markdown and asset files will remain application-independent.
- Test upgrades with a backup or disposable copy before replacing an important
  installation.

Accepted limitations should be tracked publicly rather than hidden. Security
issues must be reported privately as described in [SECURITY.md](SECURITY.md).
