import { afterEach, describe, expect, it, vi } from "vitest";

const roots = vi.hoisted(
  () => [] as Array<{ render: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn> }>,
);

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => {
    const root = { render: vi.fn(), unmount: vi.fn() };
    roots.push(root);
    return root;
  }),
}));

import { activate, normalizeSqlNotebookOutputPayload } from "./index.js";

afterEach(() => {
  roots.length = 0;
  vi.unstubAllGlobals();
});

/** An output element as the notebook hands one over: attached to a document, drawn in a shadow. */
function outputElement(): HTMLElement {
  const shadow = { replaceChildren: vi.fn(), append: vi.fn() };
  return {
    shadowRoot: null,
    attachShadow: vi.fn(() => shadow),
    ownerDocument: {
      head: { append: vi.fn() },
      createElement: vi.fn(() => ({ setAttribute: vi.fn() })),
      querySelector: vi.fn(() => null),
    },
  } as unknown as HTMLElement;
}

describe("SQL notebook renderer lifecycle", () => {
  it("upgrades an existing v2 rowset instead of treating it as a command report", () => {
    expect(
      normalizeSqlNotebookOutputPayload({
        version: 2,
        binding: { connectionId: "test", connectionName: "Test", database: "testdb" },
        command: "SELECT",
        columns: [],
        rows: [],
        capturedRowCount: 0,
        durationMs: 1,
        truncated: false,
        truncationReasons: [],
      }),
    ).toMatchObject({ version: 3, kind: "rowset", command: "SELECT" });
  });

  it("replaces and disposes React roots by output id", () => {
    const element = outputElement();
    const output = { id: "result-1", json: () => ({}) };
    const renderer = activate();

    renderer.renderOutputItem(output, element);
    renderer.renderOutputItem(output, element);
    expect(roots).toHaveLength(2);
    expect(roots[0]?.unmount).toHaveBeenCalledOnce();

    renderer.disposeOutputItem(output.id);
    expect(roots[1]?.unmount).toHaveBeenCalledOnce();

    renderer.renderOutputItem({ ...output, id: "result-2" }, element);
    renderer.disposeOutputItem();
    expect(roots[2]?.unmount).toHaveBeenCalledOnce();
  });

  it("places host theme overrides after the product defaults in a notebook shadow root", () => {
    const element = outputElement();
    const renderer = activate({}, ":host { --pgw-text: host-colour; }");

    renderer.renderOutputItem({ id: "result-1", json: () => ({}) }, element);

    const shadow = vi.mocked(element.attachShadow).mock.results[0]?.value;
    const style = vi.mocked(shadow.append).mock.calls[0]?.[0] as HTMLStyleElement;
    expect(style.textContent).toMatch(/:host \{ --pgw-text: host-colour; \}$/u);
  });

  it("bridges renderer messages into the React result view", () => {
    let receiveMessage: ((message: unknown) => void) | undefined;
    const postMessage = vi.fn();
    const disposeMessages = vi.fn();
    const renderer = activate({
      postMessage,
      onDidReceiveMessage(listener) {
        receiveMessage = listener as (message: unknown) => void;
        return { dispose: disposeMessages };
      },
    });
    const element = outputElement();

    renderer.renderOutputItem({ id: "result-1", json: () => ({}) }, element);
    const reactElement = roots[0]?.render.mock.calls[0]?.[0];
    const messaging = reactElement?.props.messaging;
    const listener = vi.fn();
    const unsubscribe = messaging.subscribe(listener);
    const response = {
      type: "sql-result/progress",
      sessionId: "session-1",
      loadedRowCount: 5_000,
    };
    receiveMessage?.(response);
    expect(listener).toHaveBeenCalledWith(response);

    const request = {
      type: "sql-result/request",
      sessionId: "session-1",
      action: "next",
    };
    messaging.postMessage(request);
    expect(postMessage).toHaveBeenCalledWith(request);

    unsubscribe();
    receiveMessage?.(response);
    expect(listener).toHaveBeenCalledOnce();
    renderer.disposeOutputItem();
    expect(disposeMessages).toHaveBeenCalledOnce();
  });
});
