// Daily upstream check: fetch the latest anthropic.claude-code VSIX from the
// VS Code Marketplace and assert that the patcher's regex needle still matches.
// Exits non-zero when the patcher would no longer apply, so the GitHub Actions
// cron can open a tracking issue before users hit the failure.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { ENV_NEEDLE_REGEX, ENV_PATCHED_REGEX } = require("../patch-regexes.js");

const TARGET_EXTENSION = "anthropic.claude-code";
const TARGET_PLATFORM = "win32-x64";

async function fetchLatestVersion() {
  const response = await fetch(
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
  if (!response.ok) {
    throw new Error(`Marketplace query failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const extension = data?.results?.[0]?.extensions?.[0];
  const version = extension?.versions?.[0]?.version;
  if (!version) {
    throw new Error("Could not parse latest version from marketplace response.");
  }
  return version;
}

async function downloadExtensionJs(version) {
  const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/anthropic/vsextensions/claude-code/${version}/vspackage?targetPlatform=${TARGET_PLATFORM}`;
  const response = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
  if (!response.ok) {
    throw new Error(`VSIX download failed: ${response.status} ${response.statusText}`);
  }
  // The marketplace serves the VSIX with Content-Encoding: gzip and Node's
  // fetch transparently decodes it, so the body is the raw zip already.
  const zipBuffer = Buffer.from(await response.arrayBuffer());

  const workDir = mkdtempSync(join(tmpdir(), "claude-code-upstream-check-"));
  try {
    const zipPath = join(workDir, "package.zip");
    const outPath = join(workDir, "extension.js");
    writeFileSync(zipPath, zipBuffer);
    execSync(`unzip -p "${zipPath}" extension/extension.js > "${outPath}"`);
    return readFileSync(outPath, "utf8");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const version = await fetchLatestVersion();
  console.log(`Latest ${TARGET_EXTENSION} version: ${version} (${TARGET_PLATFORM})`);

  const source = await downloadExtensionJs(version);
  const envPatched = ENV_PATCHED_REGEX.test(source);
  const envPatchable = ENV_NEEDLE_REGEX.test(source);

  console.log(`envPatched:   ${envPatched}`);
  console.log(`envPatchable: ${envPatchable}`);

  if (!envPatched && !envPatchable) {
    console.error(
      `\nFAIL: Neither the env-patch needle nor the already-patched form was found in ${TARGET_EXTENSION}@${version}.`
    );
    console.error(
      "Upstream likely changed its minified output. The patcher needs an updated ENV_NEEDLE_REGEX before users on this build will get a working patch."
    );
    process.exit(1);
  }

  console.log(`\nOK: Patcher remains compatible with ${TARGET_EXTENSION}@${version}.`);
}

main().catch((error) => {
  console.error("Upstream check encountered an error:", error.message);
  process.exit(2);
});
