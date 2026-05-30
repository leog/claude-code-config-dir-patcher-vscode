// Pure, dependency-free patch logic shared by the runtime extension and CI.
//
// This module performs the string->string transformation of anthropic.claude-code's
// minified extension.js. It intentionally imports nothing from vscode or fs so it
// can be exercised directly by scripts/check-upstream-patchability.mjs against real
// upstream builds. extension.js wraps applyPatch() with the fs/backup/retry I/O.

const {
  ENV_NEEDLE_REGEX,
  ENV_PATCHED_REGEX,
  IDE_NEEDLE_REGEX,
  IDE_PATCHED_REGEX,
} = require("./patch-regexes");

function analyze(source) {
  return {
    envPatched: ENV_PATCHED_REGEX.test(source),
    envPatchable: ENV_NEEDLE_REGEX.test(source),
    idePatched: IDE_PATCHED_REGEX.test(source),
    idePatchable: IDE_NEEDLE_REGEX.test(source),
  };
}

function patchEnv(source) {
  return source.replace(ENV_NEEDLE_REGEX, (match, _itemName, _collection, envObjName) => {
    return `if(${envObjName}.CLAUDE_CONFIG_DIR)process.env.CLAUDE_CONFIG_DIR=${envObjName}.CLAUDE_CONFIG_DIR;${match}`;
  });
}

function patchIdePath(source) {
  return source.replace(IDE_NEEDLE_REGEX, (_match, varName, pathModuleName, osModuleName) => {
    return `let ${varName}=${pathModuleName}.join(process.env.CLAUDE_CONFIG_DIR||${pathModuleName}.join(${osModuleName}.homedir(),".claude"),"ide");return`;
  });
}

// Pure transform: given the target source, return the patched source plus the
// list of changes applied. Mirrors the decision logic the runtime uses, minus
// the "patch point missing" error (callers decide how to surface that).
function applyPatch(source) {
  const status = analyze(source);
  let next = source;
  const changes = [];

  if (!status.envPatched && status.envPatchable) {
    next = patchEnv(next);
    changes.push("env");
  }

  // Newer Claude Code builds route the IDE lock path through a CLAUDE_CONFIG_DIR-aware
  // helper, so the hardcoded needle is absent. Only patch when the unpatched form is
  // actually present; otherwise treat IDE-side handling as upstream-provided.
  if (!status.idePatched && status.idePatchable) {
    next = patchIdePath(next);
    changes.push("ide");
  }

  return { next, changes };
}

module.exports = {
  analyze,
  patchEnv,
  patchIdePath,
  applyPatch,
};
