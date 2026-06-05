# Changelog

All notable changes to this extension are documented here.

## 0.1.9

- Fix empty Claude Code chat history after switching VS Code profiles
  ([#3](https://github.com/leog/claude-code-config-dir-patcher-vscode/issues/3)).
  Claude Code's storage helpers read `process.env.CLAUDE_CONFIG_DIR` live, but
  the launch-env patch only set that variable when the CLI was spawned — so
  views that load before any spawn (most visibly the chat history) resolved to
  the default `~/.claude` and appeared empty even though the per-profile dir
  held the data. The patcher now mirrors the configured `CLAUDE_CONFIG_DIR`
  into the shared extension host's `process.env` at activation and on
  configuration changes, so history and other storage reads resolve to the
  selected profile dir immediately.

## 0.1.8

- Rename the extension to "Claude Code Profiles" and refresh the Marketplace
  metadata (display name, description, keywords, and categories) for
  discoverability. The internal extension ID, command IDs, and configuration
  keys are unchanged, so existing settings keep working.

## 0.1.7

- Bundle the extension with esbuild. The VSIX drops from 447 KB / 222 files to
  ~177 KB / 9 files, and the extension host loads a single file instead of
  walking `@sentry/core`'s 200+ CJS modules at activation time.
- Add an automated upstream patchability check (`scripts/check-upstream-patchability.mjs`,
  scheduled via `.github/workflows/upstream-check.yml`) that downloads the
  latest `anthropic.claude-code` VSIX daily and opens a tracking issue if the
  patch regex no longer matches — so upstream minifier changes get caught
  before they break users.
- Extract the patch needle/already-patched regexes into a shared
  `patch-regexes.js` module so the runtime patcher and the upstream check
  can't drift out of sync.
- Drop redundant `onCommand:*` activation events that VS Code now derives
  automatically from `contributes.commands`.

## 0.1.6

- Declare `anthropic.claude-code` as an `extensionDependency`. VS Code now
  activates the target before this patcher, eliminating the EBUSY race on
  Windows where both extensions activated on `onStartupFinished` at the same
  time and the file handle was still held open while we tried to write.
- Silently no-op when the target extension isn't installed (previously a
  startup warning toast + a Sentry error event).
- Add an EBUSY/EPERM retry-with-backoff around the patch write to handle
  transient AV-scanner locks on Windows.

## 0.1.5

- Add opt-in Sentry telemetry for activation/command errors and a first-run
  install event. All payloads are scrubbed (home directory and Windows
  `C:\Users\<user>` paths replaced) before being sent, and the integration is
  gated on both `vscode.env.isTelemetryEnabled` and the new
  `claudeConfigDirPatcher.analytics.enabled` setting.

## 0.1.4

- Update the env-var patch regex to match a newer minified form emitted by
  recent Claude Code builds.

## 0.1.3

- Update the IDE-path patch regex to match a newer minified form emitted by
  recent Claude Code builds. The IDE-path patch is now treated as optional
  when upstream already routes the IDE lock through a `CLAUDE_CONFIG_DIR`-
  aware helper.

## 0.1.2

- Fix the extension icon.

## 0.1.1

- Add the extension logo.

## 0.1.0

- Initial release. Patches Anthropic Claude Code's bundled `extension.js` so
  that `claudeCode.environmentVariables.CLAUDE_CONFIG_DIR` is propagated to
  the spawned `claude` process and used for the IDE lock-file path, allowing
  per-workspace Claude config directories to work end-to-end.
