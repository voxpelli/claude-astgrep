## Feature Requests

- **`ast-grep lsp` cannot watch its own rule files — hot-reload dies on any client without file watching** (2026-07-11) — The language server does not watch anything itself. On `initialized` it sends a `client/registerCapability` request asking the **client** to watch `**/*.{yml,yaml}` and report back via `workspace/didChangeWatchedFiles`. That is legitimate LSP, and it works in VSCode. But it makes hot-reload entirely **client-dependent**: a client that does not implement file watching (Claude Code does not) silently never reloads rules, and the server serves its startup rule set forever.
  The failure is invisible from both ends. The server behaves perfectly — document sync, re-analysis, diagnostics all correct — and simply never learns the rules changed. The user edits a rule, sees no change, and concludes their *rule* is wrong. Confirmed the reload path itself is fine: injecting `workspace/didChangeWatchedFiles` manually over stdio makes the server log "Configuration files changed, reloading rules… Rules reloaded successfully".
  A server-side `--watch` (fs-watch `ruleDirs` + `sgconfig.yml` in-process), or a fallback to self-watching when the client does not confirm the registration, would make hot-reload work everywhere instead of only in editors that opt in. Precedent exists: `rust-analyzer` exposes `files.watcher: "client" | "server"` for exactly this reason.
  Ownership: upstream · Workaround: partial — restart the editor after a rule change; or wrap the server in a stdio proxy that watches the files and injects the notification (under evaluation here).

- **`ast-grep lsp` hard-exits when no `sgconfig.yml` is present** (2026-07-11) \[minor] — The server exits during `initialize` with `Error: No ast-grep project configuration is found.` (exit code 3). Reasonable in isolation, but it means an editor integration that registers the server **globally** gets a dead server in every project that does not use ast-grep — which is most of them. The VSCode extension avoids this by gating activation on `findConfigFile()`; a client whose plugin model has no activation condition (Claude Code) cannot.
  Worse, in a client where the first server claiming a file extension wins and the others never start, a dead-on-arrival ast-grep server could, depending on unspecified client behaviour, *starve* that extension for the real language server. That risk forces a defensively narrow extension claim.
  A `--no-config-ok` / no-op mode (start, report zero rules, publish nothing) would let integrations register the server broadly and safely.
  Severity: minor · Ownership: upstream · Workaround: full — pass `-c <path>` explicitly and document that the plugin is a no-op without a config.

## Bugs

*No entries yet.*

## Upstream Opportunities

- **An ast-grep language-server plugin for Claude Code** (2026-07-11) — Claude Code supports registering language servers from a plugin (`lspServers` in `plugin.json`), and `ast-grep lsp` works with it: rules produce live diagnostics in-context after each edit. No such plugin existed. Built one — including the collision rule that makes it safe to install (never claim a file extension owned by an official language server, because the first server registered for an extension wins and the others never start), plus a zero-dependency stdio LSP verifier that asserts a diagnostic **fires** on a violating buffer and **clears** on the fixed one.
  Would suit either ast-grep's own docs (`guide/tools/editors.html` lists nvim/coc/helix/emacs but not Claude Code) or its existing Claude Code plugin (see `UPSTREAM-plugin--ast-grep.md`).
  Source: `voxpelli/claude-astgrep` (this repo) · Merge readiness: direct
  Ownership: us · Workaround: full — published as a standalone plugin.
