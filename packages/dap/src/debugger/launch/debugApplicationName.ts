export const DEBUG_LISTENER_APPLICATION_PREFIX = "plpgsql_dap_listener_";
export const DEBUG_TARGET_APPLICATION_PREFIX = "plpgsql_dap_target_";

export type DebugBackendRole = "listener" | "target";

export interface DebugBackendIdentity {
  role: DebugBackendRole;
  sessionId: string;
  routineOid?: number;
}

export function debugApplicationName(
  role: DebugBackendRole,
  sessionId: string,
  routineOid?: number,
): string {
  const identity = routineOid && routineOid > 0 ? `${sessionId}~${routineOid}` : sessionId;
  return `${role === "listener" ? DEBUG_LISTENER_APPLICATION_PREFIX : DEBUG_TARGET_APPLICATION_PREFIX}${identity}`;
}

export function parseDebugApplicationName(
  applicationName: string,
): DebugBackendIdentity | undefined {
  const roles: Array<[DebugBackendRole, string]> = [
    ["listener", DEBUG_LISTENER_APPLICATION_PREFIX],
    ["target", DEBUG_TARGET_APPLICATION_PREFIX],
  ];
  for (const [role, prefix] of roles) {
    if (applicationName.startsWith(prefix) && applicationName.length > prefix.length) {
      const identity = applicationName.slice(prefix.length);
      const separator = identity.lastIndexOf("~");
      if (separator > 0) {
        const sessionId = identity.slice(0, separator);
        const routineOid = Number(identity.slice(separator + 1));
        if (Number.isSafeInteger(routineOid) && routineOid > 0) {
          return { role, sessionId, routineOid };
        }
      }
      return { role, sessionId: identity };
    }
  }
  return undefined;
}
