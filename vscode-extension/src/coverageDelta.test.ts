import { describe, expect, it } from "vitest";
import { coverageDelta, indexCoverageSnapshot } from "./coverageDelta.js";

describe("per-test coverage snapshots", () => {
  it("copies marker counters so later mutations cannot change an earlier snapshot", () => {
    const executions = new Map([
      ["statement:a", 1],
      ["branch:b", 0],
    ]);
    const snapshot = indexCoverageSnapshot([{ routineOid: 42, executions }]);

    executions.set("statement:a", 9);

    expect(snapshot.get(42)?.get("statement:a")).toBe(1);
  });

  it("attributes only the counters added by one test across multiple routines", () => {
    const previous = new Map([
      [42, new Map([["statement:a", 2]])],
      [84, new Map([["statement:z", 5]])],
    ]);
    const current = new Map([
      [
        42,
        new Map([
          ["statement:a", 3],
          ["branch:b", 1],
        ]),
      ],
      [84, new Map([["statement:z", 5]])],
    ]);

    expect(coverageDelta(previous, current)).toEqual(
      new Map([
        [
          42,
          new Map([
            ["statement:a", 1],
            ["branch:b", 1],
          ]),
        ],
        [84, new Map([["statement:z", 0]])],
      ]),
    );
  });

  it("never emits negative executions when a backend counter is reset", () => {
    expect(
      coverageDelta(
        new Map([[42, new Map([["statement:a", 4]])]]),
        new Map([[42, new Map([["statement:a", 1]])]]),
      )
        .get(42)
        ?.get("statement:a"),
    ).toBe(0);
  });
});
