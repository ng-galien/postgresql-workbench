#!/usr/bin/env node
/*
 * The Marketplace page is a product surface, and a card naming a file that is not there shows a
 * broken image to everyone who opens it. This runs in `npm run check`, so a page and its media
 * cannot drift apart without the build saying so.
 *
 * The rule itself lives in `scripts/marketplace/mediaContract.mjs`, with the gate that validates
 * a capture and the one that verifies the packaged VSIX. Pass `--release` — as the RELEASING gate
 * does — to refuse a card still declared pending, which is the difference between a working tree
 * and a tag.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marketplaceMediaReport } from "../marketplace/mediaContract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionRoot = path.join(repoRoot, "vscode-extension");
const mediaDir = path.join(extensionRoot, "media", "marketplace");
const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "docs", "marketplace-showcase.json"), "utf8"),
);

const { failures, pending } = marketplaceMediaReport({
  scenes: manifest.scenes ?? [],
  readme: readFileSync(path.join(extensionRoot, "README.md"), "utf8"),
  captured: (asset) => existsSync(path.join(mediaDir, asset)),
  release: process.argv.includes("--release"),
});

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
