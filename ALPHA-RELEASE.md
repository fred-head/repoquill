# RepoQuill 0.1.0-alpha.1

## Release scope

This alpha provides portable Markdown editing, folders and file operations, note-owned images, explicit unused-asset cleanup, Git synchronization, multiple notebooks, search, responsive PWA behavior, and editor productivity controls.

The canonical data remains ordinary Git working trees. RepoQuill has no built-in authentication and must be deployed behind a trusted HTTPS authentication layer.

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

## Operator smoke test

Before upgrading a real installation:

1. Back up `/data` and verify that the backup contains `app`, `keys`, `notebooks`, and any directly configured `repos` tree.
2. Start the alpha behind the intended authenticated HTTPS proxy.
3. Open an existing note, edit it, wait for `Saved`, run `Sync`, and verify the commit at the remote.
4. Paste and select an image, then verify the Markdown and `.assets` file in an independent clone.
5. Stop and replace the container without deleting its volume. Confirm that notebooks, notes, managed keys, and trusted-host entries remain.
6. Clone a notebook independently and open its Markdown and images without RepoQuill.
7. Test the mobile drawer, toolbar, image picker, install flow, and explicit offline warning.
8. Simulate a failed remote or rejected push and confirm that the locally saved Markdown remains present.

## Recovery

If RepoQuill cannot start, mount or copy the persistent `/data` volume and use the repositories directly. Registered cloned notebooks are stored below `/data/notebooks/<id>`; a directly configured notebook normally lives below `/data/repos`. Each directory is an ordinary Git working tree.

For a Git conflict, stop automatic synchronization, inspect `git status` inside the affected working tree, resolve the files with a normal Git client, complete or abort the rebase deliberately, and restart synchronization only after the repository is clean. Never delete `/data` merely to clear an application error.

If notebook metadata is lost, note contents remain in their working trees. Re-register or clone the repositories after first preserving those directories. Loss of `/data/keys` does not destroy notes, but managed deploy keys must be replaced at the Git provider before synchronization can resume.
