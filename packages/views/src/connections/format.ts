/** The human forms the Connections page shows numbers in: sizes, durations, versions. */

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${SIZE_UNITS[unit]}`;
}

/** How long ago an instant was, in the largest unit that stays honest: `3 d 4 h`, `12 min`, `8 s`. */
export function formatSince(iso: string, now: Date = new Date()): string {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "—";
  const seconds = Math.max(0, Math.floor((now.getTime() - started) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/** The headline of a `version()` answer: `PostgreSQL 17.5`, whatever the build suffix says. */
export function postgresVersionHeadline(version: string): string {
  const match = version.match(/^PostgreSQL \S+/u);
  return match ? match[0] : version;
}
