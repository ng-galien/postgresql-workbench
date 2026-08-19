import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import { escapeRegExp } from "./text.js";

const repositoryRoot = resolve(__dirname, "../../../..");
const demoCompose = resolve(repositoryRoot, "docker", "demo", "compose.yml");

export const demoConnectionUrl = "postgresql://postgres:postgres@localhost:5434/demo";
export const demoConnectionId = "localhost:5434/demo:postgres";
export const demoAssociationText = /postgres@localhost:5434\/demo/u;
export const demoAutomaticAssociationText = /postgres@localhost:5434\/demo.*AUTO/u;
export const demoConnexionQuickPickItem = /^postgres@localhost:5434\/demo(?:\s*Connected)?$/u;
export const demoProductSearchQuickPickItem =
  /^shop\.producttable\ndemo · postgresql:\/\/localhost%3A5434%2Fdemo%3Apostgres\/demo\/shop\/table\/product\.sql$/u;
export const demoConnexionTreeItem = connexionTreeItem("postgres@localhost:5434/demo");
export const demoDatabaseTreeItem = databaseTreeItem("demo");
export const alternateConnectionUrl = "postgresql://postgres:postgres@localhost:5434/postgres";
export const alternateConnexionTreeItem = connexionTreeItem("postgres@localhost:5434/postgres");
export const alternateConnectionId = "localhost:5434/postgres:postgres";
export const loopbackConnectionUrl = "postgresql://postgres:postgres@127.0.0.1:5434/demo";
export const loopbackConnexionTreeItem = connexionTreeItem("postgres@127.0.0.1:5434/demo");
export const loopbackConnectionId = "127.0.0.1:5434/demo:postgres";

function connexionTreeItem(name: string): RegExp {
  return new RegExp(`^${escapeRegExp(name)}(?:\\s*·?\\s*(?:connected|disconnected))?$`, "u");
}

function databaseTreeItem(database: string): RegExp {
  return new RegExp(
    `^${escapeRegExp(database)}(?:\\s*·?\\s*(?:preparing index|indexing|refreshing|ready|degraded|indexing paused|indexing failed))?$`,
    "u",
  );
}

export interface DemoDatabase {
  resetSchemaSyncFixture(): Promise<void>;
  inspectSchemaSync(supportSchema: string): Promise<{
    ddlFunction: boolean;
    ddlTrigger: boolean;
    dropFunction: boolean;
    dropTrigger: boolean;
  }>;
  inspectTable(
    schema: string,
    table: string,
  ): Promise<{
    columns: string[];
    exists: boolean;
  }>;
  inspectRoutine(schema: string, routine: string): Promise<{ exists: boolean }>;
  inspectTrigger(schema: string, table: string, trigger: string): Promise<{ exists: boolean }>;
  stop(): void;
}

export function startDemoDatabase(): DemoDatabase {
  const external = process.env.PGWB_ACCEPTANCE_EXTERNAL_DEMO === "1";
  const running =
    external ||
    compose(["ps", "--status", "running", "--services"], true).split(/\r?\n/).includes("postgres");
  if (!running) {
    try {
      compose(["up", "-d", "--build", "--wait"]);
    } catch (error) {
      stopDemoDatabase(true);
      throw error;
    }
  }
  return {
    async resetSchemaSyncFixture() {
      await withDemoClient(async (client) => {
        await client.query(`
          DROP EVENT TRIGGER IF EXISTS plpgsql_workbench_ddl_command_end;
          DROP EVENT TRIGGER IF EXISTS plpgsql_workbench_sql_drop;
          DROP TABLE IF EXISTS public.ddl_sync_probe CASCADE;
          DROP TABLE IF EXISTS public.ddl_sync_probe_renamed CASCADE;
          DROP FUNCTION IF EXISTS public.ddl_sync_probe_touch() CASCADE;
          DROP FUNCTION IF EXISTS workbench.notify_ddl_command_end() CASCADE;
          DROP FUNCTION IF EXISTS workbench.notify_sql_drop() CASCADE;
        `);
      });
    },
    async inspectSchemaSync(supportSchema) {
      return withDemoClient(async (client) => {
        const result = await client.query({
          text: `
            SELECT
              pg_catalog.to_regprocedure($1) IS NOT NULL AS ddl_function,
              pg_catalog.to_regprocedure($2) IS NOT NULL AS drop_function,
              EXISTS (
                SELECT 1 FROM pg_catalog.pg_event_trigger
                WHERE evtname = 'plpgsql_workbench_ddl_command_end'
              ) AS ddl_trigger,
              EXISTS (
                SELECT 1 FROM pg_catalog.pg_event_trigger
                WHERE evtname = 'plpgsql_workbench_sql_drop'
              ) AS drop_trigger
          `,
          values: [
            `${supportSchema}.notify_ddl_command_end()`,
            `${supportSchema}.notify_sql_drop()`,
          ],
        });
        const row = result.rows[0] as Record<string, boolean>;
        return {
          ddlFunction: row.ddl_function,
          ddlTrigger: row.ddl_trigger,
          dropFunction: row.drop_function,
          dropTrigger: row.drop_trigger,
        };
      });
    },
    async inspectTable(schema, table) {
      return withDemoClient(async (client) => {
        const result = await client.query({
          text: `
            SELECT
              pg_catalog.to_regclass($1) IS NOT NULL AS present,
              COALESCE(
                (
                  SELECT pg_catalog.array_agg(
                    attribute.attname::text ORDER BY attribute.attnum
                  )
                  FROM pg_catalog.pg_attribute AS attribute
                  WHERE attribute.attrelid = pg_catalog.to_regclass($1)
                    AND attribute.attnum > 0
                    AND NOT attribute.attisdropped
                ),
                ARRAY[]::text[]
              ) AS columns
          `,
          values: [`${schema}.${table}`],
        });
        const row = result.rows[0] as { columns: string[]; present: boolean };
        return { columns: row.columns, exists: row.present };
      });
    },
    async inspectRoutine(schema, routine) {
      return withDemoClient(async (client) => {
        const result = await client.query({
          text: `
            SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_proc AS routine
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = routine.pronamespace
              WHERE namespace.nspname = $1
                AND routine.proname = $2
            ) AS present
          `,
          values: [schema, routine],
        });
        return { exists: result.rows[0]?.present === true };
      });
    },
    async inspectTrigger(schema, table, trigger) {
      return withDemoClient(async (client) => {
        const result = await client.query({
          text: `
            SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_trigger AS trigger
              JOIN pg_catalog.pg_class AS relation
                ON relation.oid = trigger.tgrelid
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = $1
                AND relation.relname = $2
                AND trigger.tgname = $3
                AND NOT trigger.tgisinternal
            ) AS present
          `,
          values: [schema, table, trigger],
        });
        return { exists: result.rows[0]?.present === true };
      });
    },
    stop() {
      if (!running) stopDemoDatabase(false);
    },
  };
}

async function withDemoClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: demoConnectionUrl });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function stopDemoDatabase(bestEffort: boolean): void {
  if (process.env.PGWB_ACCEPTANCE_KEEP_DEMO === "1") return;
  try {
    compose(["down", "-v"]);
  } catch (error) {
    if (!bestEffort) throw error;
  }
}

function compose(args: string[], capture = false): string {
  return execFileSync("docker", ["compose", "-f", demoCompose, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
}
