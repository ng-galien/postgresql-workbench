import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE_FILE = join(ROOT, "benchmarks/workbench-index/compose.yml");
const DATABASE = "pgwb_index_benchmark";
const SERVER_ID = "workbench-index-benchmark";

export const BENCHMARK_PROFILES = Object.freeze({
  "erp-medium": Object.freeze({
    schemas: 20,
    tables: 1_000,
    views: 500,
    functions: 500,
    procedures: 250,
    triggers: 250,
    columns: 12,
  }),
  "erp-large": Object.freeze({
    schemas: 50,
    tables: 3_000,
    views: 1_500,
    functions: 1_500,
    procedures: 1_000,
    triggers: 500,
    columns: 12,
  }),
});

export function parseBenchmarkOptions(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (["skip-build", "keep-database"].includes(rawName)) {
      flags.add(rawName);
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}`);
    }
    values.set(rawName, value);
  }

  const profileName = values.get("profile") ?? "erp-medium";
  const profile = BENCHMARK_PROFILES[profileName];
  if (!profile) {
    throw new Error(
      `Unknown profile ${profileName}; expected ${Object.keys(BENCHMARK_PROFILES).join(" or ")}`,
    );
  }
  return {
    profileName,
    profile: {
      ...profile,
      ...Object.fromEntries(
        ["schemas", "tables", "views", "functions", "procedures", "triggers", "columns"]
          .filter((name) => values.has(name))
          .map((name) => [
            name,
            name === "columns"
              ? integerAtLeast(values.get(name), name, 8)
              : positiveInteger(values.get(name), name),
          ]),
      ),
    },
    port: positiveInteger(process.env.PGWB_BENCH_PORT ?? "55433", "PGWB_BENCH_PORT"),
    timeoutMs: positiveInteger(values.get("timeout-ms") ?? "600000", "timeout-ms"),
    skipBuild: flags.has("skip-build"),
    keepDatabase: flags.has("keep-database"),
  };
}

export function expectedGeneratedCounts(profile) {
  return {
    schemas: profile.schemas,
    tables: profile.tables,
    views: profile.views,
    functions: profile.functions + profile.triggers,
    procedures: profile.procedures,
    triggers: profile.triggers,
    tableColumns: profile.tables * profile.columns,
  };
}

async function main() {
  const options = parseBenchmarkOptions(process.argv.slice(2));
  const composeEnvironment = {
    ...process.env,
    PGWB_BENCH_PORT: String(options.port),
    COMPOSE_PROJECT_NAME: "postgresql-workbench-index-benchmark",
  };
  try {
    await command("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build", "--wait"], {
      env: composeEnvironment,
    });
    if (!options.skipBuild) {
      await command("npm", ["run", "build:dap"]);
      await command("npm", ["--prefix", "vscode-extension", "run", "stage:code-moniker"]);
    }
    const report = await benchmark(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (!options.keepDatabase) {
      await command("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"], {
        env: composeEnvironment,
      }).catch((error) => {
        process.stderr.write(`benchmark cleanup failed: ${error.message}\n`);
      });
    }
  }
}

async function benchmark(options) {
  const [{ readPostgresCatalog }, { ensureLocalCodeMonikerWorkspace }] = await Promise.all([
    import("../dist/workbench/postgresCatalog.js"),
    import("../dist/workbench/localCodeMoniker.js"),
  ]);
  const adminConfig = {
    host: "127.0.0.1",
    port: options.port,
    database: "postgres",
    user: "postgres",
    password: "postgres",
  };
  const admin = new Client(adminConfig);
  let postgres;
  let session;
  let workspaceRoot;
  let publishedSourceSet;
  try {
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    postgres = new Client({ ...adminConfig, database: DATABASE });
    await postgres.connect();

    const ddlStarted = performance.now();
    await createSyntheticSchema(postgres, options.profile);
    const ddlMs = performance.now() - ddlStarted;
    const catalogCounts = await readCatalogCounts(postgres);

    const indexingStarted = performance.now();
    const catalog = await readPostgresCatalog(catalogClient(postgres), {
      serverId: SERVER_ID,
      database: DATABASE,
    });
    workspaceRoot = await mkdtemp(join(tmpdir(), "pgwb-index-benchmark-"));
    const daemonStarted = performance.now();
    session = await ensureLocalCodeMonikerWorkspace({
      runtimePath: resolve(ROOT, "vscode-extension/runtime/code-moniker"),
      workspaceRoots: [workspaceRoot],
      clientName: `postgresql-workbench-index-benchmark-${process.pid}`,
      timeoutMs: options.timeoutMs,
    });
    await waitForWorkspaceReady(session, options.timeoutMs);
    const daemonReadyMs = performance.now() - daemonStarted;

    const publicationStarted = performance.now();
    const initialPublication = await session.client.sources.replace(catalog.sourceSet);
    publishedSourceSet = catalog.sourceSet.srcset;
    const initialReadyStatus = await waitForWorkspaceReady(session, options.timeoutMs);
    const initialStatus = initialPublication.status ?? initialReadyStatus;
    const publicationMs = performance.now() - publicationStarted;
    const initialIndexingMs = performance.now() - indexingStarted;

    const unchangedPublicationStarted = performance.now();
    const unchangedPublication = await session.client.sources.replace(catalog.sourceSet);
    const unchangedStatus = await waitForWorkspaceReady(session, options.timeoutMs);
    const unchangedPublicationMs = performance.now() - unchangedPublicationStarted;

    const changedDocument = catalog.sourceSet.documents.at(-1);
    if (!changedDocument) throw new Error("The generated PostgreSQL SourceSet is empty");
    const incrementedSourceSet = {
      ...catalog.sourceSet,
      revision: `${catalog.sourceSet.revision ?? "benchmark"}-single-document-change`,
      documents: catalog.sourceSet.documents.map((document) =>
        document === changedDocument
          ? { ...document, content: `${document.content}\n-- benchmark incremental mutation` }
          : document,
      ),
    };
    const singleDocumentPublicationStarted = performance.now();
    const singleDocumentPublication = await session.client.sources.replace(incrementedSourceSet);
    const singleDocumentReadyStatus = await waitForWorkspaceReady(session, options.timeoutMs);
    const singleDocumentStatus = singleDocumentPublication.status ?? singleDocumentReadyStatus;
    const singleDocumentPublicationMs = performance.now() - singleDocumentPublicationStarted;

    const symbolScanStarted = performance.now();
    const indexed = await readDatabaseSymbols(session, SERVER_ID, DATABASE);
    const symbolScanMs = performance.now() - symbolScanStarted;
    const sampleView = indexed.rows.find((symbol) => symbol.kind === "view");
    const graphStarted = performance.now();
    const graph = sampleView
      ? await session.client.graph.symbol(
          sampleView.uri,
          { relation: ["reads"] },
          { consistency: "stale_ok" },
        )
      : undefined;
    const graphQueryMs = performance.now() - graphStarted;
    const scenarioMs = performance.now() - indexingStarted;
    const memory = process.memoryUsage();
    const memorySourceSetContract = validateMemorySourceSetContract({
      documentCount: catalog.metrics.documentCount,
      initialStatus,
      unchangedStatus,
      singleDocumentStatus,
      initialPublication,
      unchangedPublication,
      singleDocumentPublication,
    });
    if ((graph?.callees.length ?? 0) !== 1) {
      throw new Error("The sample SQL view no longer has its expected outgoing reads relation");
    }

    return {
      profile: options.profileName,
      requested: options.profile,
      expected: expectedGeneratedCounts(options.profile),
      catalog: catalogCounts,
      documents: catalog.metrics.documentCount,
      symbols: indexed.rows.length,
      generation: indexed.generation,
      codeMonikerPhasesMs: {
        initial: initialStatus.timings ?? null,
        // Protocol 17 retains the previous operation timings after a no-op.
        unchanged: null,
        singleDocumentChange: singleDocumentStatus.timings ?? null,
      },
      codeMonikerGenerations: {
        initial: generationValue(initialStatus.generation),
        unchanged: generationValue(unchangedStatus.generation),
        singleDocumentChange: generationValue(singleDocumentStatus.generation),
      },
      codeMonikerPublications: {
        initial: {
          message: initialPublication.message,
          generation: generationValue(initialPublication.generation),
        },
        unchanged: {
          message: unchangedPublication.message,
          generation: generationValue(unchangedPublication.generation),
        },
        singleDocumentChange: {
          message: singleDocumentPublication.message,
          generation: generationValue(singleDocumentPublication.generation),
        },
      },
      sampleGraph: {
        view: sampleView?.name ?? null,
        outgoingReads: graph?.callees.length ?? 0,
      },
      contracts: {
        memorySourceSet: memorySourceSetContract,
        sampleGraph: "passed",
      },
      timingsMs: rounded({
        ddl: ddlMs,
        introspection: catalog.metrics.introspectionMs,
        materialization: catalog.metrics.materializationMs,
        daemonReady: daemonReadyMs,
        publication: publicationMs,
        unchangedPublication: unchangedPublicationMs,
        singleDocumentPublication: singleDocumentPublicationMs,
        symbolScan: symbolScanMs,
        graphQuery: graphQueryMs,
        indexing: initialIndexingMs,
        scenarioTotal: scenarioMs,
      }),
      throughputPerSecond: rounded({
        documents: catalog.metrics.documentCount / (initialIndexingMs / 1_000),
        symbols: indexed.rows.length / (initialIndexingMs / 1_000),
        publicationDocuments: catalog.metrics.documentCount / (publicationMs / 1_000),
      }),
      runnerMemoryMiB: rounded({
        rss: memory.rss / 1024 / 1024,
        heapUsed: memory.heapUsed / 1024 / 1024,
        external: memory.external / 1024 / 1024,
      }),
      environment: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        cpuCount: cpus().length,
        totalMemoryGiB: Number((totalmem() / 1024 / 1024 / 1024).toFixed(1)),
        node: process.version,
        codeMoniker: session.metadata.packageVersion,
      },
    };
  } finally {
    if (session) {
      if (publishedSourceSet) {
        await session.client.sources.remove(publishedSourceSet).catch(() => undefined);
      }
      await session.dispose().catch(() => undefined);
    }
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    if (postgres) await postgres.end().catch(() => undefined);
    if (!options.keepDatabase) {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
}

async function createSyntheticSchema(client, profile) {
  for (let index = 0; index < profile.schemas; index += 1) {
    await client.query(`CREATE SCHEMA ${schemaName(index)}`);
  }

  const tableStatements = [];
  for (let index = 0; index < profile.tables; index += 1) {
    const schema = schemaName(index % profile.schemas);
    const columns = [
      "id bigint PRIMARY KEY",
      "tenant_id bigint NOT NULL",
      "code text NOT NULL",
      "state text NOT NULL DEFAULT 'active'",
      "amount numeric(18,2) NOT NULL DEFAULT 0",
      "effective_at timestamptz NOT NULL DEFAULT now()",
      "metadata jsonb NOT NULL DEFAULT '{}'::jsonb",
    ];
    if (index > 0) {
      const parent = index - 1;
      columns.push(
        `parent_id bigint REFERENCES ${schemaName(parent % profile.schemas)}.${tableName(parent)}(id)`,
      );
    }
    while (columns.length < profile.columns) columns.push(`attribute_${columns.length} text`);
    tableStatements.push(`CREATE TABLE ${schema}.${tableName(index)} (${columns.join(", ")})`);
  }
  await executeBatches(client, tableStatements);

  const viewStatements = [];
  for (let index = 0; index < profile.views; index += 1) {
    const table = index % profile.tables;
    const schema = schemaName(table % profile.schemas);
    const relation = `${schema}.${tableName(table)}`;
    const from =
      table === 0
        ? `${relation} current_entity`
        : `${relation} current_entity LEFT JOIN ${schemaName((table - 1) % profile.schemas)}.${tableName(table - 1)} parent_entity ON parent_entity.id = current_entity.parent_id`;
    viewStatements.push(
      `CREATE VIEW ${schema}.${viewName(index)} AS SELECT current_entity.id, current_entity.code, current_entity.state, current_entity.amount, current_entity.metadata FROM ${from}`,
    );
  }
  await executeBatches(client, viewStatements);

  const functionStatements = [];
  for (let index = 0; index < profile.functions; index += 1) {
    const table = index % profile.tables;
    const schema = schemaName(table % profile.schemas);
    functionStatements.push(`CREATE FUNCTION ${schema}.${functionName(index)}(p_id bigint)
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_build_object('id', entity.id, 'code', entity.code, 'state', entity.state, 'metadata', entity.metadata)
  INTO result FROM ${schema}.${tableName(table)} entity WHERE entity.id = p_id;
  RETURN result;
END
$function$`);
  }
  await executeBatches(client, functionStatements);

  const procedureStatements = [];
  for (let index = 0; index < profile.procedures; index += 1) {
    const table = index % profile.tables;
    const schema = schemaName(table % profile.schemas);
    procedureStatements.push(`CREATE PROCEDURE ${schema}.${procedureName(index)}(p_id bigint, p_state text)
LANGUAGE plpgsql AS $procedure$
BEGIN
  UPDATE ${schema}.${tableName(table)} SET state = p_state WHERE id = p_id;
END
$procedure$`);
  }
  await executeBatches(client, procedureStatements);

  const triggerStatements = [];
  for (let index = 0; index < profile.triggers; index += 1) {
    const table = index % profile.tables;
    const schema = schemaName(table % profile.schemas);
    triggerStatements.push(`CREATE FUNCTION ${schema}.${triggerFunctionName(index)}()
RETURNS trigger LANGUAGE plpgsql AS $trigger_function$
BEGIN
  NEW.effective_at := now();
  RETURN NEW;
END
$trigger_function$`);
    triggerStatements.push(
      `CREATE TRIGGER ${triggerName(index)} BEFORE UPDATE ON ${schema}.${tableName(table)} FOR EACH ROW EXECUTE FUNCTION ${schema}.${triggerFunctionName(index)}()`,
    );
  }
  await executeBatches(client, triggerStatements);
}

async function executeBatches(client, statements, size = 100) {
  for (let offset = 0; offset < statements.length; offset += size) {
    await client.query(`${statements.slice(offset, offset + size).join(";\n")};`);
  }
}

async function readCatalogCounts(client) {
  const { rows } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'erp\\_%' ESCAPE '\\') AS schemas,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'erp\\_%' ESCAPE '\\' AND c.relkind IN ('r', 'p')) AS tables,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'erp\\_%' ESCAPE '\\' AND c.relkind IN ('v', 'm')) AS views,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname LIKE 'erp\\_%' ESCAPE '\\' AND p.prokind = 'f') AS functions,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname LIKE 'erp\\_%' ESCAPE '\\' AND p.prokind = 'p') AS procedures,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'erp\\_%' ESCAPE '\\' AND NOT t.tgisinternal) AS triggers,
      (SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'erp\\_%' ESCAPE '\\' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped) AS table_columns
  `);
  return rows[0];
}

