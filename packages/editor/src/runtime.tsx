import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import { MonacoEditorReactComp } from "@typefox/monaco-editor-react";
import type { LanguageClientConfig } from "monaco-languageclient/lcwrapper";
import type { MonacoVscodeApiConfig } from "monaco-languageclient/vscodeApiWrapper";
import { type ReactNode, useMemo, useState } from "react";
import { POSTGRES_AUTHORING_LANGUAGE_IDS } from "../../sql/src/text/documentLanguage.js";
import { configureSqlEditorWorker } from "./workerFactory.js";

export interface SqlEditorRuntimeProps {
  /** A complete LSP endpoint. Each page owns one session and one connection. */
  languageServerUrl: string;
  /** Host-materialized bundle of Codingame's official Monaco editor worker. */
  editorWorkerUrl: string;
  children?: ReactNode;
  onError?(error: Error): void;
}

/**
 * Starts the official Monaco VS Code API once for the page and one official language client for
 * its SQL authoring session. Individual editors only create EditorApp instances under this root.
 */
export function SqlEditorRuntime({
  languageServerUrl,
  editorWorkerUrl,
  children,
  onError,
}: SqlEditorRuntimeProps) {
  const [vscodeApiReady, setVscodeApiReady] = useState(false);
  const [languageClientReady, setLanguageClientReady] = useState(false);
  const vscodeApiConfig = useMemo<MonacoVscodeApiConfig>(
    () => ({
      $type: "classic",
      viewsConfig: { $type: "EditorService" },
      // The official language client publishes language status while it initializes. Classic
      // Monaco does not install that VS Code service by itself, so supply the official override.
      serviceOverrides: getLanguagesServiceOverride(),
      advanced: {
        loadExtensionServices: false,
        enforceSemanticHighlighting: true,
      },
      monacoWorkerFactory: (logger) => configureSqlEditorWorker(editorWorkerUrl, logger),
      userConfiguration: {
        json: JSON.stringify({
          "editor.wordBasedSuggestions": "off",
          "editor.semanticHighlighting.enabled": true,
        }),
      },
    }),
    [editorWorkerUrl],
  );
  const languageClientConfig = useMemo<LanguageClientConfig>(
    () => ({
      languageId: "postgresql-workbench-sql",
      connection: { options: { $type: "WebSocketUrl", url: languageServerUrl } },
      clientOptions: {
        documentSelector: POSTGRES_AUTHORING_LANGUAGE_IDS.map((language) => ({ language })),
      },
    }),
    [languageServerUrl],
  );
  return (
    <>
      <MonacoEditorReactComp
        className="postgres-editor-runtime"
        style={{ display: "none" }}
        vscodeApiConfig={vscodeApiConfig}
        languageClientConfig={languageClientConfig}
        // TypeFox shares one manager across component instances. This runtime alone owns its
        // lifecycle; visible EditorApp instances mount only after it has started.
        enforceLanguageClientDispose
        onVscodeApiInitDone={() => setVscodeApiReady(true)}
        onLanguageClientsStartDone={() => setLanguageClientReady(true)}
        onError={onError}
      />
      {vscodeApiReady && languageClientReady ? children : null}
    </>
  );
}
