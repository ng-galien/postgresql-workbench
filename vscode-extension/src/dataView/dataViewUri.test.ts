import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: class Uri {
    readonly scheme: string;
    readonly path: string;
    readonly query: string;

    constructor(parts: { scheme: string; path: string; query?: string }) {
      this.scheme = parts.scheme;
      this.path = parts.path;
      this.query = parts.query ?? "";
    }

    static from(parts: { scheme: string; path: string; query?: string }): Uri {
      return new Uri(parts);
    }

    with(change: { path?: string }): Uri {
      return new Uri({
        scheme: this.scheme,
        path: change.path ?? this.path,
        query: this.query,
      });
    }
  },
}));

import * as vscode from "vscode";
import { DATA_VIEW_URI_SCHEME, dataViewUri, parseDataViewUri } from "./dataViewUri.js";

describe("Data View URI", () => {
  it("round-trips a Connection-backed source", () => {
    const source = {
      kind: "relation" as const,
      connectionId: "connection-a",
      database: "app",
      schema: "public",
      name: "customers",
      relationKind: "table" as const,
    };

    expect(parseDataViewUri(dataViewUri(source))).toEqual(source);
  });

  it("normalizes the historical persisted serverId key", () => {
    const persisted = {
      kind: "sql",
      serverId: "connection-a",
      database: "app",
      sql: "select 1",
      label: "select 1",
    };
    const encoded = Buffer.from(JSON.stringify(persisted), "utf8").toString("base64url");
    const uri = vscode.Uri.from({
      scheme: DATA_VIEW_URI_SCHEME,
      path: "/connection-a/app/select 1",
      query: `source=${encoded}`,
    });

    expect(parseDataViewUri(uri)).toEqual({
      kind: "sql",
      connectionId: "connection-a",
      database: "app",
      sql: "select 1",
      label: "select 1",
    });
  });
});
