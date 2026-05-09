const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const TARGET_EXTENSION_ID = "anthropic.claude-code";
const BACKUP_SUFFIX = ".claude-config-dir-patcher.bak";

// Captures: 1=loop var, 2=collection var, 3=env-object var.
const ENV_NEEDLE_REGEX =
  /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)if\(\1\.name\)([A-Za-z_$][\w$]*)\[\1\.name\]=\1\.value\|\|"";return \3\.CLAUDE_CODE_ENTRYPOINT=/;

const ENV_PATCHED_REGEX =
  /if\(([A-Za-z_$][\w$]*)\.CLAUDE_CONFIG_DIR\)process\.env\.CLAUDE_CONFIG_DIR=\1\.CLAUDE_CONFIG_DIR;for\(let ([A-Za-z_$][\w$]*) of [A-Za-z_$][\w$]*\)if\(\2\.name\)\1\[\2\.name\]=\2\.value\|\|"";return \1\.CLAUDE_CODE_ENTRYPOINT=/;

const IDE_NEEDLE_REGEX =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.join\(([A-Za-z_$][\w$]*)\.homedir\(\),"\.claude","ide"\);return/;

const IDE_PATCHED_REGEX =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.join\(process\.env\.CLAUDE_CONFIG_DIR\|\|\2\.join\(([A-Za-z_$][\w$]*)\.homedir\(\),"\.claude"\),"ide"\);return/;

function getConfig() {
  return vscode.workspace.getConfiguration("claudeConfigDirPatcher");
}

function getTargetExtensionPath() {
  const extension = vscode.extensions.getExtension(TARGET_EXTENSION_ID);
  if (!extension) {
    throw new Error(`VS Code extension ${TARGET_EXTENSION_ID} is not installed.`);
  }
  return extension.extensionPath;
}

function getExtensionJsPath() {
  return path.join(getTargetExtensionPath(), "extension.js");
}

function readTarget() {
  const filePath = getExtensionJsPath();
  return { filePath, source: fs.readFileSync(filePath, "utf8") };
}

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

function applyPatch() {
  const { filePath, source } = readTarget();
  const status = analyze(source);
  let next = source;
  const changes = [];

  if (!status.envPatched) {
    if (!status.envPatchable) {
      throw new Error("Could not find the claudeCode.environmentVariables launch-env patch point.");
    }
    next = patchEnv(next);
    changes.push("extension process CLAUDE_CONFIG_DIR propagation");
  }

  // Newer Claude Code builds route the IDE lock path through a CLAUDE_CONFIG_DIR-aware
  // helper, so the hardcoded needle is absent. Only patch when the unpatched form is
  // actually present; otherwise treat IDE-side handling as upstream-provided.
  if (!status.idePatched && status.idePatchable) {
    next = patchIdePath(next);
    changes.push("CLAUDE_CONFIG_DIR-aware IDE lock path");
  }

  if (changes.length === 0) {
    return { filePath, changed: false, changes };
  }

  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  fs.writeFileSync(filePath, next, "utf8");
  return { filePath, changed: true, changes };
}

function verifyPatch() {
  const { filePath, source } = readTarget();
  const status = analyze(source);
  const ideOk = status.idePatched || !status.idePatchable;
  return { filePath, status, ok: status.envPatched && ideOk };
}

function restoreBackup() {
  const filePath = getExtensionJsPath();
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backupPath)) {
    throw new Error(`No backup exists at ${backupPath}`);
  }
  fs.copyFileSync(backupPath, filePath);
  return { filePath, backupPath };
}

async function promptReload(message) {
  const choice = await vscode.window.showInformationMessage(
    message,
    "Reload Window",
    "Later"
  );
  if (choice === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function applyAndReport({ quiet = false } = {}) {
  const result = applyPatch();
  if (result.changed) {
    await promptReload(
      `Claude Code Config Dir patch applied: ${result.changes.join(", ")}. Reload VS Code before using Claude Code.`
    );
  } else if (!quiet) {
    vscode.window.showInformationMessage("Claude Code Config Dir patch is already applied.");
  }
}

async function verifyAndReport() {
  const result = verifyPatch();
  const detail = [
    `File: ${result.filePath}`,
    `environmentVariables propagation: ${result.status.envPatched ? "patched" : result.status.envPatchable ? "patchable" : "not found"}`,
    `IDE path: ${result.status.idePatched ? "patched" : result.status.idePatchable ? "patchable" : "handled upstream"}`,
  ].join("\n");

  if (result.ok) {
    vscode.window.showInformationMessage(`Claude Code Config Dir patch is applied.\n${detail}`);
  } else {
    vscode.window.showWarningMessage(`Claude Code Config Dir patch is not fully applied.\n${detail}`);
  }
}

async function restoreAndReport() {
  const result = restoreBackup();
  await promptReload(`Restored Anthropic Claude Code extension.js from backup:\n${result.backupPath}`);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeConfigDirPatcher.apply", () => applyAndReport()),
    vscode.commands.registerCommand("claudeConfigDirPatcher.verify", verifyAndReport),
    vscode.commands.registerCommand("claudeConfigDirPatcher.restore", restoreAndReport)
  );

  if (getConfig().get("autoPatch", true)) {
    applyAndReport({ quiet: !getConfig().get("showStartupNotifications", false) }).catch((error) => {
      vscode.window.showWarningMessage(`Claude Code Config Dir auto-patch failed: ${error.message}`);
    });
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
