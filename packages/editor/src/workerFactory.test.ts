import { describe, expect, it, vi } from "vitest";

vi.mock("monaco-languageclient/workerFactory", () => ({
  Worker: class WorkerDescriptor {
    constructor(
      readonly url: string,
      readonly options?: WorkerOptions,
    ) {}
  },
  useWorkerFactory: vi.fn(),
}));

import { sqlEditorWorkerLoaders } from "./workerFactory.js";

describe("SQL editor worker factory", () => {
  it("defines only the official Monaco editor worker as an ES module", () => {
    const loaders = sqlEditorWorkerLoaders("https://workbench.test/editor.worker.js");

    expect(Object.keys(loaders)).toEqual(["editorWorkerService"]);
    expect(loaders.editorWorkerService?.()).toMatchObject({
      url: "https://workbench.test/editor.worker.js",
      options: { type: "module" },
    });
    expect(loaders.TextMateWorker).toBeUndefined();
    expect(loaders.extensionHostWorkerMain).toBeUndefined();
  });
});
