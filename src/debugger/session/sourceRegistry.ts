export function clientSourceUris(
  sourceUris: Record<string, string> | undefined,
): Map<number, string> {
  if (!sourceUris) return new Map();
  const result = new Map<number, string>();
  const identities = new Set<string>();
  for (const [rawOid, documentUri] of Object.entries(sourceUris)) {
    const oid = Number(rawOid);
    if (!Number.isInteger(oid) || oid <= 0) {
      throw new Error(`Invalid PostgreSQL routine OID in client source registry: ${rawOid}`);
    }
    if (!absoluteUri(documentUri)) {
      throw new Error(`Invalid absolute client source URI for routine OID ${oid}`);
    }
    if (identities.has(documentUri)) {
      throw new Error(`Client source URI is mapped to more than one routine: ${documentUri}`);
    }
    result.set(oid, documentUri);
    identities.add(documentUri);
  }
  return result;
}

function absoluteUri(documentUri: string): boolean {
  try {
    return new URL(documentUri).protocol.length > 1;
  } catch {
    return false;
  }
}
