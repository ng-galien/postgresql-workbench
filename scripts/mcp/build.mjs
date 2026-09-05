import { build } from "esbuild";

const result = await build({
  entryPoints: ["packages/mcp/src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  packages: "external",
  metafile: true,
  outfile: "dist/mcp/server.cjs",
});
const forbidden = Object.keys(result.metafile.inputs).filter((path) =>
  /vscode-extension|packages\/(views|editor|shell)\//.test(path),
);
if (forbidden.length) throw new Error(`MCP depends on an editor host: ${forbidden.join(", ")}`);
