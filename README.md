# Claude Code Config Dir Patcher

This VS Code extension patches Anthropic's `anthropic.claude-code` extension so this setting affects both spawned Claude processes and the extension auth/session layer:

```json
"claudeCode.environmentVariables": [
  { "name": "CLAUDE_CONFIG_DIR", "value": "/Users/you/.claude-work" }
]
```

## Why

Claude Code CLI supports `CLAUDE_CONFIG_DIR`, but Anthropic's VS Code extension currently has storage helpers that read `process.env.CLAUDE_CONFIG_DIR` directly while `claudeCode.environmentVariables` is only applied to launch environments. That means VS Code profile settings alone do not fully isolate accounts.

This patch makes the configured `CLAUDE_CONFIG_DIR` visible to the extension process and changes the hardcoded `~/.claude/ide` path to use the selected config dir.

## Commands

- `Claude Config Dir Patcher: Apply Patch`
- `Claude Config Dir Patcher: Verify Patch`
- `Claude Config Dir Patcher: Restore Backup`

By default the patch is applied automatically on startup. A backup is written next to Anthropic's `extension.js` with this suffix:

```text
.claude-config-dir-patcher.bak
```

## Per-profile setup

Set this in each VS Code profile's settings.

Work:

```json
"claudeCode.environmentVariables": [
  { "name": "CLAUDE_CONFIG_DIR", "value": "/Users/you/.claude-work" }
]
```

Personal:

```json
"claudeCode.environmentVariables": [
  { "name": "CLAUDE_CONFIG_DIR", "value": "/Users/you/.claude-personal" }
]
```

After applying the patch, reload VS Code before using Claude Code.

## Local packaging

This repo intentionally has no build dependencies. Package a VSIX with:

```sh
npm run package
```

Install the generated VSIX into a specific VS Code profile with:

```sh
code --profile "PROFILE NAME" --install-extension ./claude-code-config-dir-patcher-0.1.0.vsix --force
```

## Caveats

Anthropic extension updates replace `extension.js`, so this helper extension may need to re-apply the patch after updates. If Anthropic changes the minified code shape, the patch will fail rather than editing an unknown location.

This extension modifies another extension on disk. That is practical for local use, but it may not be accepted by every extension marketplace.
