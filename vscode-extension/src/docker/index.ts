/**
 * Provisioning a local PostgreSQL with the PL/pgSQL debugger in Docker, and telling the user what
 * their server is missing. This file is the module's public surface — everything else under
 * `docker/` is internal.
 */
export { startDockerDebugDatabase } from "./provisioningUi.js";
export { showRequirementsGuide } from "./requirementsGuide.js";
