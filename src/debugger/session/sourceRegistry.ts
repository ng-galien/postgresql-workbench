export function canonicalSourceUris(
  sourceUris: Record<string, string> | undefined,
): Map<number, string> {
  if (!sourceUris) {
    throw new Error("The launch request is missing the canonical Code Moniker source registry");
  }
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
