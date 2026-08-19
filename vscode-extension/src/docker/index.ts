/**
 * Telling the user what their server is missing, and driving the Docker provisioning that
 * `packages/dap` performs. This file is the module's public surface — everything else under
 * `docker/` is internal.
 */
export { startDockerDebugDatabase } from "./provisioningUi.js";
export { showRequirementsGuide } from "./requirementsGuide.js";
