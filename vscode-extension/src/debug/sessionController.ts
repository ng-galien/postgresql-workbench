import type {
  DebugLaunchRoutineTarget,
  DebugSessionRuntimeState,
  DebugSessionStatus,
} from "../../../packages/dap/src/debugger/launch/index.js";

export type ExtensionDebugSessionState = "starting" | DebugSessionRuntimeState;

export const DEBUG_LAUNCH_TOKEN_PROPERTY = "__plpgsqlDebugLaunchToken";

export interface DebugLaunchDescriptor {
  name: string;
  serverId?: string;
  sql?: string;
  routine?: DebugLaunchRoutineTarget;
  viewColumn?: number;
}

export interface ExtensionDebugSessionSnapshot extends DebugLaunchDescriptor {
  launchToken: string;
  state: ExtensionDebugSessionState;
  vscodeSessionId?: string;
  adapterSessionId?: string;
  status?: DebugSessionStatus;
}

/**
 * Owns the extension-side launch gate.
 *
 * VS Code publishes `activeDebugSession` after the launch command has already
 * yielded. Reserving here before the first await closes that race and keeps the
 * next launch blocked until VS Code confirms that the previous session ended.
 */
export class DebugSessionController {
  private current: ExtensionDebugSessionSnapshot | undefined;
  private sequence = 0;

  constructor(private readonly onChanged: () => void = () => {}) {}

  get active(): ExtensionDebugSessionSnapshot | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  get statuses(): DebugSessionStatus[] {
    return this.current?.status ? [this.current.status] : [];
  }

  reserve(descriptor: DebugLaunchDescriptor): string | undefined {
    if (this.current) return undefined;
    const launchToken = `launch-${++this.sequence}`;
    this.current = {
      ...descriptor,
      launchToken,
      state: "starting",
    };
    this.onChanged();
    return launchToken;
  }

  admit(descriptor: DebugLaunchDescriptor, launchToken?: string): string | undefined {
    if (this.current?.state === "failed" || this.current?.state === "terminated") {
      this.current = undefined;
    }
    if (!this.current) return this.reserve(descriptor);
    if (launchToken && this.current.launchToken === launchToken && !this.current.vscodeSessionId) {
      return launchToken;
    }
    return undefined;
  }

  observeStart(vscodeSessionId: string, launchToken?: string): boolean {
    if (!this.current || !launchToken || this.current.launchToken !== launchToken) return false;
    if (this.current.vscodeSessionId && this.current.vscodeSessionId !== vscodeSessionId) {
      return false;
    }
    if (this.current.vscodeSessionId === vscodeSessionId) return true;
    this.current = { ...this.current, vscodeSessionId };
    this.onChanged();
    return true;
  }

  cancelReservation(launchToken: string): void {
    if (this.current?.launchToken !== launchToken || this.current.vscodeSessionId) return;
    this.current = undefined;
    this.onChanged();
  }

  applyStatus(vscodeSessionId: string, status: DebugSessionStatus): boolean {
    if (!this.current || this.current.vscodeSessionId !== vscodeSessionId) return false;
    if (this.current.adapterSessionId && this.current.adapterSessionId !== status.sessionId) {
      return false;
    }
    this.current = {
      ...this.current,
      state: status.state,
      adapterSessionId: status.sessionId,
      status,
    };
    this.onChanged();
    return true;
  }

  observeTermination(vscodeSessionId: string): boolean {
    if (this.current?.vscodeSessionId !== vscodeSessionId) return false;
    this.current = undefined;
    this.onChanged();
    return true;
  }

  matches(vscodeSessionId: string, adapterSessionId: string): boolean {
    return (
      this.current?.vscodeSessionId === vscodeSessionId &&
      this.current.adapterSessionId === adapterSessionId
    );
  }
}