async function readDatabaseSymbols(session, serverId, database) {
  const rows = [];
  let generation = null;
  let cursor = null;
  do {
    const page = await session.client.symbols.search(
      {
        language: ["sql"],
        kind: [
          "schema",
          "table",
          "column",
          "constraint",
          "view",
          "function",
          "procedure",
          "trigger",
        ],
        path: [`postgresql://${encodeURIComponent(serverId)}/${encodeURIComponent(database)}/**`],
        includeCode: true,
        contextLines: 16,
      },
      { consistency: "stale_ok", limit: 500, cursor },
    );
    rows.push(...page.data.rows);
    generation = generationValue(page.generation) ?? generation;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { rows, generation };
}

async function waitForWorkspaceReady(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await session.client.workspace.status();
    if (status.phase === "ready") return status;
    if (status.phase === "failed") {
      throw new Error(status.failure?.message ?? "Code Moniker indexing failed");
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 100));
  }
  throw new Error(`Code Moniker did not become ready within ${timeoutMs}ms`);
}

function catalogClient(client) {
  return {
    async query(sql) {
      const result = await client.query(sql);
      return { rows: result.rows };
    },
  };
}

function generationValue(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.value === "number") return value.value;
  return null;
}

export function validateMemorySourceSetContract({
  documentCount,
  initialStatus,
  unchangedStatus,
  singleDocumentStatus,
  initialPublication,
  unchangedPublication,
  singleDocumentPublication,
}) {
  const initial = initialStatus.timings?.memory_source_refresh;
  const single = singleDocumentStatus.timings?.memory_source_refresh;
  if (!initial || !single) {
    return "unavailable: Code Moniker does not expose memory SourceSet refresh telemetry";
  }
  const expectations = [
    [initial.mode === "bulk", "initial publication mode is bulk"],
    [initial.documents_total === documentCount, "initial document total matches the catalog"],
    [initial.added === documentCount, "initial publication adds every document"],
    [initial.extraction_jobs === documentCount, "initial publication extracts every document once"],
    [initial.extraction_workers > 1, "initial publication uses multiple extraction workers"],
    [initial.linkage_invocations === 1, "initial publication runs linkage once"],
    [single.mode === "incremental", "single-document publication mode is incremental"],
    [single.documents_total === documentCount, "incremental document total matches the catalog"],
    [single.modified === 1, "incremental publication modifies exactly one document"],
    [single.unchanged === documentCount - 1, "every other document remains unchanged"],
    [single.extraction_jobs === 1, "incremental publication extracts exactly one document"],
    [single.linkage_invocations === 1, "incremental publication runs linkage once"],
    [
      generationValue(initialPublication.generation) ===
        generationValue(unchangedPublication.generation),
      "identical publication preserves the generation",
    ],
    [
      unchangedPublication.message.endsWith(": unchanged"),
      "identical publication is reported as unchanged",
    ],
    [
      generationValue(singleDocumentPublication.generation) ===
        generationValue(initialPublication.generation) + 1,
      "single-document publication advances the generation once",
    ],
    [
      generationValue(unchangedStatus.generation) === generationValue(initialStatus.generation),
      "ready status preserves the no-op generation",
    ],
  ];
  const failed = expectations.find(([accepted]) => !accepted);
  if (failed) throw new Error(`Memory SourceSet contract failed: ${failed[1]}`);
  return "passed";
}

function rounded(values) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, Number(value.toFixed(1))]),
  );
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function integerAtLeast(value, name, minimum) {
  const parsed = positiveInteger(value, name);
  if (parsed < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return parsed;
}

function schemaName(index) {
  return `erp_${String(index).padStart(3, "0")}`;
}

function tableName(index) {
  return `entity_${String(index).padStart(5, "0")}`;
}

function viewName(index) {
  return `report_${String(index).padStart(5, "0")}`;
}

function functionName(index) {
  return `lookup_${String(index).padStart(5, "0")}`;
}

function procedureName(index) {
  return `transition_${String(index).padStart(5, "0")}`;
}

function triggerFunctionName(index) {
  return `touch_${String(index).padStart(5, "0")}`;
}

function triggerName(index) {
  return `touch_${String(index).padStart(5, "0")}`;
}

function command(executable, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCommand();
      else rejectCommand(new Error(`${executable} exited with ${code ?? signal}`));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
