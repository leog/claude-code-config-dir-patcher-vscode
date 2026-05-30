// Upstream patchability check.
//
// Downloads the latest N anthropic.claude-code builds from the VS Code
// Marketplace (default 3, or an explicit --versions=a,b,c list) and, for each,
// runs the SHARED runtime patch core against the real minified extension.js to
// assert the patch still:
//   1. analyzes as patchable (or already patched),
//   2. applies and produces the recognized patched form, and
//   3. is idempotent (re-applying changes nothing).
//
// Exit codes:
//   0 = all checked versions remain patchable
//   1 = a real regression: a version is no longer patchable / verify failed
//   2 = infrastructure error: marketplace/network/unzip failure (no verdict)
//
// The distinct codes let the PR gate soft-fail on infra hiccups while still
// hard-failing on genuine patch breaks, and let the scheduled job open a
// tracking issue only on code 1.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { analyze, applyPatch } = require("../patch-core.js");

const TARGET_EXTENSION = "anthropic.claude-code";
const TARGET_PLATFORM = "win32-x64";
const DEFAULT_VERSION_COUNT = 3;

class InfraError extends Error {}

function parseArgs(argv) {
  let versions = null;
  let count = DEFAULT_VERSION_COUNT;
  for (const arg of argv) {
    if (arg.startsWith("--versions=")) {
      versions = arg
        .slice("--versions=".length)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--count=")) {
      const parsed = Number.parseInt(arg.slice("--count=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        count = parsed;
      }
    }
  }
  return { versions, count };
}

async function fetchLatestVersions(count) {
  let response;
  try {
    response = await fetch(
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json;api-version=3.0-preview.1",
        },
        body: JSON.stringify({
          filters: [{ criteria: [{ filterType: 7, value: TARGET_EXTENSION }] }],
          flags: 0x1,
        }),
      }
    );
  } catch (error) {
    throw new InfraError(`Marketplace query request failed: ${error.message}`);
  }
  if (!response.ok) {
    throw new InfraError(
      `Marketplace query failed: ${response.status} ${response.statusText}`
    );
  }
  const data = await response.json();
  const extension = data?.results?.[0]?.extensions?.[0];
  const rawVersions = extension?.versions;
  if (!Array.isArray(rawVersions) || rawVersions.length === 0) {
    throw new InfraError("Could not parse versions from marketplace response.");
  }
  // The marketplace returns one entry per (version, targetPlatform), newest
  // first. Dedupe by version string, preserving order, and take the newest N.
  const seen = new Set();
  const unique = [];
  for (const entry of rawVersions) {
    if (entry?.version && !seen.has(entry.version)) {
      seen.add(entry.version);
      unique.push(entry.version);
    }
  }
  if (unique.length === 0) {
    throw new InfraError("Marketplace response contained no usable versions.");
  }
  return unique.slice(0, count);
}

async function downloadExtensionJs(version) {
  const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/anthropic/vsextensions/claude-code/${version}/vspackage?targetPlatform=${TARGET_PLATFORM}`;
  let response;
  try {
    response = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
  } catch (error) {
    throw new InfraError(`VSIX download request failed for ${version}: ${error.message}`);
  }
  if (!response.ok) {
    throw new InfraError(
      `VSIX download failed for ${version}: ${response.status} ${response.statusText}`
    );
  }
  // The marketplace serves the VSIX with Content-Encoding: gzip and Node's
  // fetch transparently decodes it, so the body is the raw zip already.
  const zipBuffer = Buffer.from(await response.arrayBuffer());

  const workDir = mkdtempSync(join(tmpdir(), "claude-code-upstream-check-"));
  try {
    const zipPath = join(workDir, "package.zip");
    const outPath = join(workDir, "extension.js");
    writeFileSync(zipPath, zipBuffer);
    try {
      execSync(`unzip -p "${zipPath}" extension/extension.js > "${outPath}"`);
    } catch (error) {
      throw new InfraError(`Failed to unzip VSIX for ${version}: ${error.message}`);
    }
    const source = readFileSync(outPath, "utf8");
    // A real Claude Code extension.js is well over 1 MB. Anything tiny means a
    // truncated/corrupt download, not a patch regression — treat it as infra so
    // it never opens a false tracking issue or blocks a PR.
    const MIN_PLAUSIBLE_BYTES = 100_000;
    if (source.length < MIN_PLAUSIBLE_BYTES) {
      throw new InfraError(
        `Downloaded extension.js for ${version} is implausibly small (${source.length} bytes); likely a truncated download.`
      );
    }
    return source;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Returns { ok, reason } for a single version. ok=false is a real regression.
function verifyVersion(version, source) {
  const before = analyze(source);

  // ENV is the load-bearing patch point. IDE handling is optional: newer builds
  // route it through a CLAUDE_CONFIG_DIR-aware helper, so an absent IDE needle
  // is fine as long as it isn't present-and-unpatched.
  if (!before.envPatched && !before.envPatchable) {
    return {
      ok: false,
      reason: "ENV patch point not found (neither needle nor patched form matched).",
    };
  }

  const { next, changes } = applyPatch(source);
  const after = analyze(next);

  if (!after.envPatched) {
    return { ok: false, reason: "ENV patched form not present after applying patch." };
  }

  const ideOk = after.idePatched || !after.idePatchable;
  if (!ideOk) {
    return { ok: false, reason: "IDE needle present but patched form not produced." };
  }

  // Idempotency: re-applying the patch must change nothing.
  const second = applyPatch(next);
  if (second.changes.length !== 0) {
    return {
      ok: false,
      reason: `Patch is not idempotent: re-apply produced changes [${second.changes.join(", ")}].`,
    };
  }

  return {
    ok: true,
    reason:
      changes.length === 0
        ? "already patched / no changes needed"
        : `applied [${changes.join(", ")}]`,
  };
}

async function main() {
  const { versions: explicit, count } = parseArgs(process.argv.slice(2));
  const versions = explicit ?? (await fetchLatestVersions(count));

  console.log(
    `Checking ${versions.length} ${TARGET_EXTENSION} version(s) (${TARGET_PLATFORM}): ${versions.join(", ")}\n`
  );

  const failures = [];
  for (const version of versions) {
    const source = await downloadExtensionJs(version);
    const result = verifyVersion(version, source);
    const status = result.ok ? "OK  " : "FAIL";
    console.log(`[${status}] ${version} — ${result.reason}`);
    if (!result.ok) {
      failures.push(version);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nFAIL: ${failures.length} version(s) no longer patch cleanly: ${failures.join(", ")}.`
    );
    console.error(
      "Upstream likely changed its minified output. Update the regexes in patch-regexes.js before users on these builds get a working patch."
    );
    process.exit(1);
  }

  console.log(`\nOK: Patcher remains compatible with all ${versions.length} checked version(s).`);
}

main().catch((error) => {
  if (error instanceof InfraError) {
    console.error(`Upstream check infrastructure error: ${error.message}`);
    process.exit(2);
  }
  console.error("Upstream check encountered an unexpected error:", error.message);
  process.exit(2);
});
