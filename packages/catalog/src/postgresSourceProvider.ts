import type { CodeMonikerClient, CodeMonikerSymbol } from "./localCodeMoniker.js";
import {
  PostgresCatalogFullRefreshRequired,
  type PostgresCatalogResourceSelector,
  type VirtualSqlDocument,
} from "./postgresCatalog.js";
import type { PostgresDdlObject } from "./postgresDdlSync.js";

export interface IndexedPostgresResource {
  resourceKey: string;
  documentUri: string;
  symbolUri: string;
}

export interface PostgresSourceProviderState {
  documents: ReadonlyMap<string, VirtualSqlDocument>;
  resources: ReadonlyMap<string, IndexedPostgresResource>;
}

export interface DirectPostgresResourceSelection {
  documentUris: Set<string>;
  newResources: PostgresCatalogResourceSelector[];
}

export async function directPostgresDocumentUris(
  client: CodeMonikerClient,
  state: PostgresSourceProviderState,
  objects: readonly PostgresDdlObject[],
): Promise<DirectPostgresResourceSelection> {
  const { changed, newResources } = changedPostgresResources(state, objects);
  const documentUris = new Set([...changed.values()].map((resource) => resource.documentUri));
  for (const resource of changed.values()) {
    let cursor: unknown | null = null;
    do {
      const page = await client.symbols.usages(
        resource.symbolUri,
        { direction: "incoming" },
        { consistency: "stale_ok", limit: 500, cursor },
      );
      for (const usage of page.data.rows) {
        if (state.documents.has(usage.file)) documentUris.add(usage.file);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  return { documentUris, newResources };
}

export function buildPostgresResourceIndex(
  documents: ReadonlyMap<string, VirtualSqlDocument>,
  symbols: readonly CodeMonikerSymbol[],
): Map<string, IndexedPostgresResource> {
  const resources = new Map<string, IndexedPostgresResource>();
  for (const document of documents.values()) {
    const postgres = document.postgres;
    if (!postgres) continue;
    const expectedKinds =
      postgres.documentKind === "routine"
        ? new Set(["function", "procedure"])
        : new Set([postgres.documentKind]);
    const candidates = symbols.filter(
      (symbol) => symbol.file === document.uri && expectedKinds.has(symbol.kind),
    );
    const symbol =
      candidates.find((candidate) => candidate.name === postgres.name) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!symbol) continue;
    const resourceKey = postgresResourceKey(postgres.documentKind, postgres.oid);
    resources.set(resourceKey, {
      resourceKey,
      documentUri: document.uri,
      symbolUri: symbol.uri,
    });
  }
  return resources;
}

function changedPostgresResources(
  state: PostgresSourceProviderState,
  objects: readonly PostgresDdlObject[],
): {
  changed: Map<string, IndexedPostgresResource>;
  newResources: PostgresCatalogResourceSelector[];
} {
  const changed = new Map<string, IndexedPostgresResource>();
  const newResources = new Map<string, PostgresCatalogResourceSelector>();
  let hasDroppedConstraint = false;
  for (const object of objects) {
    if (object.inExtension) {
      throw new PostgresCatalogFullRefreshRequired(
        "extension DDL has workspace-wide ownership impact",
      );
    }
    const resourceKind = object.resourceKind ?? projectedResourceKind(object.objectType);
    if (resourceKind === "ignored") continue;
    if (resourceKind === "unmapped") {
      throw new PostgresCatalogFullRefreshRequired(
        `DDL object has no projected PostgreSQL resource: ${object.objectType}`,
      );
    }
    if (resourceKind === "constraint") {
      if (object.original !== undefined) {
        hasDroppedConstraint = true;
        continue;
      }
      newResources.set(`${resourceKind}:${object.objectId}`, {
        kind: resourceKind,
        oid: object.objectId,
      });
      continue;
    }
    const resource = previousResource(state, resourceKind, object.objectId);
    if (!resource) {
      if (object.original !== undefined) {
        throw new PostgresCatalogFullRefreshRequired(
          `dropped PostgreSQL resource has no previous Code Moniker symbol: ${resourceKind}:${object.objectId}`,
        );
      }
      newResources.set(`${resourceKind}:${object.objectId}`, {
        kind: resourceKind,
        oid: object.objectId,
      });
      continue;
    }
    changed.set(resource.resourceKey, resource);
  }
  if (hasDroppedConstraint && !hasChangedRelation(state, changed)) {
    throw new PostgresCatalogFullRefreshRequired(
      "a dropped PostgreSQL constraint did not identify its owning relation",
    );
  }
  if (changed.size === 0 && newResources.size === 0) {
    throw new PostgresCatalogFullRefreshRequired(
      "DDL notification did not identify a projected PostgreSQL resource",
    );
  }
  return { changed, newResources: [...newResources.values()] };
}

function hasChangedRelation(
  state: PostgresSourceProviderState,
  changed: ReadonlyMap<string, IndexedPostgresResource>,
): boolean {
  for (const resource of changed.values()) {
    const kind = state.documents.get(resource.documentUri)?.postgres?.documentKind;
    if (kind === "table" || kind === "view") return true;
  }
  return false;
}

function previousResource(
  state: PostgresSourceProviderState,
  resourceKind: PostgresCatalogResourceSelector["kind"],
  oid: number,
): IndexedPostgresResource | undefined {
  if (resourceKind === "relation") {
    return (
      state.resources.get(postgresResourceKey("table", oid)) ??
      state.resources.get(postgresResourceKey("view", oid))
    );
  }
  if (resourceKind === "constraint") return undefined;
  return state.resources.get(postgresResourceKey(resourceKind, oid));
}

function postgresResourceKey(
  documentKind: NonNullable<VirtualSqlDocument["postgres"]>["documentKind"],
  oid: number,
): string {
  return `${documentKind}:${oid}`;
}

function projectedResourceKind(
  objectType: string,
): PostgresCatalogResourceSelector["kind"] | "ignored" | "unmapped" {
  const type = objectType.toLowerCase();
  if (type === "table" || type === "partitioned table" || type === "foreign table") {
    return "relation";
  }
  if (type === "view") return "relation";
  if (type.includes("column")) return "relation";
  if (type === "function" || type === "procedure" || type === "routine") return "routine";
  if (type === "trigger") return "trigger";
  if (type === "schema") return "schema";
  if (type.includes("constraint")) return "constraint";
  if (
    type === "index" ||
    type === "type" ||
    type === "sequence" ||
    type === "toast table" ||
    type === "policy" ||
    type === "rule" ||
    type === "comment" ||
    type === "default value"
  ) {
    return "ignored";
  }
  return "unmapped";
}
