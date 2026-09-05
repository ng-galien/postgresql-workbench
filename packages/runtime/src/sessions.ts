import { randomUUID } from "node:crypto";
import type { Client } from "pg";

export interface ConnectionProfile {
  id: string;
  label: string;
  open(): Promise<Client>;
}

export interface DatabaseSession {
  id: string;
  profileId: string;
  database: string;
  openedAsRole: string;
  backendPid: number;
  openedAt: string;
  state: "open" | "closed" | "failed";
  busy: boolean;
}

interface OwnedSession {
  context: DatabaseSession;
  client: Client;
  clients: Set<Client>;
  profile: ConnectionProfile;
}

/** Owns every backend used by a standalone session, including dedicated debug/coverage lanes. */
export class DatabaseSessions {
  private readonly sessions = new Map<string, OwnedSession>();
  private closing = false;

  constructor(private readonly profiles: readonly ConnectionProfile[]) {}

  connections() {
    return this.profiles.map(({ id, label }) => ({ id, label }));
  }

  async open(profileId: string): Promise<DatabaseSession> {
    if (this.closing) throw new Error("Workbench is shutting down.");
    if (this.sessions.size >= 32) throw new Error("Session limit reached; restart the server.");
    const profile = this.profiles.find(({ id }) => id === profileId);
    if (!profile) throw new Error("Unknown connection profile.");
    const client = await profile.open();
    try {
      const identity = await client.query<{ database: string; user: string; pid: number }>(
        "SELECT current_database() AS database, current_user AS user, pg_backend_pid() AS pid",
      );
      const row = identity.rows[0];
      if (!row || this.closing) throw new Error("Session could not be opened.");
      const context: DatabaseSession = {
        id: randomUUID(),
        profileId,
        database: row.database,
        openedAsRole: row.user,
        backendPid: row.pid,
        openedAt: new Date().toISOString(),
        state: "open",
        busy: false,
      };
      const session: OwnedSession = { context, client, clients: new Set([client]), profile };
      client.on("error", () => {
        context.state = "failed";
      });
      this.sessions.set(context.id, session);
      return { ...context };
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  list() {
    return [...this.sessions.values()].map(({ context }) => ({ ...context }));
  }

  context(id: string): DatabaseSession {
    return { ...this.require(id).context };
  }

  async exclusive<T>(id: string, action: (client: Client) => Promise<T>): Promise<T> {
    const session = this.require(id);
    if (session.context.busy) throw new Error("Session is busy; wait for its current operation.");
    session.context.busy = true;
    try {
      return await action(session.client);
    } finally {
      session.context.busy = false;
    }
  }

  async dedicated(id: string, timeoutMs = 30_000): Promise<Client> {
    const session = this.require(id);
    const client = await session.profile.open();
    client.on("error", () => {});
    session.clients.add(client);
    client.once("end", () => session.clients.delete(client));
    try {
      if (session.context.state !== "open") throw new Error("Session is closed.");
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(timeoutMs)]);
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown session id.");
    session.context.state = "closed";
    const clients = [...session.clients];
    await Promise.allSettled(clients.map((client) => client.end()));
    session.clients.clear();
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private require(id: string): OwnedSession {
    const session = this.sessions.get(id);
    if (session?.context.state !== "open") throw new Error("Unknown or closed session id.");
    return session;
  }
}
