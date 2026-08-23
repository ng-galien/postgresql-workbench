#!/usr/bin/env node
/*
 * The Marketplace page is a product surface, and a card that names a missing file shows a broken
 * image to everyone who opens it. A scene declared in the showcase manifest, the two files it
 * produces, and the README that shows them are one thing in three places; this refuses to let them
 * drift apart.
 *
 * It runs in `npm run check`, so a card promised and never captured fails the build rather than
 * the page.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionRoot = path.join(repoRoot, "vscode-extension");
const manifestPath = path.join(repoRoot, "docs", "marketplace-showcase.json");
const readmePath = path.join(extensionRoot, "README.md");
const mediaDir = path.join(extensionRoot, "media", "marketplace");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const readme = readFileSync(readmePath, "utf8");
const failures = [];

/** The version the showcase captures against is the version being released, never the last one. */
const declaredVsix = String(manifest.extensionVsix ?? "");
const extensionVersion = JSON.parse(
  readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
).version;
if (!declaredVsix.includes(`-${extensionVersion}-`)) {
  failures.push(
    `docs/marketplace-showcase.json pins ${declaredVsix}, but the extension is ${extensionVersion}. ` +
      "A capture would film the wrong version.",
  );
}

for (const scene of manifest.scenes ?? []) {
  for (const extension of ["gif", "png"]) {
    const asset = `${scene.file}.${extension}`;
    if (!existsSync(path.join(mediaDir, asset))) {
      failures.push(
        `Scene "${scene.id}" declares ${asset}, which does not exist. ` +
          `Capture it with: npm run marketplace:media -- capture ${scene.id}`,
      );
    }
  }
  if (!readme.includes(`./media/marketplace/${scene.file}.gif`)) {
    failures.push(
      `Scene "${scene.id}" is declared but ${scene.file}.gif is not shown in vscode-extension/README.md.`,
    );
  }
}

/* The other direction: a card left in the README after its scene was retired shows a stale promise. */
const declared = new Set((manifest.scenes ?? []).map((scene) => `${scene.file}.gif`));
for (const [, shown] of readme.matchAll(/\.\/media\/marketplace\/([\w-]+\.gif)/gu)) {
  if (!declared.has(shown)) {
    failures.push(`vscode-extension/README.md shows ${shown}, which no showcase scene declares.`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Marketplace media:\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
  process.exit(1);
}
