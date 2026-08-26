# RepoQuill Alpha Release Guide

## Release scope

RepoQuill Alpha releases provide portable Markdown editing, folders and file
operations, note-owned images, explicit unused-asset cleanup, Git
synchronization, multiple notebooks, search, responsive PWA behavior, and
editor productivity controls.

The canonical data remains ordinary Git working trees. Until Milestone 19 is
complete, RepoQuill has no built-in authentication and must be deployed behind
a trusted HTTPS authentication layer.

## Release preflight

Before creating an immutable release tag:

1. Confirm the intended version appears consistently in the changelog, source
   metadata, examples, and release tag.
2. Require every protected source, CodeQL, secret, container, architecture,
   runtime, and vulnerability gate to pass without an expired exception.
3. Exercise the candidate once with empty persistent storage and once with a
   representative, sanitized copy of an existing `/data` volume.
4. For persistence or security changes, verify notebook metadata, Git
   credentials, PWA updates, schema migration, sessions, password/MFA behavior,
   expiry, recovery, and rollback as applicable. Authentication checks become
   mandatory when Milestone 19 lands.
5. Back up the representative `/data`, record the previous immutable image and
   its digest, and prove that rollback restores an operable installation.
6. Create a new `v<version>-alpha.<number>` tag. Never reuse or move a release
   tag or immutable container version.

The release workflow publishes the immutable version and source-SHA aliases,
verifies both architectures, creates an SBOM and signed provenance attestation,
and only then moves the Alpha convenience tag. It also creates a GitHub
prerelease containing the resulting digest and recovery guidance.

## Automated release checks

- Go unit and integration tests, including traversal, symlink, asset lifecycle, Git failure, credential, host-trust, CSRF, request parsing, and API-header coverage
- `go vet`
- Frontend lint, 42 component/integration tests, TypeScript compilation, and production PWA build
- npm production and complete dependency audits
- Complete-history Gitleaks secret scan
- Docker Compose validation and clean production image build
- Trivy image vulnerability and secret scan
- Hardened non-root/read-only container health and replacement-persistence test
- Separate `linux/amd64` and `linux/arm64` validation before publishing
- Multi-architecture GHCR manifest with SBOM and signed provenance attestation

## Candidate and operator smoke test

Before upgrading a real installation:

1. Back up `/data` and verify that the backup contains `app`, `keys`, `notebooks`, and any directly configured `repos` tree.
2. Start the alpha behind the intended authenticated HTTPS proxy.
3. Open an existing note, edit it, wait for `Saved`, run `Sync`, and verify the commit at the remote.
4. Paste and select an image, then verify the Markdown and `.assets` file in an independent clone.
5. Stop and replace the container without deleting its volume. Confirm that notebooks, notes, managed keys, and trusted-host entries remain.
6. Clone a notebook independently and open its Markdown and images without RepoQuill.
7. Test the mobile drawer, toolbar, image picker, install flow, and explicit offline warning.
8. Simulate a failed remote or rejected push and confirm that the locally saved Markdown remains present.
9. Restart with a fresh empty volume and complete notebook onboarding.
10. Restore the representative pre-upgrade volume, deploy the candidate, and
    verify notebook registration, trusted hosts, managed keys, tree loading,
    edits, assets, search, and synchronization.

After a release succeeds, update the repository variable
`REPOQUILL_LATEST_ALPHA_VERSION` to the new immutable version (without a leading
`v`). Scheduled security surveillance uses it to rescan that immutable image in
addition to the moving Alpha channel.

For production-like Alpha deployments, pin
`ghcr.io/fred-head/repoquill:<immutable-version>` or its digest. Automatically
following the moving Alpha channel delegates upgrade timing to an image updater
and can introduce untested migrations; that is an explicit operator choice.

## Recovery

If an upgrade fails, stop RepoQuill and preserve the failed-state volume for
diagnosis. Restore the pre-upgrade `/data` backup if application metadata is not
backward-compatible, then deploy the previously recorded immutable image tag or
digest. Do not point an older application at metadata that it cannot understand.

If RepoQuill cannot start, mount or copy the persistent `/data` volume and use
the repositories directly. Registered cloned notebooks are stored below
`/data/notebooks/<id>`; a directly configured notebook normally lives below
`/data/repos`. Each directory is an ordinary Git working tree.

For a Git conflict, stop automatic synchronization, inspect `git status` inside the affected working tree, resolve the files with a normal Git client, complete or abort the rebase deliberately, and restart synchronization only after the repository is clean. Never delete `/data` merely to clear an application error.

If notebook metadata is lost, note contents remain in their working trees. Re-register or clone the repositories after first preserving those directories. Loss of `/data/keys` does not destroy notes, but managed deploy keys must be replaced at the Git provider before synchronization can resume.
