import { StatelessCodeMonikerSyntaxRuntime } from "../../sql/src/localCodeMonikerSyntax.js";
import { CatalogObservations } from "./catalog.js";
import { CoverageObservations } from "./coverage.js";
import { DebugSessions } from "./debug.js";
import { EvidenceStore } from "./evidence.js";
import { ScratchpadSessions } from "./scratchpads.js";
import { type ConnectionProfile, DatabaseSessions } from "./sessions.js";

/** Host-neutral composition and lifetime for standalone Workbench capabilities. */
export class WorkbenchRuntime {
  readonly evidence = new EvidenceStore();
  readonly sessions: DatabaseSessions;
  readonly scratchpads: ScratchpadSessions;
  readonly catalog: CatalogObservations;
  readonly debug: DebugSessions;
  readonly coverage: CoverageObservations;
  private readonly syntax = new StatelessCodeMonikerSyntaxRuntime();

  constructor(profiles: readonly ConnectionProfile[]) {
    this.sessions = new DatabaseSessions(profiles);
    this.scratchpads = new ScratchpadSessions(this.sessions, this.evidence);
    this.catalog = new CatalogObservations(this.sessions, this.evidence);
    this.debug = new DebugSessions(this.sessions, this.evidence);
    this.coverage = new CoverageObservations(this.sessions, this.evidence, () =>
      this.syntax.parser(),
    );
  }

  async closeSession(id: string): Promise<void> {
    await this.debug.closeSession(id);
    await this.sessions.close(id);
  }

  async dispose(): Promise<void> {
    this.coverage.cancel();
    await this.debug.dispose();
    await this.sessions.dispose();
    await this.syntax.dispose();
  }
}
