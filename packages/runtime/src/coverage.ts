import {
  CoverageRunner,
  createCoverageSyntaxService,
  discoverPgTapTests,
  executePgTapTest,
  resetPgTapState,
  toCoverageTestReport,
} from "../../coverage/src/index.js";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import type { EvidenceStore } from "./evidence.js";
import type { DatabaseSessions } from "./sessions.js";

export class CoverageObservations {
  private readonly abort = new AbortController();

  constructor(
    private readonly sessions: DatabaseSessions,
    private readonly evidence: EvidenceStore,
    private readonly parser: () => Promise<SyntaxParser>,
  ) {}

  async discover(sessionId: string) {
    return this.sessions.exclusive(sessionId, async (client) =>
      discoverPgTapTests(client, await this.parser()),
    );
  }

  async run(sessionId: string, routineOids: number[], testOids: number[]) {
    const context = this.sessions.context(sessionId);
    return this.sessions.exclusive(sessionId, async (client) => {
      const discovery = await discoverPgTapTests(client, await this.parser());
      if (!discovery.available) throw new Error("pgTAP is unavailable in this database.");
      const tests = testOids.map((oid) => {
        const test = discovery.tests.find((item) => item.oid === oid && item.runnable);
        if (!test) throw new Error(`Unknown or non-runnable pgTAP test OID ${oid}.`);
        return test;
      });
      const runner = new CoverageRunner(
        () => this.sessions.dedicated(sessionId),
        createCoverageSyntaxService(this.parser),
      );
      const report = await runner.runSuite({
        connectionId: sessionId,
        routineOids,
        timeoutMs: 30_000,
        signal: this.abort.signal,
        executeTests: async (testClient) => {
          const combined = {
            passed: 0,
            failed: 0,
            total: 0,
            tests: [] as { name: string; passed: boolean; message?: string }[],
          };
          for (const test of tests) {
            const result = await testClient
              .runIsolated(async () => {
                const executed = toCoverageTestReport(await executePgTapTest(testClient, test));
                await resetPgTapState(testClient);
                return executed;
              })
              .catch((error: Error) => ({
                passed: 0,
                failed: 1,
                total: 1,
                tests: [
                  { name: `${test.schema}.${test.name}`, passed: false, message: error.message },
                ],
              }));
            combined.passed += result.passed;
            combined.failed += result.failed;
            combined.total += result.total;
            combined.tests.push(...result.tests);
          }
          return combined;
        },
      });
      return this.evidence.capture(sessionId, "coverage", { context, testOids, report });
    });
  }

  cancel(): void {
    this.abort.abort();
  }
}
