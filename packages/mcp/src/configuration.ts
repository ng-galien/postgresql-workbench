import { Client } from "pg";
import { z } from "zod";
import type { ConnectionProfile } from "../../runtime/src/sessions.js";

const profileSchema = z
  .object({
    id: z.string().min(1).max(80),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5432),
    database: z.string().min(1),
    user: z.string().min(1),
    passwordEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
    ssl: z.boolean().default(false),
  })
  .strict();

/** The launcher supplies credentials; MCP arguments and profile descriptions never contain them. */
export function environmentProfiles(env: NodeJS.ProcessEnv): ConnectionProfile[] {
  const input: unknown = env.PGWB_MCP_PROFILES
    ? JSON.parse(env.PGWB_MCP_PROFILES)
    : [
        {
          id: "default",
          host: env.PGHOST ?? "localhost",
          port: Number(env.PGPORT ?? 5432),
          database: env.PGDATABASE,
          user: env.PGUSER,
          passwordEnv: "PGPASSWORD",
        },
      ];
  const profiles = z.array(profileSchema).min(1).max(16).parse(input);
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length)
    throw new Error("Duplicate connection profile id.");
  return profiles.map((profile) => ({
    id: profile.id,
    label: profile.id,
    async open() {
      const client = new Client({
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        password: profile.passwordEnv ? env[profile.passwordEnv] : undefined,
        ssl: profile.ssl ? { rejectUnauthorized: true } : false,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 30_000,
        application_name: "postgresql-workbench-mcp",
      });
      try {
        await client.connect();
        return client;
      } catch (error) {
        await client.end().catch(() => undefined);
        throw error;
      }
    },
  }));
}

export function secretRedactor(env: NodeJS.ProcessEnv): (text: string) => string {
  const values = Object.entries(env)
    .filter(([key, value]) => value && /PASSWORD|SECRET|TOKEN|KEY$/.test(key))
    .map(([, value]) => value!);
  return (text) => values.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text);
}
