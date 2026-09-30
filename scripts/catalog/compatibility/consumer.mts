import { realpathSync } from "node:fs";
import process from "node:process";
import type { CodeMonikerClient } from "@code-moniker/client";
import { NodeDaemonRuntime } from "@code-moniker/client/node";
import {
  comparePostgresStructures,
  createCodeMonikerSyntaxParser,
  type SyntaxParser,
} from "@ng-galien/postgresql-catalog";

// No casts, copied vendor DTOs, skipLibCheck or error suppression: the package's
// public declarations must accept the actual published client's return types.
function parserFor(client: CodeMonikerClient): SyntaxParser {
  return createCodeMonikerSyntaxParser(client);
}

const workspace = realpathSync(process.argv[2]);
const runtime = new NodeDaemonRuntime({ registryDirectory: `${workspace}-registry` });
const daemon = await runtime.launch({ workspaceRoots: [workspace] });
let client: CodeMonikerClient | undefined;
try {
  client = await runtime.connect(daemon.entry, { expectedWorkspaceRoots: [workspace] });
  const parser = parserFor(client);
  const tree = await parser.parse({ language: "sql", source: "SELECT 1;" });
  if (tree.hasError || tree.focusLineRange !== null || tree.root.text !== null) {
    throw new Error("Unexpected parsed syntax metadata");
  }
  const base = `CREATE TABLE public.probe (id bigint PRIMARY KEY, note text NULL);
ALTER TABLE public.probe ADD COLUMN value text;
COMMENT ON COLUMN public.probe.value IS '@hall renamed-from old_value';
CREATE INDEX probe_value_idx ON public.probe (value);`;
  const head = `CREATE TABLE public.probe (id bigint NOT NULL, note text, value text,
CONSTRAINT probe_pkey PRIMARY KEY (id));
COMMENT ON COLUMN public.probe.value IS '@hall renamed-from old_value';
CREATE INDEX probe_value_idx ON public.probe USING btree (value);`;
  const documents = (content: string) => [
    { uri: "memory://probe.sql", language: "sql" as const, content },
  ];
  for (const [label, target, expected] of [
    ["Hall materialization", head, true],
    ["real nullability change", head.replace("note text,", "note text NOT NULL,"), false],
  ] as const) {
    const result = await comparePostgresStructures(
      client,
      documents(base),
      documents(target),
      label,
      "structure",
      parser,
    );
    if (result.isomorphic !== expected || result.diagnostics.length !== 0) {
      throw new Error(`${label}: ${JSON.stringify(result)}`);
    }
  }
  process.stdout.write(
    "Published Code Moniker 0.13.0: strict public types, real parser and Hall comparison passed.\n",
  );
} finally {
  client?.close();
  await runtime.stopOwned(daemon);
}
