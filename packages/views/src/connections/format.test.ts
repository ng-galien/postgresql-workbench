import { describe, expect, it } from "vitest";
import { formatBytes, formatSince, postgresVersionHeadline } from "./format.js";

describe("Connections page formats", () => {
  it("shows sizes in the largest unit that keeps a meaningful digit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2.0 KB");
    expect(formatBytes(7_340_032)).toBe("7.0 MB");
    expect(formatBytes(150 * 1024 ** 3)).toBe("150 GB");
    expect(formatBytes(Number.NaN)).toBe("—");
  });

  it("shows elapsed time in the largest honest unit", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    expect(formatSince("2026-09-01T11:59:52Z", now)).toBe("8 s");
    expect(formatSince("2026-09-01T11:12:00Z", now)).toBe("48 min");
    expect(formatSince("2026-09-01T07:30:00Z", now)).toBe("4 h 30 min");
    expect(formatSince("2026-08-29T09:00:00Z", now)).toBe("3 d 3 h");
    expect(formatSince("not-a-date", now)).toBe("—");
  });

  it("keeps the PostgreSQL headline and drops the build suffix", () => {
    expect(
      postgresVersionHeadline(
        "PostgreSQL 17.5 (Debian 17.5-1.pgdg120+1) on aarch64-unknown-linux-gnu",
      ),
    ).toBe("PostgreSQL 17.5");
  });
});
