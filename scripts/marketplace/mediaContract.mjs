/*
 * What the Marketplace page promises, and whether it is kept.
 *
 * A card is one thing in four places: a scene in the showcase manifest, the GIF and the poster it
 * produces, the card the extension README shows, and the copy the documentation site takes. Each
 * used to answer "is the media ready?" on its own, and two of them answered differently on the
 * same tree — one calling a scene that had never been filmed a failure, the other calling it work
 * in progress.
 *
 * The rule lives here, once, as a function over plain data: no files, no exits, so it can be
 * tested and so every gate reaches the same verdict.
 */

/** Which cards the extension README actually shows, in the order it shows them. */
export function shownMarketplaceCards(readme) {
  return [...readme.matchAll(/\.\/media\/marketplace\/([^)\s]+\.gif)/gu)].map(([, gif]) => gif);
}

/** The two files a scene produces: the animation, and the still the Marketplace shows first. */
export function sceneAssets(scene) {
  return { gif: `${scene.file}.gif`, poster: `${scene.file}.png` };
}

/**
 * Whether every card is where the page says it is.
 *
 * A scene may declare `card: "pending"`: it is written, it has never been filmed, and the page
 * does not show it. That is a state someone wrote down, not one inferred from an absence — so
 * `pending` is what a reader sees during development, and `release` is what refuses to let a tag
 * carry it.
 *
 * @param scenes    the showcase manifest's scenes
 * @param readme    the extension README, as text
 * @param captured  answers whether a media file exists
 * @param release   whether a pending card is a failure rather than a note
 */
export function marketplaceMediaReport({ scenes, readme, captured, release = false }) {
  const shown = new Set(shownMarketplaceCards(readme));
  const failures = [];
  const pending = [];

  for (const scene of scenes) {
    const { gif, poster } = sceneAssets(scene);
    const isShown = shown.has(gif);
    const isCaptured = captured(gif) && captured(poster);
    shown.delete(gif);

    if (scene.card === "pending" && !isShown && !isCaptured) {
      pending.push(scene);
      if (release) {
        failures.push(
          `Scene "${scene.id}" is still marked \`"card": "pending"\`. Capture it with: ` +
            `npm run marketplace:media -- capture ${scene.id}, show it in the README, and drop ` +
            "the field — or take the scene out of the manifest.",
        );
      }
      continue;
    }
    if (isShown && !isCaptured) {
      failures.push(
        `The README shows ${gif}, which has not been captured. ` +
          `Capture it with: npm run marketplace:media -- capture ${scene.id}`,
      );
    }
    if (isCaptured && !isShown) {
      failures.push(
        `Scene "${scene.id}" is captured but no card shows it in vscode-extension/README.md. ` +
          `Add its section with: ![…](./media/marketplace/${gif})`,
      );
    }
    if (!isShown && !isCaptured) {
      failures.push(
        `Scene "${scene.id}" is neither captured nor shown. Capture it with: ` +
          `npm run marketplace:media -- capture ${scene.id}, or mark it \`"card": "pending"\` ` +
          "while it is being written.",
      );
    }
  }

  /* A card the page shows that no scene declares: nothing can ever recapture it. */
  for (const orphan of shown) {
    failures.push(`vscode-extension/README.md shows ${orphan}, which no showcase scene declares.`);
  }

  return { failures, pending };
}

/**
 * The VSIX a capture must load: the version being released, on this host's target. It is derived
 * rather than written down, because a filename pinned in a manifest is a release chore that is
 * remembered once and then films the previous version.
 */
export function showcaseVsixName(version, target) {
  return `postgresql-workbench-${version}-${target}.vsix`;
}
