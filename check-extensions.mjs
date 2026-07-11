#!/usr/bin/env node
// Guard the extension map against the one mistake this plugin must never make: claiming a file
// extension that a real language server owns.
//
// Claude Code requires a STATIC extensionToLanguage map — no wildcards, no computed config, no
// per-project override, and no way to influence precedence. When two enabled LSP servers claim the
// same extension, THE FIRST REGISTERED WINS AND THE OTHERS NEVER START. So every extension this
// plugin claims is one it may be taking away from pyright / rust-analyzer / gopls / typescript-lsp.
// A plugin that silently disables another plugin is the worst kind of plugin.
//
// The rule this enforces: claim only what NO official Claude Code language server wants — plus the
// JavaScript family, which is a deliberate, documented contest (JS structural rules are the whole
// point of this plugin).
//
// The exclusion list below is derived from Claude Code's official marketplace. Run with --refresh
// to re-derive it from the marketplace on this machine, so the list cannot quietly go stale as
// Anthropic ships new language servers.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(path.join(HERE, '.claude-plugin', 'plugin.json'), 'utf8'));
const claimed = Object.keys(manifest.lspServers['ast-grep'].extensionToLanguage);

// Extensions owned by official Claude Code LSP plugins, as of the marketplace snapshot noted below.
// Regenerate with `node check-extensions.mjs --refresh` when Anthropic ships new servers.
const OFFICIAL = {
  '.c': 'clangd-lsp', '.cc': 'clangd-lsp', '.cpp': 'clangd-lsp', '.cxx': 'clangd-lsp',
  '.h': 'clangd-lsp', '.hpp': 'clangd-lsp', '.hxx': 'clangd-lsp',
  '.cs': 'csharp-lsp',
  '.go': 'gopls-lsp',
  '.java': 'jdtls-lsp',
  '.kt': 'kotlin-lsp', '.kts': 'kotlin-lsp',
  '.lua': 'lua-lsp',
  '.php': 'php-lsp',
  '.py': 'pyright-lsp', '.pyi': 'pyright-lsp',
  '.erb': 'ruby-lsp', '.gemspec': 'ruby-lsp', '.rake': 'ruby-lsp', '.rb': 'ruby-lsp', '.ru': 'ruby-lsp',
  '.rs': 'rust-analyzer-lsp',
  '.swift': 'swift-lsp',
  '.cjs': 'typescript-lsp', '.cts': 'typescript-lsp', '.js': 'typescript-lsp', '.jsx': 'typescript-lsp',
  '.mjs': 'typescript-lsp', '.mts': 'typescript-lsp', '.ts': 'typescript-lsp', '.tsx': 'typescript-lsp',
};

// The JavaScript family is contested ON PURPOSE: typescript-lsp claims it, and we claim it anyway
// because JS structural rules are this plugin's reason to exist. The trade is documented in the
// README. Every OTHER contested extension is a bug.
const DELIBERATE_CONTEST = new Set(['.js', '.mjs', '.cjs', '.jsx']);

// THE ALLOWLIST IS THE REAL RULE, and it is stricter than "not claimed by an official server".
//
// "Uncontested by Claude Code's official marketplace" is a weaker guarantee than it sounds: popular
// language servers exist for .tf, .nix, .json, .yaml, .md, .css and .html, and any could ship as a
// third-party Claude Code plugin tomorrow — at which point a greedy map here would silently kill it.
// The official list tells you what is contested TODAY; it cannot tell you what is contested tomorrow.
//
// So the rule is not "claim everything nobody has claimed yet". It is: CLAIM WHAT YOU LINT, OR
// REALISTICALLY WILL. An extension you will never write a rule for buys nothing and costs a language
// server someone may want. Blast radius is the thing to minimise, not coverage.
//
// The two tiers below are a deliberate, eyes-open split:
//
//   IN USE      — languages the served projects' rules actually declare today (javascript, bash).
//   DOGFOOD     — languages the owner realistically writes rules for next (web + config formats).
//                 These are NOT claimed by any official Claude Code server, but they DO have popular
//                 third-party servers (yaml-language-server, marksman, vscode-json/css/html). If one
//                 of those ever ships as a Claude Code plugin and you install it, one of the two will
//                 lose the extension. This is an accepted, documented trade for a personal plugin —
//                 not a claim that it is risk-free.
//
// Everything ast-grep maps to the SAME language comes along together (.yml with .yaml, .scss with
// .css, .htm with .html) — a partial claim would just be a confusing one.
//
// To add a language: add a rule for it FIRST, then widen this list. Never the other way round.
const ALLOWED = new Set([
  // IN USE
  '.js', '.mjs', '.cjs', '.jsx',                 // javascript
  '.sh', '.bash', '.zsh',                        // bash
  // DOGFOOD
  '.json', '.yaml', '.yml', '.md',               // config + docs
  '.css', '.scss', '.html', '.htm',              // web
]);

if (process.argv.includes('--refresh')) {
  const mp = path.join(process.env.HOME, '.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json');
  if (!existsSync(mp)) {
    console.error(`--refresh needs the official marketplace on disk; not found at ${mp}`);
    process.exit(1);
  }
  const fresh = {};
  for (const p of JSON.parse(readFileSync(mp, 'utf8')).plugins ?? []) {
    for (const cfg of Object.values(p.lspServers ?? {})) {
      for (const ext of Object.keys(cfg.extensionToLanguage ?? {})) fresh[ext.toLowerCase()] = p.name;
    }
  }
  const added = Object.keys(fresh).filter((e) => !(e in OFFICIAL));
  const gone = Object.keys(OFFICIAL).filter((e) => !(e in fresh));
  console.log(`official marketplace now claims ${Object.keys(fresh).length} extensions`);
  if (added.length) console.log(`  NEW since our snapshot: ${added.join(' ')}  <- update OFFICIAL below`);
  if (gone.length) console.log(`  no longer claimed:      ${gone.join(' ')}`);
  if (!added.length && !gone.length) console.log('  snapshot is current — no change needed');
  process.exit(0);
}

let failed = false;

// (1) The hard rule: never take an extension away from an official language server.
for (const e of claimed.filter((x) => x in OFFICIAL && !DELIBERATE_CONTEST.has(x))) {
  console.log(`  FAIL  ${e} is owned by ${OFFICIAL[e]} — claiming it would stop that server from ever starting`);
  failed = true;
}

// (2) The stricter rule: claim only what we actually lint. An extension with no rules behind it is
// pure blast radius — it can only ever cost someone a language server they wanted.
for (const e of claimed.filter((x) => !ALLOWED.has(x))) {
  console.log(`  FAIL  ${e} is not in the allowlist — add a rule for that language FIRST, then widen ALLOWED`);
  failed = true;
}

const contested = claimed.filter((e) => DELIBERATE_CONTEST.has(e));
console.log(`  claimed    : ${claimed.length} extensions (${claimed.join(' ')})`);
console.log(`  contested  : ${contested.length}  (${contested.join(' ')} — deliberate; contests typescript-lsp, see README)`);
console.log(`  ${failed ? 'FAIL' : 'PASS'}       : ${failed ? 'the map claims something it should not' : 'claims only what it lints, and takes nothing from an official server'}`);

process.exit(failed ? 1 : 0);
