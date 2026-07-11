# vp-astgrep

Live [ast-grep](https://ast-grep.github.io/) structural-lint diagnostics in Claude Code, via the
ast-grep language server.

Your `.ast-grep/rules/*.yml` already run on `ast-grep scan`. This makes them run **as the code is
written** — a violation surfaces in-context right after the edit, instead of minutes later on a
`check` run or in CI.

## Why

A convention written in a comment enforces nothing.

The rule that motivated this plugin was born when a file's own header said *"import it, don't re-roll
it"* — and six call sites re-rolled it anyway, for months, past code review. An ast-grep rule caught
all six, plus a seventh that a hand-written grep had missed (the grep keyed on an identifier; the rule
keyed on the *shape*).

That is the case for structural rules. This plugin is the case for making them **immediate**.

## Install

```
/plugin marketplace add voxpelli/vp-claude
/plugin install vp-astgrep@vp-plugins
```

Requires the `ast-grep` binary on `$PATH`:

```
brew install ast-grep      # or: npm i -g @ast-grep/cli, cargo install ast-grep
```

## Requirements — read this before filing a bug

**Your project must have an `sgconfig.yml` in its root.** The ast-grep language server hard-exits
without one:

```
Error: No ast-grep project configuration is found.
```

So in a repo with no `sgconfig.yml`, this plugin is a **no-op** — the server fails to start, Claude
Code skips it, and you get no diagnostics. That is expected, not a defect. A minimal config:

```yaml
# sgconfig.yml
ruleDirs:
  - .ast-grep/rules
```

Run `claude --debug` to see language-server startup errors.

## What it registers

```jsonc
"lspServers": {
  "ast-grep": {
    "command": "ast-grep",
    "args": ["lsp", "-c", "${CLAUDE_PROJECT_DIR}/sgconfig.yml"],
    "extensionToLanguage": {
      ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript"
    }
  }
}
```

**The explicit `-c` is load-bearing.** The server otherwise resolves `sgconfig.yml` from its working
directory and exits if it isn't there; passing the path makes it independent of whatever cwd the
client happens to use. This exact race is a known cross-editor failure mode.

Rule files are watched — edit a rule and diagnostics update without a restart.

## ⚠️ Extension collisions

When two enabled LSP servers claim the same file extension, **the first one registered wins and the
others never start** ([plugins reference](https://code.claude.com/docs/en/plugins-reference)). The
`/plugin` view warns you and names the winner.

This plugin claims only the **JavaScript** family — `.js`, `.mjs`, `.cjs`, `.jsx`. It deliberately does
**not** claim `.ts`/`.tsx`, so enabling `typescript-lsp` cannot be broken by this plugin on TypeScript.

But on `.js`, `typescript-lsp` and `vp-astgrep` **may be mutually exclusive**. If you run both and see
diagnostics from only one, that is why — check `/plugin`.

To lint other languages, add their extensions to `extensionToLanguage` (ast-grep itself infers the
language from the file; the map is only how Claude Code decides which server to route to).

## Not a replacement for `ast-grep scan`

`ast-grep` is an unpinned, external binary. A contributor without it installed gets **no diagnostics,
silently**. So keep `ast-grep scan` in your `check`/CI script as the enforcement gate — this plugin is
a **feedback** layer, never the contract layer.

## Verifying it works

```
node verify-lsp.mjs [path/to/project]
```

Drives the real language server over stdio and asserts that a buffer violating one of *your* rules
produces a diagnostic carrying that rule's id — and, crucially, that the **fixed** buffer clears it. A
check that only asserts the error case cannot tell a working linter from one that fires on everything.

## License

MIT © [Pelle Wessman](https://kodfabrik.se/)
