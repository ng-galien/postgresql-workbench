import { describe, expect, it } from "vitest";
import { postgresClientConfig } from "./postgresClientConfig.js";

describe("PostgreSQL client configuration", () => {
  it("lets a dedicated listener disable the configured statement timeout", () => {
    const config = postgresClientConfig({
      host: "localhost",
      port: 5432,
      database: "demo",
      user: "postgres",
      password: "secret",
      tuning: { statementTimeoutMs: 2_500 },
      statementTimeoutMs: 0,
    });

    expect(config.statement_timeout).toBe(0);
  });
});
