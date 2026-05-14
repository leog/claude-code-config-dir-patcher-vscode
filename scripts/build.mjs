import { build } from "esbuild";

await build({
  entryPoints: ["extension.js"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  outfile: "dist/extension.js",
  minify: true,
  keepNames: true,
  legalComments: "none",
  define: {
    __SENTRY_DEBUG__: "false",
  },
});
