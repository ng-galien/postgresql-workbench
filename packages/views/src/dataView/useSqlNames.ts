import { useEffect, useRef, useState } from "react";
import type { DataViewSqlToken } from "../../../rows/src/dataView/dataViewProtocol.js";
import type { DataViewMessaging } from "./DataViewApp.js";
import { nextRequestId } from "./requests.js";

/**
 * What the language server makes of the names in a SQL text: which of them is a table, a column,
 * an alias, a variable.
 *
 * Every surface that shows SQL asks the same way and has the same thing to get wrong — an answer
 * that arrives after the text has moved on. So the asking is written once: the answer to anything
 * but the last question is dropped, and a text that changes drops the names it had before the new
 * ones arrive, rather than colouring the new text with the old text's names.
 *
 * A condition is asked about as part of the query holding it, because a condition alone names
 * aliases nothing could resolve; the host puts it back in a draft of the real statement and
 * returns only the names that fall inside what was typed.
 */
export function useSqlNames(
  messaging: DataViewMessaging,
  text: string,
  of: "query" | "filter",
  debounceMs = 0,
): readonly DataViewSqlToken[] {
  const [named, setNamed] = useState<readonly DataViewSqlToken[]>([]);
  const asked = useRef(0);

  useEffect(
    () =>
      messaging.subscribe((message) => {
        if (message.type === "data-view/tokens" && message.requestId === asked.current) {
          setNamed(message.tokens);
        }
      }),
    [messaging],
  );

  useEffect(() => {
    asked.current = nextRequestId();
    setNamed([]);
    if (text.trim() === "") return;
    const requested = asked.current;
    const ask = () =>
      messaging.post({
        type: "data-view/tokens",
        requestId: requested,
        of: of === "query" ? "query" : { filter: text },
      });
    if (debounceMs === 0) {
      ask();
      return;
    }
    const timer = window.setTimeout(ask, debounceMs);
    return () => window.clearTimeout(timer);
  }, [messaging, text, of, debounceMs]);

  return named;
}
