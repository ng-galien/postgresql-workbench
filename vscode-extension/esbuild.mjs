import * as esbuild from "esbuild";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, resolve, sep } from "path";
import viewBundles from "../packages/views/viewBundles.json" with { type: "json" };

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

function mitLicense(copyright) {
  return `The MIT License (MIT)

Copyright (c) ${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

function cleanDist() {
  rmSync(resolve("dist"), { recursive: true, force: true });
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  metafile: true,
};

/** @type {import('esbuild').BuildOptions} */
const dapConnectionConfig = {
  entryPoints: ["src/dapServer.ts"],
  bundle: true,
  outfile: "dist/dap-server.js",
  external: ["@code-moniker/client"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  metafile: true,
};

/** @type {import('esbuild').BuildOptions} */
const sqlAuthoringConnectionConfig = {
  entryPoints: ["../packages/sql/src/languageServer/server.ts"],
  bundle: true,
  outfile: "dist/sql-authoring-server.js",
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  metafile: true,
};

/**
 * A view bundle, from the one record that also tells the Extension Host which file to load.
 * `styles: "inlined"` turns CSS and fonts into strings the bundle injects into the shadow root it
 * renders in; `styles: "linked"` leaves esbuild to emit the sibling .css the page shell links.
 */
function viewConfig(bundle) {
  return {
    entryPoints: [`../packages/views/${bundle.entry}`],
    bundle: true,
    outfile: `dist/${bundle.script}`,
    format: bundle.format ?? "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    ...(bundle.styles === "inlined" ? { loader: { ".css": "text", ".ttf": "dataurl" } } : {}),
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: !production,
    minify: production,
    metafile: true,
  };
}

/** @type {import('esbuild').BuildOptions} */
const graphWebviewConfig = viewConfig(viewBundles.cockpitGraph);

/** @type {import('esbuild').BuildOptions} */
const sqlNotebookRendererConfig = viewConfig(viewBundles.notebookResults);

/** @type {import('esbuild').BuildOptions} */
const dataViewWebviewConfig = viewConfig(viewBundles.dataView);

/** @type {import('esbuild').BuildOptions} */
const debugResultsWebviewConfig = viewConfig(viewBundles.debugResults);

function packageRootForInput(input) {
  let current = dirname(resolve(input));
  const nodeModulesSegment = `${sep}node_modules${sep}`;
  while (current !== dirname(current)) {
    const manifest = resolve(current, "package.json");
    if (current.includes(nodeModulesSegment) && existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8"));
      if (typeof metadata.name === "string" && metadata.name.length > 0) return current;
    }
    current = dirname(current);
  }
  return undefined;
}

function normalizeLicenseText(content) {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function packageNotice(packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const licenseFiles = readdirSync(packageRoot)
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)(\.|$|-)/i.test(name))
    .sort();
  let texts = licenseFiles.map((name) => ({
    name,
    content: normalizeLicenseText(readFileSync(resolve(packageRoot, name), "utf8")),
  }));
  if (texts.length === 0 && manifest.license === "MIT" && manifest.author) {
    const author =
      typeof manifest.author === "string" ? manifest.author : manifest.author.name;
    texts = [
      {
        name: "MIT License (reconstructed from package metadata)",
        content: mitLicense(author),
      },
    ];
  }
  if (texts.length === 0) {
    throw new Error(
      `No license text found for bundled package ${manifest.name ?? "<unnamed>"} at ${packageRoot}`,
    );
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? "See included license text",
    source: manifest.repository?.url ?? manifest.homepage,
    texts,
  };
}

function generateThirdPartyNotices(metafiles) {
  const packageRoots = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const packageRoot = packageRootForInput(input);
      if (packageRoot) packageRoots.add(packageRoot);
    }
  }

  const noticesByPackage = new Map();
  for (const packageRoot of packageRoots) {
    const notice = packageNotice(packageRoot);
    noticesByPackage.set(`${notice.name}@${notice.version}`, notice);
  }
  const notices = [...noticesByPackage.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const sections = notices.map((notice) => {
    const source = notice.source ? `\nSource: ${notice.source}` : "";
    const texts = notice.texts
      .map((text) => `### ${text.name}\n\n\`\`\`\`text\n${text.content}\n\`\`\`\``)
      .join("\n\n");
    return `## ${notice.name}@${notice.version}\n\nLicense: ${notice.license}${source}\n\n${texts}`;
  });
  const header = `# Third-Party Notices

This file is generated from the exact esbuild inputs bundled in the extension.
It includes the complete license files shipped by each bundled npm package.

`;
  writeFileSync(resolve("THIRD_PARTY_NOTICES.md"), `${header}${sections.join("\n\n")}\n`);
}

async function main() {
  if (watch) {
    cleanDist();
    const extCtx = await esbuild.context(extensionConfig);
    const dapCtx = await esbuild.context(dapConnectionConfig);
    const sqlAuthoringCtx = await esbuild.context(sqlAuthoringConnectionConfig);
    const graphCtx = await esbuild.context(graphWebviewConfig);
    const notebookRendererCtx = await esbuild.context(sqlNotebookRendererConfig);
    const dataViewCtx = await esbuild.context(dataViewWebviewConfig);
    const debugResultsCtx = await esbuild.context(debugResultsWebviewConfig);
    await Promise.all([
      extCtx.watch(),
      dapCtx.watch(),
      sqlAuthoringCtx.watch(),
      graphCtx.watch(),
      notebookRendererCtx.watch(),
      dataViewCtx.watch(),
      debugResultsCtx.watch(),
    ]);
    console.log("Watching for changes...");
  } else {
    cleanDist();
    const results = await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(dapConnectionConfig),
      esbuild.build(sqlAuthoringConnectionConfig),
      esbuild.build(graphWebviewConfig),
      esbuild.build(sqlNotebookRendererConfig),
      esbuild.build(dataViewWebviewConfig),
      esbuild.build(debugResultsWebviewConfig),
    ]);
    generateThirdPartyNotices(results.map((result) => result.metafile));
    console.log("Build complete.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
