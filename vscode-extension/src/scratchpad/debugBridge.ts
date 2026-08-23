import * as vscode from "vscode";
import type { WorkbenchIndexController } from "../../../packages/catalog/src/indexController.js";
import { getConnectionName } from "../../../packages/catalog/src/savedConnection.js";
import {
  DEBUG_RESULT_EVENT,
  DEBUG_RESULT_STATUS_EVENT,
  type DebugResultEntry,
} from "../../../packages/dap/src/debugger/launch/index.js";
import type { DebugSessionController } from "../../../packages/dap/src/debugger/launch/sessionController.js";
import { type ParsedCallSite, parseSqlCalls } from "../../../packages/sql/src/callParser.js";
import type {
  SqlAuthoringObject,
  SqlAuthoringSnapshot,
} from "../../../packages/sql/src/snapshot.js";
import type { ConnectionManager } from "../connection/index.js";
import {
  isDebugResult,
  isDebugResultStatus,
  type LaunchDebugConfig,
  launchDebug,
} from "../debug/registerCommands.js";
import type {
  ScratchpadDebugEligibility,
  ScratchpadDebugger,
  ScratchpadDebugOutcome,
} from "../scratchpad/index.js";

/**
 * Running a Scratchpad cell under the PL/pgSQL debugger: whether a cell is debuggable, which of
 * its calls to launch, and the SQL result the finished session leaves behind. The Scratchpad asks;
 * the debug module executes.
 */
