# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A VS Code extension (`claude-code-config-dir-patcher`, display name **"Claude Code Profiles"**,
publisher `leog`) that **patches Anthropic's `anthropic.claude-code` extension** so
`CLAUDE_CONFIG_DIR` isolates auth/session storage per VS Code profile. It is not a standalone
feature — it edits another extension's shipped `extension.js` on disk.

The user runs multiple Claude accounts by setting, per VS Code profile:
```json
"claudeCode.environmentVariables": [{ "name": "CLAUDE_CONFIG_DIR", "value": "/Users/you/.claude-work" }]
```
Anthropic's extension only applies that var to spawned CLI processes, while its own storage
helpers read `process.env.CLAUDE_CONFIG_DIR` live. The patch bridges that gap.

## The two patch points

The patch does two string replacements against Anthropic's **minified** `extension.js`:

1. **ENV (load-bearing)** — injects `if(env.CLAUDE_CONFIG_DIR)process.env.CLAUDE_CONFIG_DIR=env.CLAUDE_CONFIG_DIR;`
   into the launch-env builder so the configured dir is visible to the extension host process
   (fixes empty chat history before any CLI spawn). Also mirrored into `process.env` at
   activation / on config change by the runtime (see `syncConfigDirEnv`).
2. **IDE (optional)** — rewrites the hardcoded `~/.claude/ide` lock path to honor
   `CLAUDE_CONFIG_DIR`. **Newer upstream builds route this through their own
   CLAUDE_CONFIG_DIR-aware helper, so this needle is legitimately absent** — that's fine, not a
   regression. Only patched when the unpatched form is actually present.

"Does the patch still work?" = does the ENV needle still match. IDE absent is OK; IDE
present-but-unpatched-after-applying is a failure.

## Key files

- `patch-regexes.js` — **single source of truth** for the 4 regex needles (ENV needle/patched,
  IDE needle/patched). Change patch logic here.
- `patch-core.js` — pure, dependency-free `analyze` / `patchEnv` / `patchIdePath` / `applyPatch`.
  No `fs`/`vscode` imports so CI can run it against real upstream builds. Edit patch behavior here.
- `extension.js` — the runtime. Wraps `applyPatch` with fs/backup/retry I/O, the 3 commands
  (Apply / Verify / Restore Backup), startup auto-patch (`onStartupFinished`), and Sentry
  analytics. This is the entry point that gets bundled.
- `scripts/build.mjs` — esbuild bundles `extension.js` → `dist/extension.js` (minified). The
  packaged `main` is `dist/extension.js`; the source `extension.js` is `.vscodeignore`d.
- `scripts/check-upstream-patchability.mjs` — downloads the latest N `anthropic.claude-code`
  builds from the Marketplace (all target platforms) and asserts each still analyzes → applies →
  is idempotent. Exit **0** = compatible, **1** = real regression (update regexes), **2** = infra
  error (network/marketplace — no verdict).

## Commands

```bash
npm run build          # esbuild -> dist/extension.js
npm run check-upstream # verify patch vs latest 3 upstream builds (alias: verify-patch)
npm run package        # build + vsce package -> .vsix
```

There is **no test suite**. Correctness is validated by `check-upstream-patchability.mjs`
against real Marketplace builds. To check the locally installed build directly:
```bash
node -e 'const{analyze,applyPatch}=require("./patch-core.js");const fs=require("fs");
const s=fs.readFileSync(process.argv[1],"utf8");console.log(analyze(s));console.log(applyPatch(s).changes)' \
  ~/.vscode/extensions/anthropic.claude-code-*/extension.js
```

## CI

- `.github/workflows/patch-verify.yml` — gates PRs/pushes to main; runs the check vs latest 3.
  Exit 2 soft-passes (infra), exit 1 fails.
- `.github/workflows/upstream-check.yml` — daily cron; opens a tracking issue (label
  `upstream-break`) only on a genuine regression (exit 1). Uses a cache key over (upstream
  build set + patch-logic hash) to skip redundant downloads.

When upstream breaks the patch, the fix is almost always: update the needle(s) in
`patch-regexes.js` to match the new minified output, keep `patch-core.js` producing the
recognized patched form, re-run `npm run check-upstream`.

## Conventions

- Version bumps land in both `package.json` and `CHANGELOG.md`; commits reference the Sentry/issue
  id they fix (e.g. `CLAUDE-EXTENSION-6`, `NODE-5`).
- Analytics are Sentry, opt-out, and heavily redacted (home paths scrubbed, no file contents / PII).
  Only send when both VS Code telemetry and `claudeConfigDirPatcher.analytics.enabled` are on.
- The patcher must degrade quietly during Claude Code installs/updates: an empty or mid-rewrite
  (partial) `extension.js` is skipped, not reported as a missing patch point.
