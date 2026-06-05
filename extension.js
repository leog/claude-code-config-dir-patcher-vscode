const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const {
  analyze,
  patchEnv,
  patchIdePath,
} = require("./patch-core");

const TARGET_EXTENSION_ID = "anthropic.claude-code";
const BACKUP_SUFFIX = ".claude-config-dir-patcher.bak";
const SENTRY_DSN =
  "https://cd6cc7db78c15551abba61c188056ad1@o4511368420196352.ingest.us.sentry.io/4511368450342912";
const SENTRY_FLUSH_TIMEOUT_MS = 2000;
const SENTRY_STRING_MAX_LENGTH = 1200;
const INSTALL_ANALYTICS_REPORTED_KEY = "analytics.installEventReported";

let sentry;
let sentryEnabled = false;
let sentryStateKey = "";

function getConfig() {
  return vscode.workspace.getConfiguration("claudeConfigDirPatcher");
}

// Claude Code's storage helpers (history, auth, sessions) read
// process.env.CLAUDE_CONFIG_DIR live. The launch-env patch only sets that var
// when the CLI is spawned, so views that load before any spawn — most visibly
// the chat history — resolve to the default ~/.claude and appear empty after a
// profile switch. We share the extension host process with anthropic.claude-code,
// so mirroring the configured value into process.env here makes those reads
// resolve to the selected profile dir immediately, before anything is launched.
function syncConfigDirEnv() {
  try {
    const entries = vscode.workspace
      .getConfiguration("claudeCode")
      .get("environmentVariables");
    if (!Array.isArray(entries)) {
      return;
    }
    const entry = entries.find(
      (item) => item && item.name === "CLAUDE_CONFIG_DIR" && item.value
    );
    if (entry) {
      process.env.CLAUDE_CONFIG_DIR = String(entry.value);
    }
  } catch (_error) {
    // Never let env mirroring break activation.
  }
}

function getExtensionEnvironment(context) {
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    return "development";
  }
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return "test";
  }
  return "production";
}

function getPackageInfo(context) {
  const packageJson = context.extension.packageJSON || {};
  return {
    name: packageJson.name || "claude-code-config-dir-patcher",
    version: packageJson.version || "0.0.0",
  };
}

function canSendAnalytics() {
  const config = getConfig();
  if (config.get("errorAnalytics.enabled", true) === false) {
    return false;
  }

  return vscode.env.isTelemetryEnabled && config.get("analytics.enabled", true);
}

function loadSentry() {
  if (sentry) {
    return sentry;
  }

  try {
    sentry = require("@sentry/core");
  } catch (_error) {
    return undefined;
  }

  return sentry;
}

function createSentryFetchTransport(options) {
  return sentry.createTransport(options, async (request) => {
    const response = await fetch(options.url, {
      method: "POST",
      body: request.body,
      headers: options.headers,
    });

    return {
      statusCode: response.status,
      headers: {
        "retry-after": response.headers.get("retry-after"),
        "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
      },
    };
  });
}

function getSentryIntegrations() {
  return [
    typeof sentry.dedupeIntegration === "function" ? sentry.dedupeIntegration() : undefined,
    typeof sentry.linkedErrorsIntegration === "function"
      ? sentry.linkedErrorsIntegration({ limit: 3 })
      : undefined,
  ].filter(Boolean);
}

function initializeAnalytics(context) {
  updateAnalytics(context);

  context.subscriptions.push(
    vscode.env.onDidChangeTelemetryEnabled(() => {
      updateAnalytics(context);
      void reportInstallAnalytics(context);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("claudeConfigDirPatcher.analytics") ||
        event.affectsConfiguration("claudeConfigDirPatcher.errorAnalytics")
      ) {
        updateAnalytics(context);
        void reportInstallAnalytics(context);
      }
    })
  );
}

function updateAnalytics(context) {
  if (!canSendAnalytics()) {
    void closeAnalytics();
    return;
  }

  const packageInfo = getPackageInfo(context);
  const environment = getExtensionEnvironment(context);
  const stateKey = `${packageInfo.name}|${packageInfo.version}|${environment}`;
  if (sentryEnabled && stateKey === sentryStateKey) {
    return;
  }

  const sdk = loadSentry();
  if (!sdk) {
    return;
  }

  if (sentryEnabled) {
    void closeAnalytics();
  }

  sentry = sdk;
  sentry.initAndBind(sentry.ServerRuntimeClient, {
    dsn: SENTRY_DSN,
    release: `${packageInfo.name}@${packageInfo.version}`,
    environment,
    transport: createSentryFetchTransport,
    stackParser: sentry.createStackParser(sentry.nodeStackLineParser()),
    integrations: getSentryIntegrations(),
    sendDefaultPii: false,
    maxBreadcrumbs: 10,
    tracesSampleRate: 0,
    sampleRate: 1,
    beforeSend: scrubSentryEvent,
  });

  sentry.getGlobalScope().setTags({
    extension_name: packageInfo.name,
    vscode_ui_kind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
    vscode_remote_name: vscode.env.remoteName || "none",
  });
  sentry.getGlobalScope().setContext("runtime", {
    vscodeVersion: vscode.version,
    nodeVersion: process.versions.node,
  });

  sentryEnabled = true;
  sentryStateKey = stateKey;
}

