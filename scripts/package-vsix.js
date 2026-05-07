const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outFile = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${pkg.name}-vsix-`));
const extensionDir = path.join(tempRoot, "extension");

function copyFile(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(extensionDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

fs.mkdirSync(extensionDir, { recursive: true });
for (const file of ["package.json", "extension.js", "README.md", "assets/icon.png"]) {
  copyFile(file);
}

fs.writeFileSync(
  path.join(tempRoot, "[Content_Types].xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`,
  "utf8"
);

fs.writeFileSync(
  path.join(tempRoot, "extension.vsixmanifest"),
  `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(pkg.name)}" Version="${xmlEscape(pkg.version)}" Publisher="${xmlEscape(pkg.publisher)}" />
    <DisplayName>${xmlEscape(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(pkg.description)}</Description>
    <Categories>${xmlEscape((pkg.categories || []).join(","))}</Categories>
    <Tags>claude,claude-code,config,profiles</Tags>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines.vscode)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`,
  "utf8"
);

try {
  fs.rmSync(outFile, { force: true });
  cp.execFileSync("zip", ["-qr", outFile, "."], { cwd: tempRoot, stdio: "inherit" });
  console.log(outFile);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