export function createScratchpadDebugging(deps: {
  connections: ConnectionManager;
  index: WorkbenchIndexController;
  debugSessions: DebugSessionController;
  output: vscode.OutputChannel;
}) {
  const { connections: cm, index: workbenchIndex, debugSessions, output: out } = deps;
  const awaitDebugResult = (): {
    completion: Promise<DebugResultEntry | undefined>;
    stop: () => Promise<void>;
    abandon: () => void;
  } => {
    let settle: (entry: DebugResultEntry | undefined) => void = () => {};
    const completion = new Promise<DebugResultEntry | undefined>((resolve) => {
      settle = resolve;
    });
    const subscriptions: vscode.Disposable[] = [];
    const finish = (entry: DebugResultEntry | undefined) => {
      for (const subscription of subscriptions) subscription.dispose();
      settle(entry);
    };
    subscriptions.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
        if (event.session.type !== "postgresql-workbench") return;
        if (event.event === DEBUG_RESULT_EVENT && isDebugResult(event.body)) finish(event.body);
        else if (
          event.event === DEBUG_RESULT_STATUS_EVENT &&
          isDebugResultStatus(event.body) &&
          event.body.status === "error"
        ) {
          finish(event.body);
        }
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.type !== "postgresql-workbench") return;
        setTimeout(() => finish(undefined), 500);
      }),
    );
    return {
      completion,
      stop: async () => {
        const session = vscode.debug.activeDebugSession;
        if (session?.type === "postgresql-workbench") await vscode.debug.stopDebugging(session);
      },
      abandon: () => finish(undefined),
    };
  };
  const startScratchpadDebug = async (
    config: LaunchDebugConfig,
    failure: string,
  ): Promise<ScratchpadDebugOutcome> => {
    const pending = awaitDebugResult();
    const started = await launchDebug(
      cm,
      debugSessions,
      config,
      await workbenchIndex.syntaxParser(),
      out,
    );
    if (!started) {
      pending.abandon();
      return { started: false, message: failure };
    }
    return { started: true, completion: pending.completion, stop: pending.stop };
  };
  /** Resolves the debuggable entry points of a Scratchpad cell against an available snapshot. */
  const scratchpadDebugTargets = async (
    sql: string,
    snapshot: SqlAuthoringSnapshot,
  ): Promise<{
    triggerRoutine?: SqlAuthoringObject;
    picks: Array<{ label: string; description: string; call: ParsedCallSite }>;
  }> => {
    const parsed = (await parseSqlCalls(sql, await workbenchIndex.syntaxParser())).filter(
      (call) => call.isLaunchable,
    );
    if (parsed.length === 0) {
      const triggerHarness = /-- Invokes trigger\s+\S+\s+and function\s+([^\s.]+)\.([^\s]+)/u.exec(
        sql,
      );
      const triggerRoutine = triggerHarness
        ? snapshot.objects.find(
            (object) =>
              object.kind === "function" &&
              object.plpgsql === true &&
              object.schema === triggerHarness[1] &&
              object.name === triggerHarness[2] &&
              object.returnType?.toLocaleLowerCase() === "trigger",
          )
        : undefined;
      return { triggerRoutine, picks: [] };
    }
    const picks = parsed.flatMap((call) => {
      const expectedKind = call.kind === "call" ? "procedure" : "function";
      const candidates = snapshot.objects.filter(
        (object) =>
          object.kind === expectedKind &&
          object.plpgsql === true &&
          object.name === call.routine &&
          (call.schema === null || object.schema === call.schema) &&
          object.parameters.length === call.args.length,
      );
      return candidates.length === 1
        ? [
            {
              label: `${call.kind === "call" ? "CALL" : "SELECT"} ${candidates[0].schema}.${candidates[0].name}`,
              description: `Line ${call.line}`,
              call,
            },
          ]
        : [];
    });
    return { picks };
  };
  const canDebugScratchpadSql: ScratchpadDebugEligibility = async ({ sql, association }) => {
    if (cm.debugCapabilityFor(association.serverId).status !== "available") return false;
    const snapshot = workbenchIndex.sqlAuthoringSnapshot(association);
    if (snapshot?.status !== "available" || !sql.trim()) return false;
    try {
      const targets = await scratchpadDebugTargets(sql, snapshot);
      return Boolean(targets.triggerRoutine) || targets.picks.length > 0;
    } catch {
      return false;
    }
  };
  const debugScratchpadSql: ScratchpadDebugger = async ({ sql, association, source }) => {
    const snapshot = workbenchIndex.sqlAuthoringSnapshot(association);
    if (snapshot?.status !== "available") {
      const server = cm.store.get(association.serverId);
      void vscode.window
        .showWarningMessage(
          `Debug needs a fresh Workbench Index of ${server ? getConnectionName(server) : association.database}.`,
          "Index Association",
        )
        .then((choice) => {
          if (choice === "Index Association") {
            void vscode.commands.executeCommand("postgresql-workbench.indexAssociation", {
              serverId: association.serverId,
            });
          }
        });
      return {
        started: false,
        message:
          "The Scratchpad Association has no fresh Workbench Index. Use Index Association, then run the cell again.",
      };
    }
    const { triggerRoutine, picks } = await scratchpadDebugTargets(sql, snapshot);
    if (picks.length === 0) {
      if (triggerRoutine) {
        return startScratchpadDebug(
          {
            sql,
            entryRoutine: {
              schema: triggerRoutine.schema,
              name: triggerRoutine.name,
              kind: "function",
              oid: triggerRoutine.oid,
              argTypes: [],
            },
            serverId: association.serverId,
            resultLabel: `${triggerRoutine.schema}.${triggerRoutine.name} · ${source.name}`,
            resultSource: source,
          },
          "The PL/pgSQL trigger debug session did not start.",
        );
      }
      return {
        started: false,
        message:
          "Debug requires a direct replayable CALL or SELECT of one indexed PL/pgSQL routine.",
      };
    }
    const selected =
      picks.length === 1
        ? picks[0]
        : await vscode.window.showQuickPick(
            picks.map((pick) => ({
              ...pick,
              detail:
                "Debug runs only this Statement; the other Statements of the cell are not executed.",
            })),
            {
              title: "Scratchpad Debug target",
              placeHolder: "Choose one PL/pgSQL entry point",
            },
          );
    if (!selected) return { started: false, cancelled: true };
    return startScratchpadDebug(
      {
        sql: selected.call.sql,
        serverId: association.serverId,
        resultLabel: `${selected.label.replace(/^(?:CALL|SELECT)\s+/u, "")} · ${source.name}:${selected.call.line}`,
        resultSource: { ...source, line: selected.call.line },
      },
      "The PL/pgSQL debug session did not start.",
    );
  };
  const inspectAcceptanceDebugState = () => ({
    breakpoints: vscode.debug.breakpoints.map((breakpoint) =>
      breakpoint instanceof vscode.SourceBreakpoint
        ? {
            enabled: breakpoint.enabled,
            line: breakpoint.location.range.start.line + 1,
            uri: breakpoint.location.uri.toString(),
          }
        : { enabled: breakpoint.enabled },
    ),
    extensionSession: debugSessions.active,
    vscodeSessionId: vscode.debug.activeDebugSession?.id,
  });
  return { canDebugScratchpadSql, debugScratchpadSql, inspectAcceptanceDebugState };
}
