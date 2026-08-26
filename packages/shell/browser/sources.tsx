import { createRoot } from "react-dom/client";
import type { SourcesRequest, SourcesResponse } from "../../catalog/src/sourcesProtocol.js";
import { postgresSourceStyles } from "../../views/src/source/sourceStyles.js";
import { SourcesApp } from "../../views/src/sources/SourcesApp.js";
import sourcesStyles from "../../views/src/sources/sources.css";
import { pageBridge, preparePage } from "./bridge.js";
import vscodeTheme from "./vscodeTheme.css";

/** The virtual sources, in a browser: the same list every shell serves, the same stream's colours. */
const messaging = pageBridge<SourcesRequest, SourcesResponse>("/sources");
const container = preparePage(`${vscodeTheme}\n${postgresSourceStyles}\n${sourcesStyles}`);
if (container) createRoot(container).render(<SourcesApp messaging={messaging} />);
