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

## Which file types it claims, and why that is a rule rather than a taste

ast-grep is polyglot — it supports **28 languages**. This plugin claims **15 extensions**, and stops
there on purpose.

Claude Code requires a **static** `extensionToLanguage` map: no wildcards, no globs, no computed
config, no per-project override, and no way to influence precedence. And when two enabled LSP servers
claim the same extension, **the first registered wins and the others never start**
([plugins reference](https://code.claude.com/docs/en/plugins-reference)). So **every extension this
plugin claims is one it may be taking away from a real language server.** Coverage is not the thing to
maximise here — **blast radius is the thing to minimise.**

> **The rule: claim what you lint, or realistically will. Nothing else.**

| Tier | Extensions | Why |
|---|---|---|
| **In use** | `.js .mjs .cjs .jsx` · `.sh .bash .zsh` | The `language:` values the served projects' rules actually declare today |
| **Dogfood** | `.json .yaml .yml .md` · `.css .scss .html .htm` | Web + config formats rules get written for next. An eyes-open bet, not a free lunch — see below |
| **Never** | `.ts .tsx .py .rs .go .java .rb .php .c .cpp .h .cs .lua .kt .swift` | All owned by official language servers |

Extensions that ast-grep maps to the **same** language come as a set — `.yml` with `.yaml`, `.scss`
with `.css`, `.htm` with `.html`. A partial claim would just be a confusing one.

**The dogfood tier is a real trade, so here it is plainly.** No *official* Claude Code server claims
those eight. But popular third-party servers exist for all of them — `yaml-language-server`, `marksman`,
`vscode-json` / `css` / `html`. If one ever ships as a Claude Code plugin and you install it, one of the
two will lose the extension. **The official list tells you what is contested today; it cannot tell you
what is contested tomorrow.** This plugin accepts that risk for its own dogfooding; if you would rather
not, delete those entries from `plugin.json` and `ALLOWED` — it is a two-line change.

**Deliberately contested:** `.js .mjs .cjs .jsx` — `typescript-lsp` claims these too. We claim them
anyway, because JavaScript structural rules are this plugin's reason to exist. **If you run
`typescript-lsp` as well, the two may be mutually exclusive on `.js`.** `/plugin` names the winner.

**Never claimed** is the hard rule, not a preference: claiming those would silently disable
`pyright-lsp` / `rust-analyzer-lsp` / `gopls-lsp` / `jdtls-lsp`. **A plugin that quietly breaks another
plugin is the worst kind of plugin.**

`check-extensions.mjs` enforces both rules on every `npm run check` and fails the build on a violation.
Its `--refresh` flag re-derives the official claim list from the marketplace on your machine, so the
hard rule cannot quietly rot as Anthropic ships new language servers.

### Adding a language

Add a **rule** for it first, then widen `ALLOWED` in `check-extensions.mjs` and the map in
`plugin.json`. Never the other way round — and check first whether a real language server wants that
extension, because you will be taking it from them.

### Why it can't be dynamic

The right set is genuinely **per-project** — it is exactly the set of `language:` values in your own
`.ast-grep/rules/*.yml`, and it is trivially derivable from them. But Claude Code has no mechanism to
compute or override an LSP config at load time, so a static map is the only option. Worse, a static map
can never be *complete*: `customLanguages` in `sgconfig.yml` lets a project register its own tree-sitter
grammar under **arbitrary** extensions, which no plugin-side map can anticipate.

If you need a language this plugin does not claim, fork it and add the extension — that is a one-line
change, and you are then making the collision trade-off knowingly, for your own setup.

(Two upstream details worth knowing: ast-grep's language server **ignores the `languageId`** the client
sends and re-detects the language from the file path, so only the *keys* of the map matter — the values
are cosmetic. And ast-grep's own VSCode extension sidesteps all of this by claiming **every** file
(`language: '*'`) and gating on `sgconfig.yml` instead; Claude Code offers no equivalent.)

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
