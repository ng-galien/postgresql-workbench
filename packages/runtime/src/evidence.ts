import { randomUUID } from "node:crypto";

export interface Observation {
  id: string;
  sessionId: string;
  kind: "execution" | "catalog" | "coverage" | "debug";
  capturedAt: string;
  data: unknown;
}

/** Immutable process-local evidence; capacity is explicit and never silently evicts a result. */
export class EvidenceStore {
  private readonly entries = new Map<string, { json: string; bytes: number }>();
  private bytes = 0;
  private reservedBytes = 0;

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  capture(sessionId: string, kind: Observation["kind"], data: unknown): Observation {
    const observation: Observation = {
      id: randomUUID(),
      sessionId,
      kind,
      capturedAt: new Date().toISOString(),
      data,
    };
    const json = JSON.stringify(observation);
    const bytes = Buffer.byteLength(json);
    if (this.bytes + this.reservedBytes + bytes > this.maxBytes) {
      throw new Error("Evidence capacity reached; forget retained observations before continuing.");
    }
    this.entries.set(observation.id, { json, bytes });
    this.bytes += bytes;
    return JSON.parse(json) as Observation;
  }

  reserve(bytes: number) {
    if (this.bytes + this.reservedBytes + bytes > this.maxBytes) {
      throw new Error("Evidence capacity reached; forget retained observations before executing.");
    }
    this.reservedBytes += bytes;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.reservedBytes -= bytes;
    };
  }

  read(id: string): Observation {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown or forgotten observation id.");
    return JSON.parse(entry.json) as Observation;
  }

  list(sessionId?: string) {
    return [...this.entries.keys()]
      .map((id) => this.read(id))
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
      .map(({ data: _data, ...entry }) => entry);
  }

  forget(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown or forgotten observation id.");
    this.entries.delete(id);
    this.bytes -= entry.bytes;
  }
}
