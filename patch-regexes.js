// Single source of truth for the regex needles the patcher applies and
// recognizes in anthropic.claude-code's minified extension.js. Used at runtime
// by extension.js and at CI time by scripts/check-upstream-patchability.mjs.
//
// Capture groups for ENV_NEEDLE_REGEX: 1=loop var, 2=collection var, 3=env-object var.

const ENV_NEEDLE_REGEX =
  /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)if\(\1\.name\)([A-Za-z_$][\w$]*)\[\1\.name\]=\1\.value\|\|"";return \3\.CLAUDE_CODE_ENTRYPOINT=/;

const ENV_PATCHED_REGEX =
  /if\(([A-Za-z_$][\w$]*)\.CLAUDE_CONFIG_DIR\)process\.env\.CLAUDE_CONFIG_DIR=\1\.CLAUDE_CONFIG_DIR;for\(let ([A-Za-z_$][\w$]*) of [A-Za-z_$][\w$]*\)if\(\2\.name\)\1\[\2\.name\]=\2\.value\|\|"";return \1\.CLAUDE_CODE_ENTRYPOINT=/;

const IDE_NEEDLE_REGEX =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.join\(([A-Za-z_$][\w$]*)\.homedir\(\),"\.claude","ide"\);return/;

const IDE_PATCHED_REGEX =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.join\(process\.env\.CLAUDE_CONFIG_DIR\|\|\2\.join\(([A-Za-z_$][\w$]*)\.homedir\(\),"\.claude"\),"ide"\);return/;

module.exports = {
  ENV_NEEDLE_REGEX,
  ENV_PATCHED_REGEX,
  IDE_NEEDLE_REGEX,
  IDE_PATCHED_REGEX,
};
