export function canonicalSqlIdentifier(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"')
    ? unquoteSqlIdentifier(identifier)
    : identifier.toLocaleLowerCase();
}

export function splitSqlQualifiedIdentifier(identifier: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < identifier.length; index += 1) {
    if (identifier[index] === '"') {
      if (quoted && identifier[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (identifier[index] === "." && !quoted) {
      parts.push(identifier.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(identifier.slice(start));
  return parts;
}

export function unquoteSqlIdentifier(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;
}

export function unquoteSqlIdentifierFragment(identifier: string): string {
  if (!identifier.startsWith('"')) return identifier;
  const end = identifier.endsWith('"') ? -1 : undefined;
  return identifier.slice(1, end).replaceAll('""', '"');
}
