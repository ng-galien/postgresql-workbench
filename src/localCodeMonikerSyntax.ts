import { createCodeMonikerSyntaxParser } from "./analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "./analysis/syntaxTree.js";
import {
  connectLocalCodeMoniker,
  type LocalCodeMonikerDaemon,
  type LocalCodeMonikerSession,
} from "./workbench/localCodeMoniker.js";

export interface LocalCodeMonikerSyntaxOptions {
  runtimePath: string;
  workspaceRoots: readonly string[];
  clientName?: string;
  daemon?: LocalCodeMonikerDaemon;
  timeoutMs?: number;
}

/** Maintains a client connection to an existing workspace daemon for stateless parsing. */
export class LocalCodeMonikerSyntaxRuntime {
  private sessionPromise: Promise<LocalCodeMonikerSession> | undefined;
  private parserPromise: Promise<SyntaxParser> | undefined;

  constructor(private readonly options: LocalCodeMonikerSyntaxOptions) {}

  parser(): Promise<SyntaxParser> {
    if (!this.parserPromise) {
      this.parserPromise = this.session().then((session) =>
        createCodeMonikerSyntaxParser(session.client),
      );
    }
    return this.parserPromise;
  }

  async dispose(): Promise<void> {
    const pending = this.sessionPromise;
    this.sessionPromise = undefined;
    this.parserPromise = undefined;
    if (pending) {
      const session = await pending.catch(() => undefined);
      await session?.dispose();
    }
  }

  private session(): Promise<LocalCodeMonikerSession> {
    if (!this.sessionPromise) {
      const pending = connectLocalCodeMoniker({
        runtimePath: this.options.runtimePath,
        workspaceRoots: this.options.workspaceRoots,
        clientName: this.options.clientName ?? "postgresql-workbench",
        daemon: this.options.daemon,
        timeoutMs: this.options.timeoutMs,
      });
      const retryable = pending.catch((error) => {
        if (this.sessionPromise === retryable) this.sessionPromise = undefined;
        throw error;
      });
      this.sessionPromise = retryable;
    }
    return this.sessionPromise;
  }
}
