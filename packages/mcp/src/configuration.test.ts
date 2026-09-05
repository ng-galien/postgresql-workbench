import { describe, expect, it } from "vitest";
import { environmentProfiles } from "./configuration.js";

describe("MCP connection configuration", () => {
  it("requires an explicit database and role instead of falling back to local defaults", () => {
    expect(() => environmentProfiles({})).toThrow();
    expect(
      environmentProfiles({ PGDATABASE: "testdb", PGUSER: "tester" }).map(({ id }) => id),
    ).toEqual(["default"]);
  });

  it("rejects inline secrets and duplicate profile identities", () => {
    const profile = { id: "test", host: "localhost", database: "testdb", user: "tester" };
    expect(() =>
      environmentProfiles({ PGWB_MCP_PROFILES: JSON.stringify([{ ...profile, password: "" }]) }),
    ).toThrow();
    expect(() =>
      environmentProfiles({ PGWB_MCP_PROFILES: JSON.stringify([profile, profile]) }),
    ).toThrow("Duplicate");
  });
});
