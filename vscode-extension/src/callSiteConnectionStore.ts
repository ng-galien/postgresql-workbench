export interface CallSiteConnectionReference {
  documentUri: string;
  line: number;
  kind: "call" | "select";
  schema: string | null;
  routine: string;
}

export interface CallSiteConnectionState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

const STATE_KEY = "postgresql-workbench.documentConnections";

function callSiteKey(call: CallSiteConnectionReference): string {
  return call.documentUri;
}

export class CallSiteConnectionStore {
  constructor(private readonly state: CallSiteConnectionState) {}

  get(call: CallSiteConnectionReference): string | undefined {
    return this.state.get<Record<string, string>>(STATE_KEY, {})[callSiteKey(call)];
  }

  getDocument(documentUri: string): string | undefined {
    return this.state.get<Record<string, string>>(STATE_KEY, {})[documentUri];
  }

  async assign(call: CallSiteConnectionReference, serverId: string): Promise<void> {
    await this.assignDocument(call.documentUri, serverId);
  }

  async assignDocument(documentUri: string, serverId: string): Promise<void> {
    const assignments = this.state.get<Record<string, string>>(STATE_KEY, {});
    await this.state.update(STATE_KEY, { ...assignments, [documentUri]: serverId });
  }

  async clear(call: CallSiteConnectionReference): Promise<void> {
    await this.clearDocument(call.documentUri);
  }

  async clearDocument(documentUri: string): Promise<void> {
    const assignments = { ...this.state.get<Record<string, string>>(STATE_KEY, {}) };
    delete assignments[documentUri];
    await this.state.update(STATE_KEY, assignments);
  }

  async clearAll(): Promise<void> {
    await this.state.update(STATE_KEY, {});
  }
}
