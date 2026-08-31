import { createRoot } from "react-dom/client";
import type { SourcesRequest, SourcesResponse } from "../../catalog/src/sourcesProtocol.js";
import editorStyles from "../../editor/src/editor.css";
import { MonacoSqlEditor } from "../../editor/src/MonacoSqlEditor.js";
import { SqlEditorRuntime } from "../../editor/src/runtime.js";
import defaultThemeStyles from "../../presentation/src/defaultTheme.css";
import navigationStyles from "../../views/src/navigation/workbenchNavigation.css";
import { SourcesApp } from "../../views/src/sources/SourcesApp.js";
import sourcesStyles from "../../views/src/sources/sources.css";
import { languageServerUrl, pageBridge, preparePage } from "./bridge.js";
import { ShellPage } from "./ShellPage.js";
import shellPageStyles from "./shellPage.css";

/** The virtual sources, in a browser: the same list every shell serves, the same stream's colours. */
const messaging = pageBridge<SourcesRequest, SourcesResponse>("/sources");
const container = preparePage(
  `${defaultThemeStyles}\n${navigationStyles}\n${shellPageStyles}\n${editorStyles}\n${sourcesStyles}`,
);
if (container)
  createRoot(container).render(
    <SqlEditorRuntime languageServerUrl={languageServerUrl()} editorWorkerUrl="/editor.worker.js">
      <ShellPage active="sources">
        <SourcesApp messaging={messaging} Editor={MonacoSqlEditor} />
      </ShellPage>
    </SqlEditorRuntime>,
  );
