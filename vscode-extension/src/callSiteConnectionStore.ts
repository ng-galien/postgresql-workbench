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

const STATE_KEY = "postgresql-workbench.callSiteConnections";

function callSiteKey(call: CallSiteConnectionReference): string {
  return JSON.stringify([call.documentUri, call.line, call.kind, call.schema ?? "", call.routine]);
}

export class CallSiteConnectionStore {
  constructor(private readonly state: CallSiteConnectionState) {}

  get(call: CallSiteConnectionReference): string | undefined {
    return this.state.get<Record<string, string>>(STATE_KEY, {})[callSiteKey(call)];
  }

  async assign(call: CallSiteConnectionReference, serverId: string): Promise<void> {
    const assignments = this.state.get<Record<string, string>>(STATE_KEY, {});
    await this.state.update(STATE_KEY, { ...assignments, [callSiteKey(call)]: serverId });
  }

  async clear(call: CallSiteConnectionReference): Promise<void> {
    const assignments = { ...this.state.get<Record<string, string>>(STATE_KEY, {}) };
    delete assignments[callSiteKey(call)];
    await this.state.update(STATE_KEY, assignments);
  }

  async clearAll(): Promise<void> {
    await this.state.update(STATE_KEY, {});
  }
}
