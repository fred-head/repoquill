# Alpha release and recovery guide

This checklist is for operators evaluating and upgrading RepoQuill. CI remains
the publication gate; do not promote an image that has not passed the release
workflow and security checks.

## Before an upgrade

1. Record the current immutable image tag or digest.
2. In the old browser app, save open notes and resolve any recovery-draft or
   conflict prompt. The rebooted app clears legacy browser-stored note drafts at
   startup, and browser storage is not included in `/data` backups.
3. Stop the service and back up the complete `/data` volume.
4. Confirm the backup includes all vault directories, `/data/app/notebooks.json`,
   `/data/app/auth.db`, and `/data/app/auth.key` when present.
5. Verify that the backup can be listed and that a restore procedure is
   available.

Operators choose backup schedule, retention, off-site storage, and restore
testing. RepoQuill's ZIP export is an owner-triggered portable copy of a vault,
not a backup service.

## Git-free storage transition

The rebooted application stores each vault as an ordinary directory under the
configured vault root. Existing registered directories remain registered and
are opened in place. Markdown and asset files are not rewritten during
adoption. New vaults are created as plain folders; there is no Git or SSH
runtime requirement.

Before starting the new image, preserve the old `/data` volume. Existing `.git`
directories and managed SSH key files are left on disk; RepoQuill no longer
reads, uses, or deletes them. Old commits may contain deleted notes or secrets.
On first startup, obsolete remote URLs, branch settings, and SSH-key
assignments are removed from the vault registry; the key files themselves are
left untouched.
The application cannot erase copies in old commits or operator backups. Treat
their review and any cleanup as a separate operator migration with its own
verified backup.

After the upgrade, sign in and verify the registered vault list, representative
notes, assets, Trash, and export. Confirm that each device sees the same server
vault while online. The PWA must not load or save note content when the server
is unavailable.

## Rollback

Do not start an older image against new application metadata without checking
compatibility. If a rollback needs the earlier registry or auth state, stop
the service and restore the matching full `/data` backup before starting the
previous immutable image. Vault Markdown and assets remain ordinary files,
but old app versions may expect Git or SSH configuration that the new runtime
no longer uses.

## Release verification

For each exact candidate image, verify:

- local authentication setup, sign-in, MFA, session expiry, and password/MFA
  recovery;
- vault creation, existing-folder adoption, activation, rename, removal, and
  ZIP export;
- create, open, edit, and save Markdown notes and ordinary assets;
- a stale browser save preserves both the browser draft and current server
  version for an explicit decision;
- Trash restore and permanent deletion, including the documented backup
  retention semantics;
- no note or asset API response is served from a browser or service-worker
  cache;
- the production image operates without Git, OpenSSH, repository remotes,
  SSH credentials, or SSH configuration;
- the image remains unprivileged, read-only at the container root, and
  persistent through the documented `/data` volume.

Verify the image digest and release attestation, then update the release notes,
upgrade instructions, [README](README.md), [Known Limitations](KNOWN-LIMITATIONS.md),
and [Changelog](CHANGELOG.md) before publication.
