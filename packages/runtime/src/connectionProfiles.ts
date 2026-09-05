import { Client } from "pg";
import {
  type PostgresClientIdentity,
  postgresClientConfig,
} from "../../catalog/src/postgresClientConfig.js";
import type { ConnectionProfile } from "./sessions.js";

export interface RuntimeConnectionConfiguration {
  id: string;
  label: string;
  identity: PostgresClientIdentity;
}

/** Hosts supply identities and secrets without sharing an editor's active database session. */
export function configuredProfiles(
  configurations: readonly RuntimeConnectionConfiguration[],
): ConnectionProfile[] {
  return configurations.map(({ id, label, identity }) => ({
    id,
    label,
    async open() {
      const client = new Client(
        postgresClientConfig({
          ...identity,
          applicationName: "postgresql-workbench-mcp",
        }),
      );
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
