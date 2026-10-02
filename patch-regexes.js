// Single source of truth for the regex needles the patcher applies and
// recognizes in anthropic.claude-code's minified extension.js. Used at runtime
// by extension.js and at CI time by scripts/check-upstream-patchability.mjs.
//
// Capture groups for ENV_NEEDLE_REGEX: 1=loop var, 2=collection var, 3=env-object var.
//
// The launch-env loop has three known minified shapes:
//   <= 2.1.274  for(let a of b)if(a.name)c[a.name]=a.value||"";return c.CLAUDE_CODE_ENTRYPOINT=
//   >= 2.1.275  for(let a of b){if(a.name==="CLAUDE_CONFIG_DIR"&&a.value==="")continue;if(a.name)c[a.name]=a.value||""}return c.CLAUDE_CODE_ENTRYPOINT=
//   >= 2.1.284  for(let a of b){if(f(a.name))continue;if(a.name)c[a.name]=a.value||""}let d=g(b,Boolean(h("claudeProcessWrapper")));if(d!==void 0)c.CLAUDE_CONFIG_DIR=d;return c.CLAUDE_CODE_ENTRYPOINT=
// Both regexes accept any of them (optional brace, optional CLAUDE_CONFIG_DIR
// skip in either form, optional resolved-config-dir assignment after the loop).

const ENV_NEEDLE_REGEX =
  /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{?(?:if\((?:\1\.name==="CLAUDE_CONFIG_DIR"&&\1\.value===""|[A-Za-z_$][\w$]*\(\1\.name\))\)continue;)?if\(\1\.name\)([A-Za-z_$][\w$]*)\[\1\.name\]=\1\.value\|\|""[;}](?:let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\2,Boolean\([A-Za-z_$][\w$]*\("claudeProcessWrapper"\)\)\);if\(\4!==void 0\)\3\.CLAUDE_CONFIG_DIR=\4;)?return \3\.CLAUDE_CODE_ENTRYPOINT=/;

const ENV_PATCHED_REGEX =
  /if\(([A-Za-z_$][\w$]*)\.CLAUDE_CONFIG_DIR\)process\.env\.CLAUDE_CONFIG_DIR=\1\.CLAUDE_CONFIG_DIR;for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{?(?:if\((?:\2\.name==="CLAUDE_CONFIG_DIR"&&\2\.value===""|[A-Za-z_$][\w$]*\(\2\.name\))\)continue;)?if\(\2\.name\)\1\[\2\.name\]=\2\.value\|\|""[;}](?:let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\3,Boolean\([A-Za-z_$][\w$]*\("claudeProcessWrapper"\)\)\);if\(\4!==void 0\)\1\.CLAUDE_CONFIG_DIR=\4;)?return \1\.CLAUDE_CODE_ENTRYPOINT=/;

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
