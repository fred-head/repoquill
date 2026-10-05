# Git and remote-operation constraints

- Invoke Git with fixed subcommands and direct arguments; keep hooks disabled,
  validate refs/paths/remotes, and sanitize diagnostics. Never expose secrets.
- Never force-push. Save state is independent of sync; remote errors preserve
  the working tree, and conflicts pause until an explicit resolution.
- Preserve provider-independent Git behavior and explicit SSH host trust. Use
  temporary local repositories in tests; use the focused checks in
  `../../docs/development/testing.md` for sync, conflict, SSH, or history work.
