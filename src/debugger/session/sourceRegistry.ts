export function canonicalSourceUris(
  sourceUris: Record<string, string> | undefined,
): Map<number, string> {
  if (!sourceUris) return new Map();
  const result = new Map<number, string>();
  const identities = new Set<string>();
  for (const [rawOid, documentUri] of Object.entries(sourceUris)) {
    const oid = Number(rawOid);
    if (!Number.isInteger(oid) || oid <= 0) {
      throw new Error(`Invalid PostgreSQL routine OID in Code Moniker source registry: ${rawOid}`);
    }
    const identity = canonicalIdentity(documentUri);
    if (!identity) {
      throw new Error(`Invalid canonical Code Moniker source URI for routine OID ${oid}`);
    }
    if (identities.has(identity)) {
      throw new Error(`Code Moniker source URI is mapped to more than one routine: ${identity}`);
    }
    result.set(oid, documentUri);
    identities.add(identity);
  }
  return result;
}

export function standaloneSourceUri(oid: number): string {
  if (!Number.isInteger(oid) || oid <= 0) {
    throw new Error(`Invalid PostgreSQL routine OID: ${oid}`);
  }
  return `postgresql-dap://routine/${oid}`;
}

export function standaloneSourceOid(documentUri: string): number | undefined {
  try {
    const parsed = new URL(documentUri);
    if (parsed.protocol !== "postgresql-dap:" || parsed.hostname !== "routine") return undefined;
    const oid = Number(parsed.pathname.slice(1));
    return Number.isInteger(oid) && oid > 0 ? oid : undefined;
  } catch {
    return undefined;
  }
}

function canonicalIdentity(documentUri: string): string | undefined {
  if (!documentUri.startsWith("code+moniker://")) return undefined;
  const parsed = new URL(documentUri);
  if (parsed.hostname !== "postgresql") return documentUri;
  try {
    const projection = JSON.parse(decodeURIComponent(parsed.search.slice(1))) as {
      identity?: unknown;
    };
    return typeof projection.identity === "string" &&
      projection.identity.startsWith("code+moniker://")
      ? projection.identity
      : undefined;
  } catch {
    return undefined;
  }
}
