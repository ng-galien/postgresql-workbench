import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { remoteSqlAuthoringHostServices } from "./hostServices.js";
import { startSqlAuthoringServer } from "./sqlAuthoringServer.js";

/** Node stdio/IPC entry point. Importing the server core itself starts no transport and no state. */
const connection = createConnection(ProposedFeatures.all);
startSqlAuthoringServer(connection, remoteSqlAuthoringHostServices(connection));
