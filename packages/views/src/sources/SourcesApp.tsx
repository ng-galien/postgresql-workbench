import { useEffect, useMemo, useState } from "react";
import type {
  SourcesListItem,
  SourcesRequest,
  SourcesResponse,
} from "../../../catalog/src/sourcesProtocol.js";
import { plainPostgresSource } from "../source/highlight.js";
import { PostgresSourceView } from "../source/PostgresSourceView.js";
import { withSemanticTokens } from "../source/semanticTokens.js";
import type { WebviewMessaging } from "../webviewPage.js";

export type SourcesMessaging = WebviewMessaging<SourcesRequest, SourcesResponse>;

/**
 * The virtual sources, read in a browser: the list the catalog projects on one side, and on the
 * other the source a reader picked, coloured by the language server's one stream — the same
 * documents and the same colours every shell shows, with nothing decided in this view.
 */
export function SourcesApp({ messaging }: { messaging: SourcesMessaging }) {
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

  const painted = useMemo(
    () =>
      opened ? withSemanticTokens(plainPostgresSource(opened.lines), opened.tokens) : undefined,
    [opened],
  );

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
        {painted && opened ? (
          <>
            <h1 className="sources-title">{opened.title}</h1>
            <PostgresSourceView source={painted} />
          </>
        ) : (
          <p className="sources-empty">Pick a source on the left.</p>
        )}
      </section>
    </main>
  );
}
