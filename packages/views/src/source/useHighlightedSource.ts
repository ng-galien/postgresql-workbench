import { useEffect, useState } from "react";
import {
  type HighlightedPostgresSource,
  highlightPostgresSource,
  plainPostgresSource,
} from "./highlight.js";

/**
 * PostgreSQL text, coloured by the grammar as soon as the highlighter answers.
 *
 * It is drawn plain first and coloured when the answer arrives, so the text is readable either way
 * and nothing waits on a highlighter that may never answer. Every surface that shows SQL does this
 * — the SQL panel, the filter field, a source preview — and none of them should have to remember
 * to cancel the answer that arrives after the text has moved on.
 */
export function useHighlightedPostgresSource(text: string): HighlightedPostgresSource {
  const [source, setSource] = useState<HighlightedPostgresSource>(() =>
    plainPostgresSource(postgresSourceLines(text)),
  );

  useEffect(() => {
    let current = true;
    const lines = postgresSourceLines(text);
    setSource(plainPostgresSource(lines));
    void highlightPostgresSource(lines).then((highlighted) => {
      if (current) setSource(highlighted);
    });
    return () => {
      current = false;
    };
  }, [text]);

  return source;
}

/** A text as the source view counts it: one entry per line, numbered from one. */
export function postgresSourceLines(text: string): { number: number; text: string }[] {
  return text.split("\n").map((line, index) => ({ number: index + 1, text: line }));
}
