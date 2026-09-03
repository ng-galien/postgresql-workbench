import { useEffect, useState } from "react";
import type {
  SourcesListItem,
  SourcesRequest,
  SourcesResponse,
} from "../../../catalog/src/sourcesProtocol.js";
import type { SqlEditorSurface } from "../../../editor/src/contracts.js";
import type { ViewMessaging } from "../messaging.js";

export type SourcesMessaging = ViewMessaging<SourcesRequest, SourcesResponse>;

/**
 * The virtual sources, read in a browser: the list the catalog projects on one side, and on the
 * other the source a reader picked, coloured by the language server's one stream — the same
 * documents and the same colours every shell shows, with nothing decided in this view.
 */
export function SourcesApp({
  messaging,
  Editor,
}: {
  messaging: SourcesMessaging;
  Editor: SqlEditorSurface;
}) {
  const [items, setItems] = useState<SourcesListItem[]>([]);
  const [opened, setOpened] = useState<
    Extract<SourcesResponse, { type: "sources/source" }> | undefined
  >();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const stop = messaging.subscribe((message) => {
      if (message.type === "sources/list") setItems(message.items);
      if (message.type === "sources/source") {
        setOpened(message);
        setNotice(undefined);
      }
      if (message.type === "sources/notice") setNotice(message.message);
    });
    messaging.post({ type: "sources/ready" });
    return stop;
  }, [messaging]);

  useEffect(() => {
    const first = items[0];
    if (!opened && first) messaging.post({ type: "sources/open", uri: first.uri });
  }, [items, messaging, opened]);

  return (
    <main className="sources">
      <nav className="sources-list" aria-label="Virtual sources">
        {items.map((item) => (
          <button
            type="button"
            key={item.uri}
            className={`sources-item${opened?.uri === item.uri ? " open" : ""}`}
            onClick={() => messaging.post({ type: "sources/open", uri: item.uri })}
          >
            <span className={`sources-kind sources-kind-${item.kind}`}>{item.kind}</span>
            <span className="sources-name">
              {item.schema ? `${item.schema}.` : ""}
              {item.name}
            </span>
          </button>
        ))}
      </nav>
      <section className="sources-reader" aria-label="Source">
        {notice ? <p className="sources-notice">{notice}</p> : null}
        {opened ? (
          <>
            <h1 className="sources-title">{opened.title}</h1>
            <div className="sources-editor postgres-editor-surface">
              <Editor
                uri={opened.editorUri}
                text={opened.text}
                languageId={opened.languageId}
                ariaLabel="PostgreSQL source code"
                readOnly
              />
            </div>
          </>
        ) : (
          <p className="sources-empty">Pick a source on the left.</p>
        )}
      </section>
    </main>
  );
}