function captureError(error, source) {
  if (!sentryEnabled || !canSendAnalytics()) {
    return;
  }

  const sdk = loadSentry();
  if (!sdk) {
    return;
  }

  try {
    sdk.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("source", source);
      scope.setTag("error_name", redactSensitiveText(error && error.name ? error.name : "Error"));
      setErrorAnalyticsContext(scope, error);
      sdk.captureException(toSentryError(error));
    });
  } catch (_captureError) {
    // Error analytics must never break the extension's primary behavior.
  }
}

function captureAnalyticsEvent(eventName, { contexts = {}, tags = {} } = {}) {
  if (!sentryEnabled || !canSendAnalytics()) {
    return false;
  }

  const sdk = loadSentry();
  if (!sdk) {
    return false;
  }

  try {
    sdk.captureEvent({
      message: eventName,
      level: "info",
      tags: {
        analytics_event: eventName,
        ...tags,
      },
      contexts,
    });
    return true;
  } catch (_captureError) {
    return false;
  }
}

function setErrorAnalyticsContext(scope, error) {
  const analytics = error && error.errorAnalytics;
  if (!analytics || typeof analytics !== "object") {
    return;
  }

  for (const [name, value] of Object.entries(analytics.contexts || {})) {
    scope.setContext(name, value);
  }

  for (const [name, value] of Object.entries(analytics.tags || {})) {
    scope.setTag(name, redactSensitiveText(value));
  }
}

function toSentryError(error) {
  if (error instanceof Error) {
    const normalized = new Error(redactSensitiveText(error.message || error.name));
    normalized.name = redactSensitiveText(error.name || "Error");
    if (error.stack) {
      normalized.stack = redactSensitiveText(error.stack);
    }
    return normalized;
  }

  return new Error(redactSensitiveText(String(error)));
}

function scrubSentryEvent(event) {
  return scrubTelemetryValue(event);
}

function scrubTelemetryValue(value, depth = 0) {
  if (depth > 8) {
    return "[MaxDepth]";
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubTelemetryValue(item, depth + 1));
  }

  const scrubbed = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "user" || key === "request" || key === "server_name") {
      continue;
    }
    scrubbed[key] = scrubTelemetryValue(nestedValue, depth + 1);
  }
  return scrubbed;
}

