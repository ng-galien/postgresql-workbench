import type { WorkbenchDdlSyncStatus } from "../../../catalog/src/ddlSync.js";
import type {
  WorkbenchIndexProgress,
  WorkbenchIndexResult,
  WorkbenchIndexStatus,
} from "../../../catalog/src/indexController.js";
import type { ConnectionTuning, SslMode } from "../../../catalog/src/savedConnection.js";
import type { PostgresServerSnapshot } from "../../../catalog/src/serverSnapshot.js";
import appSettingsJson from "./appSettings.json" with { type: "json" };

/**
 * What the Connections page and its host send each other. The page manages the saved Connections
 * of any host — VS Code today, the browser shell and Electron tomorrow — so nothing here names a
 * host concept, and no stored secret ever crosses toward the page: a password travels only from
 * the form to the host, on save and on test.
 */

export type { ConnectionTuning, SslMode };

export type SchemaSyncStatus = WorkbenchDdlSyncStatus;

export type WorkbenchIndexSummaryStatus = WorkbenchIndexStatus;

/** Host-neutral operational state of the Workbench index for one PostgreSQL database. */
export interface WorkbenchIndexSummary {
  status: WorkbenchIndexSummaryStatus;
  message?: string;
  progress?: WorkbenchIndexProgress;
  change?: {
    kind: "full" | "incremental";
    sources: number;
  };
  result?: Omit<WorkbenchIndexResult, "connectionId" | "database">;
}

/** One saved Connection as the page lists it: identity, never the secret itself. */
export interface ConnectionSummary {
  id: string;
  name?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: SslMode;
  tuning?: ConnectionTuning;
  hasPassword: boolean;
  connected: boolean;
  debugger: {
    status: "unknown" | "checking" | "available" | "unavailable" | "error";
    message?: string;
  };
  schemaSync: {
    enabled: boolean;
    status: SchemaSyncStatus;
    supportSchema: string;
    message?: string;
  };
  index: WorkbenchIndexSummary;
}

/** What the form holds. `password` undefined means: keep the stored one. */
export interface ConnectionDraft {
  name?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: SslMode;
  tuning?: ConnectionTuning;
  password?: string;
}

/** One verification the host ran, in the order it ran them. */
export interface ConnectionTestStep {
  label: string;
  status: "ok" | "failed" | "skipped";
  detail?: string;
}

export interface ConnectionTestReport {
  ok: boolean;
  steps: ConnectionTestStep[];
  /** What the server said about itself, when the connection came up. */
  server?: PostgresServerSnapshot;
}

export type AppSettingValue = string | number | boolean | readonly string[];

export type AppSettingSection = "authoring" | "results" | "coverage" | "engine" | "schema-sync";

/** One application setting the page can read and write; the host maps it to its own store. */
export interface AppSettingDescriptor {
  /** Key below the `postgresql-workbench.` prefix. */
  key: string;
  label: string;
  description: string;
  kind: "number" | "boolean" | "string" | "select" | "list";
  options?: readonly string[];
  section: AppSettingSection;
  default: AppSettingValue;
  minimum?: number;
  maximum?: number;
}

/**
 * Every application setting the Settings page presents. The JSON file is the one authority: the
 * host manifest must agree with it, and `check-settings-authority` fails the build when it drifts.
 */
export const APP_SETTINGS = appSettingsJson as readonly AppSettingDescriptor[];

/** The extensions the Workbench builds on, installable from the page when the server offers them. */
export type WorkbenchServerExtension = "pldbgapi" | "pgtap";

export type ConnectionsPageRequest =
  | { type: "ready" }
  | { type: "save"; draft: ConnectionDraft; originalId?: string; connect?: boolean }
  | { type: "delete"; id: string }
  | { type: "connect"; id: string }
  | { type: "disconnect"; id: string }
  | { type: "inspect"; id: string; requestId: number }
  | { type: "refreshIndex"; id: string }
  | { type: "setSchemaSyncEnabled"; id: string; enabled: boolean }
  | { type: "provisionSchemaSync"; id: string }
  | { type: "test"; draft: ConnectionDraft; originalId?: string; requestId: number }
  | {
      type: "installExtension";
      name: WorkbenchServerExtension;
      draft: ConnectionDraft;
      originalId?: string;
    }
  | { type: "setAppSetting"; key: string; value?: AppSettingValue }
  | { type: "pickCertificate"; purpose: "ca" | "cert" | "key"; requestId: number }
  | { type: "startDockerDatabase" }
  | { type: "import" };

export type ConnectionsPageResponse =
  | { type: "state"; connections: ConnectionSummary[] }
  | { type: "saved"; id: string }
  | { type: "saveFailed"; message: string }
  | {
      type: "connectionAction";
      id: string;
      action: "connect" | "disconnect";
      ok: boolean;
      message?: string;
    }
  | { type: "inspected"; id: string; requestId: number; server: PostgresServerSnapshot }
  | { type: "inspectionFailed"; id: string; requestId: number; message: string }
  | { type: "schemaSyncAction"; id: string; ok: boolean; message?: string }
  | { type: "tested"; requestId: number; report: ConnectionTestReport }
  | { type: "appSettings"; values: Record<string, AppSettingValue> }
  | { type: "certificatePicked"; purpose: "ca" | "cert" | "key"; requestId: number; path?: string }
  | { type: "dockerDatabaseStarted"; id?: string }
  | { type: "extensionInstalled"; name: WorkbenchServerExtension; ok: boolean; message?: string };
