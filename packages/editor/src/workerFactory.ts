import type { ILogger } from "@codingame/monaco-vscode-log-service-override";
import {
  Worker as TypeFoxWorkerDescriptor,
  useWorkerFactory,
  type WorkerLoader,
} from "monaco-languageclient/workerFactory";

const configureWorkerFactory = useWorkerFactory;

const EDITOR_WORKER_LABEL = "editorWorkerService";
let configuredWorkerUrl: string | undefined;

/** The one Monaco worker this editor runtime owns; every other worker label stays unsupported. */
export function sqlEditorWorkerLoaders(
  editorWorkerUrl: string,
): Partial<Record<string, WorkerLoader>> {
  return {
    [EDITOR_WORKER_LABEL]: () => new TypeFoxWorkerDescriptor(editorWorkerUrl, { type: "module" }),
  };
}

/** Installs the official editor worker once for the current browser realm. */
export function configureSqlEditorWorker(editorWorkerUrl: string, logger?: ILogger): void {
  if (editorWorkerUrl.trim().length === 0) {
    throw new Error("SqlEditorRuntime requires a non-empty editorWorkerUrl.");
  }
  if (configuredWorkerUrl && configuredWorkerUrl !== editorWorkerUrl) {
    throw new Error(
      `The Monaco editor worker is already configured as ${configuredWorkerUrl}; received ${editorWorkerUrl}.`,
    );
  }
  configuredWorkerUrl = editorWorkerUrl;
  configureWorkerFactory({ logger, workerLoaders: sqlEditorWorkerLoaders(editorWorkerUrl) });
}
