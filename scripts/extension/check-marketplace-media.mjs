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

const pending = [];
for (const scene of manifest.scenes ?? []) {
  const shown = readme.includes(`./media/marketplace/${scene.file}.gif`);
  const assets = ["gif", "png"].map((extension) => `${scene.file}.${extension}`);
  const captured = assets.every((asset) => existsSync(path.join(mediaDir, asset)));

  /*
   * A scene declared but not yet filmed is work in progress, not a defect — what must never ship
   * is a page promising a card that is not there. So the rule is the pair, in both directions:
   * shown means captured, and captured means shown.
   */
  if (shown && !captured) {
    failures.push(
      `The README shows ${scene.file}.gif, which has not been captured. ` +
        `Capture it with: npm run marketplace:media -- capture ${scene.id}`,
    );
  }
  if (captured && !shown) {
    failures.push(
      `Scene "${scene.id}" is captured but no card shows it in vscode-extension/README.md. ` +
        `Add its section with:\n      ![…](./media/marketplace/${scene.file}.gif)`,
    );
  }
  if (!captured && !shown) pending.push(scene);
}

for (const scene of pending) {
  process.stdout.write(
    `Marketplace media: scene "${scene.id}" is written but never filmed. ` +
      `Capture it with: npm run marketplace:media -- capture ${scene.id}\n`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`Marketplace media:\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
  process.exit(1);
}