function redactSensitiveText(value) {
  const text = String(value);
  const home = os.homedir();
  let redacted = text;

  if (home) {
    redacted = redacted.split(home).join("<home>");
  }

  redacted = redacted
    .replace(/\/Users\/[^/\s:]+/g, "/Users/<user>")
    .replace(/\/home\/[^/\s:]+/g, "/home/<user>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s:]+/g, "C:\\Users\\<user>");

  if (redacted.length > SENTRY_STRING_MAX_LENGTH) {
    return `${redacted.slice(0, SENTRY_STRING_MAX_LENGTH)}...`;
  }

  return redacted;
}

async function closeAnalytics() {
  if (!sentryEnabled || !sentry) {
    return;
  }

  sentryEnabled = false;
  sentryStateKey = "";

  try {
    await sentry.close(SENTRY_FLUSH_TIMEOUT_MS);
  } catch (_error) {
    // Best-effort flush only.
  }
}

async function reportInstallAnalytics(context) {
  try {
    if (context.globalState.get(INSTALL_ANALYTICS_REPORTED_KEY)) {
      return;
    }

    const packageInfo = getPackageInfo(context);
    const captured = captureAnalyticsEvent("extension.installed", {
      contexts: {
        extension_install: {
          name: packageInfo.name,
          version: packageInfo.version,
          installedVersion: packageInfo.version,
          activation: "firstActivation",
        },
        target_extension: getTargetExtensionContext(),
      },
      tags: {
        extension_version: packageInfo.version,
        installed_version: packageInfo.version,
        target_extension_version: getTargetExtensionVersion(),
      },
    });

    if (captured) {
      await context.globalState.update(INSTALL_ANALYTICS_REPORTED_KEY, {
        version: packageInfo.version,
        reportedAt: new Date().toISOString(),
      });
    }
  } catch (_error) {
    // Install analytics should never affect activation.
  }
}

function createAnalyticsError(message, analytics) {
  const error = new Error(message);
  error.errorAnalytics = analytics;
  return error;
}

function addErrorAnalytics(error, analytics) {
  if (error && typeof error === "object") {
    error.errorAnalytics = mergeErrorAnalytics(error.errorAnalytics, analytics);
  }
  return error;
}

function mergeErrorAnalytics(existing, next) {
  return {
    contexts: {
      ...((existing && existing.contexts) || {}),
      ...((next && next.contexts) || {}),
    },
    tags: {
      ...((existing && existing.tags) || {}),
      ...((next && next.tags) || {}),
    },
  };
}

function getTargetExtension() {
  return vscode.extensions.getExtension(TARGET_EXTENSION_ID);
}

function getTargetExtensionContext(extension = getTargetExtension()) {
  if (!extension) {
    return {
      id: TARGET_EXTENSION_ID,
      installed: false,
    };
  }

  const packageJson = extension.packageJSON || {};
  return {
    id: TARGET_EXTENSION_ID,
    installed: true,
    version: packageJson.version || "unknown",
    extensionPath: extension.extensionPath,
    isActive: Boolean(extension.isActive),
  };
}

function getTargetExtensionVersion(extension = getTargetExtension()) {
  return getTargetExtensionContext(extension).version || "not-installed";
}

function getSourceHash(source) {
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function getPatchDiagnostics(filePath, source, status, extension = getTargetExtension()) {
  return {
    contexts: {
      target_extension: getTargetExtensionContext(extension),
      patch_target: {
        filePath,
        backupExists: filePath ? fs.existsSync(`${filePath}${BACKUP_SUFFIX}`) : false,
        sourceLength: source.length,
        sourceSha256: getSourceHash(source),
      },
      patch_status: status,
    },
    tags: {
      target_extension_version: getTargetExtensionVersion(extension),
      target_source_sha256: getSourceHash(source),
    },
  };
}

function getTargetOnlyDiagnostics(filePath, extension = getTargetExtension()) {
  return {
    contexts: {
      target_extension: getTargetExtensionContext(extension),
      patch_target: {
        filePath,
        backupExists: filePath ? fs.existsSync(`${filePath}${BACKUP_SUFFIX}`) : false,
      },
    },
    tags: {
      target_extension_version: getTargetExtensionVersion(extension),
    },
  };
}

function getTargetExtensionPath() {
  const extension = getTargetExtension();
  if (!extension) {
    throw createAnalyticsError(
      `VS Code extension ${TARGET_EXTENSION_ID} is not installed.`,
      getTargetOnlyDiagnostics(undefined, extension)
    );
  }
  return extension.extensionPath;
}

function getExtensionJsPath() {
  return path.join(getTargetExtensionPath(), "extension.js");
}

function readTarget() {
  const filePath = getExtensionJsPath();
  try {
    return { filePath, source: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    throw addErrorAnalytics(error, getTargetOnlyDiagnostics(filePath));
  }
}

// Windows AV scanners and the extension host briefly hold the target file open
// after activation, surfacing as EBUSY/EPERM on writeFileSync. Retry with backoff.
async function retryOnTransientLock(operation) {
  const delays = [50, 150, 400, 1000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return operation();
    } catch (error) {
      const code = error && error.code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt === delays.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function applyPatch() {
  const { filePath, source } = readTarget();
  const status = analyze(source);
  let next = source;
  const changes = [];

  if (!status.envPatched) {
    if (!status.envPatchable) {
      throw createAnalyticsError(
        "Could not find the claudeCode.environmentVariables launch-env patch point.",
        getPatchDiagnostics(filePath, source, status)
      );
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
    await retryOnTransientLock(() => fs.copyFileSync(filePath, backupPath));
  }

  await retryOnTransientLock(() => fs.writeFileSync(filePath, next, "utf8"));
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
  const result = await applyPatch();
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

function withErrorAnalytics(source, task) {
  return async () => {
    try {
      return await task();
    } catch (error) {
      captureError(error, source);
      throw error;
    }
  };
}

function activate(context) {
  syncConfigDirEnv();
  initializeAnalytics(context);
  void reportInstallAnalytics(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("claudeCode.environmentVariables")) {
        syncConfigDirEnv();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeConfigDirPatcher.apply",
      withErrorAnalytics("command.apply", () => applyAndReport())
    ),
    vscode.commands.registerCommand(
      "claudeConfigDirPatcher.verify",
      withErrorAnalytics("command.verify", verifyAndReport)
    ),
    vscode.commands.registerCommand(
      "claudeConfigDirPatcher.restore",
      withErrorAnalytics("command.restore", restoreAndReport)
    )
  );

  if (getConfig().get("autoPatch", true)) {
    applyAndReport({ quiet: !getConfig().get("showStartupNotifications", false) }).catch((error) => {
      captureError(error, "startup.autoPatch");
      vscode.window.showWarningMessage(`Claude Code Config Dir auto-patch failed: ${error.message}`);
    });
  }
}

async function deactivate() {
  await closeAnalytics();
}

module.exports = {
  activate,
  deactivate,
};
