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

export interface StandaloneSourceContext {
  host: string;
  port: number;
  database: string;
  user: string;
  sessionId: string;
}

export interface StandaloneSourceIdentity {
  context: StandaloneSourceContext;
  oid: number;
  sourceName: string;
}

export function standaloneSourceUri(
  oid: number,
  context: StandaloneSourceContext,
  sourceName: string,
): string {
  if (!Number.isInteger(oid) || oid <= 0) {
    throw new Error(`Invalid PostgreSQL routine OID: ${oid}`);
  }
  if (!sourceName.trim()) throw new Error("PostgreSQL routine source name is required");
  const path = [context.host, String(context.port), context.database, context.user]
    .map(encodeURIComponent)
    .join("/");
  return `postgresql-dap://postgresql/${path}/session/${encodeURIComponent(context.sessionId)}/routine/${oid}/${encodeURIComponent(sourceName)}`;
}

export function standaloneSourceIdentity(
  documentUri: string,
): StandaloneSourceIdentity | undefined {
  try {
    const parsed = new URL(documentUri);
    const match =
      /^\/([^/]+)\/(\d+)\/([^/]+)\/([^/]+)\/session\/([^/]+)\/routine\/(\d+)\/([^/]+)$/.exec(
        parsed.pathname,
      );
    if (
      parsed.protocol !== "postgresql-dap:" ||
      parsed.hostname !== "postgresql" ||
      parsed.search ||
      parsed.hash ||
      !match
    ) {
      return undefined;
    }
    const port = Number(match[2]);
    const oid = Number(match[6]);
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(oid) || oid <= 0) {
      return undefined;
    }
    return {
      context: {
        host: decodeURIComponent(match[1]),
        port,
        database: decodeURIComponent(match[3]),
        user: decodeURIComponent(match[4]),
        sessionId: decodeURIComponent(match[5]),
      },
      oid,
      sourceName: decodeURIComponent(match[7]),
    };
  } catch {
    return undefined;
  }
}

export function standaloneSourceOid(
  documentUri: string,
  expectedContext?: StandaloneSourceContext,
): number | undefined {
  const identity = standaloneSourceIdentity(documentUri);
  if (!identity) return undefined;
  if (
    expectedContext &&
    (identity.context.host !== expectedContext.host ||
      identity.context.port !== expectedContext.port ||
      identity.context.database !== expectedContext.database ||
      identity.context.user !== expectedContext.user ||
      identity.context.sessionId !== expectedContext.sessionId)
  ) {
    return undefined;
  }
  return identity.oid;
}

function absoluteUri(documentUri: string): boolean {
  try {
    return new URL(documentUri).protocol.length > 1;
  } catch {
    return false;
  }
}
