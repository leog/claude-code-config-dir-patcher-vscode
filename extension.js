const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const TARGET_EXTENSION_ID = "anthropic.claude-code";
const BACKUP_SUFFIX = ".claude-config-dir-patcher.bak";

const ENV_PATCH =
  'if(B.CLAUDE_CONFIG_DIR)process.env.CLAUDE_CONFIG_DIR=B.CLAUDE_CONFIG_DIR;';

const ENV_NEEDLE =
  'for(let x of K)if(x.name)B[x.name]=x.value||"";return B.CLAUDE_CODE_ENTRYPOINT=';

const IDE_NEEDLE_REGEX =
  /let V=([A-Za-z_$][\w$]*)\.join\(l94\.homedir\(\),"\.claude","ide"\);return/;

const IDE_PATCHED_REGEX =
  /let V=([A-Za-z_$][\w$]*)\.join\(process\.env\.CLAUDE_CONFIG_DIR\|\|\1\.join\(l94\.homedir\(\),"\.claude"\),"ide"\);return/;

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
    envPatched: source.includes(ENV_PATCH),
    envPatchable: source.includes(ENV_NEEDLE),
    idePatched: IDE_PATCHED_REGEX.test(source),
    idePatchable: IDE_NEEDLE_REGEX.test(source),
  };
}

function patchIdePath(source) {
  return source.replace(IDE_NEEDLE_REGEX, (_match, pathModuleName) => {
    return `let V=${pathModuleName}.join(process.env.CLAUDE_CONFIG_DIR||${pathModuleName}.join(l94.homedir(),".claude"),"ide");return`;
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
    next = next.replace(ENV_NEEDLE, `${ENV_PATCH}${ENV_NEEDLE}`);
    changes.push("extension process CLAUDE_CONFIG_DIR propagation");
  }

  if (!status.idePatched) {
    if (!status.idePatchable) {
      throw new Error("Could not find the hardcoded ~/.claude/ide patch point.");
    }
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
  return { filePath, status, ok: status.envPatched && status.idePatched };
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
    `IDE path: ${result.status.idePatched ? "patched" : result.status.idePatchable ? "patchable" : "not found"}`,
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
