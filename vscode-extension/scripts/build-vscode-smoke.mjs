import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["tests/vscode/smoke/extension.smoke.ts"],
  external: ["vscode"],
  format: "cjs",
  logLevel: "info",
  outfile: "dist/smoke/extension.smoke.cjs",
  platform: "node",
  sourcemap: true,
  target: "node22",
});
