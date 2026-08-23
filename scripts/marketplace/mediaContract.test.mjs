import { describe, expect, it } from "vitest";
import {
  marketplaceMediaReport,
  showcaseVsixName,
  shownMarketplaceCards,
} from "./mediaContract.mjs";

const CARD = (file) => `![Something](./media/marketplace/${file}.gif)`;
const scene = (id, file, extra = {}) => ({ id, file, ...extra });
/** What exists on disk, as the report asks about it: a set of filenames. */
const onDisk = (...files) => {
  const present = new Set(files);
  return (file) => present.has(file);
};

function report(options) {
  return marketplaceMediaReport({ release: false, ...options });
}

describe("shownMarketplaceCards", () => {
  it("reads the cards the page shows, in the order it shows them", () => {
    const readme = `${CARD("02-second")}\n\ntext\n\n${CARD("01-first")}\n`;
    expect(shownMarketplaceCards(readme)).toEqual(["02-second.gif", "01-first.gif"]);
  });

  it("does not mistake a name it cannot spell for a card that is not there", () => {
    expect(shownMarketplaceCards(CARD("05-data-view.2"))).toEqual(["05-data-view.2.gif"]);
  });
});

describe("marketplaceMediaReport", () => {
  it("passes when every card shown is captured", () => {
    const { failures, pending } = report({
      scenes: [scene("cockpit", "01-cockpit")],
      readme: CARD("01-cockpit"),
      captured: onDisk("01-cockpit.gif", "01-cockpit.png"),
    });
    expect(failures).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("refuses a card the page promises and nobody filmed", () => {
    const { failures } = report({
      scenes: [scene("cockpit", "01-cockpit")],
      readme: CARD("01-cockpit"),
      captured: onDisk(),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("has not been captured");
  });

  it("counts a poster that is missing as not captured, animation or no animation", () => {
    const { failures } = report({
      scenes: [scene("cockpit", "01-cockpit")],
      readme: CARD("01-cockpit"),
      captured: onDisk("01-cockpit.gif"),
    });
    expect(failures[0]).toContain("has not been captured");
  });

  it("refuses a card that was filmed and then forgotten", () => {
    const { failures } = report({
      scenes: [scene("cockpit", "01-cockpit")],
      readme: "no cards here",
      captured: onDisk("01-cockpit.gif", "01-cockpit.png"),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("no card shows it");
  });

  it("refuses a card the page shows that no scene can ever recapture", () => {
    const { failures } = report({
      scenes: [],
      readme: CARD("99-orphan"),
      captured: onDisk("99-orphan.gif", "99-orphan.png"),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("no showcase scene declares");
  });

  it("holds a scene written but never filmed, when someone said so", () => {
    const { failures, pending } = report({
      scenes: [scene("data-view", "05-data-view", { card: "pending" })],
      readme: "no cards here",
      captured: onDisk(),
    });
    expect(failures).toEqual([]);
    expect(pending.map((held) => held.id)).toEqual(["data-view"]);
  });

  it("refuses that same scene when it is a release rather than a working tree", () => {
    const { failures } = report({
      scenes: [scene("data-view", "05-data-view", { card: "pending" })],
      readme: "no cards here",
      captured: onDisk(),
      release: true,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"card": "pending"');
  });

  it("refuses a scene that is neither filmed nor shown nor declared as pending", () => {
    const { failures } = report({
      scenes: [scene("data-view", "05-data-view")],
      readme: "no cards here",
      captured: onDisk(),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("neither captured nor shown");
  });

  it("stops holding a pending scene the moment its card appears", () => {
    const { failures, pending } = report({
      scenes: [scene("data-view", "05-data-view", { card: "pending" })],
      readme: CARD("05-data-view"),
      captured: onDisk("05-data-view.gif", "05-data-view.png"),
    });
    expect(failures).toEqual([]);
    expect(pending).toEqual([]);
  });
});

describe("showcaseVsixName", () => {
  it("names the artifact of the version being released, on this host", () => {
    expect(showcaseVsixName("1.4.0", "darwin-arm64")).toBe(
      "postgresql-workbench-1.4.0-darwin-arm64.vsix",
    );
  });
});
