# Claude Code Profiles

This VS Code extension lets you run multiple Claude Code accounts by patching Anthropic's `anthropic.claude-code` extension so this setting affects both spawned Claude processes and the extension auth/session layer:

```json
"claudeCode.environmentVariables": [
  { "name": "CLAUDE_CONFIG_DIR", "value": "/Users/you/.claude-work" }
]
```

## Why

Claude Code CLI supports `CLAUDE_CONFIG_DIR`, but Anthropic's VS Code extension currently has storage helpers that read `process.env.CLAUDE_CONFIG_DIR` directly while `claudeCode.environmentVariables` is only applied to launch environments. That means VS Code profile settings alone do not fully isolate accounts.

This patch makes the configured `CLAUDE_CONFIG_DIR` visible to the extension process and changes the hardcoded `~/.claude/ide` path to use the selected config dir.

## Commands

- `Claude Code Profiles: Apply Patch`
- `Claude Code Profiles: Verify Patch`
- `Claude Code Profiles: Restore Backup`

By default the patch is applied automatically on startup. A backup is written next to Anthropic's `extension.js` with this suffix:

```text
.claude-config-dir-patcher.bak
```

## Error analytics

This extension can send redacted error reports to Sentry when patching, verification, restore, or startup auto-patching fails. It also sends a one-time `extension.installed` event on first activation to estimate install counts and installed version distribution. Analytics are sent only when all of these are true:

- VS Code telemetry is enabled.
- `claudeConfigDirPatcher.analytics.enabled` is enabled.

The extension does not send default PII, user identifiers, request data, or file contents. Home directory paths in error messages and stack traces are replaced before sending.

Error reports include the installed Claude Code extension version, redacted target `extension.js` path, backup presence, target source size, a short target source hash, and patch-point status flags so patch failures can be diagnosed without sending the target source file.

The install event includes this extension's installed version and the installed Claude Code extension version when available.

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

Install dependencies, then package a VSIX with:

```sh
npm install
```

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
