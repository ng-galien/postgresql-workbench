import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputRoot = path.resolve(process.argv[2] ?? "dist");
const packageJson = `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`;

for (const directory of ["packages", "vscode-extension"]) {
  const target = path.join(outputRoot, directory);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "package.json"), packageJson);
}
