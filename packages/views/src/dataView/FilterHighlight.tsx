import { type Ref, type RefObject, useCallback, useLayoutEffect, useMemo } from "react";
import type { DataViewSqlToken } from "../../../rows/src/dataView/dataViewProtocol.js";
import { PostgresToken } from "../source/PostgresSourceView.js";
import { withSemanticTokens } from "../source/semanticTokens.js";
import { useHighlightedPostgresSource } from "../source/useHighlightedSource.js";

/**
 * The condition, coloured, behind the field it is typed in.
 *
 * A textarea holds one colour, and a condition is SQL like any other: it deserves the grammar's
 * colours and the names the language server resolved in it. So the text is drawn twice — painted
 * here, and typed in a transparent field over it — which is why every metric that decides where a
 * character lands is shared between the two in the stylesheet rather than set on each.
 *
 * It is hidden from assistive technology: the field above already carries the text and is what a
 * reader interacts with. An empty line is drawn with a zero-width space so that it still takes a
 * line's height and the two stay aligned.
 */
export function FilterHighlight({
  text,
  named,
  ref,
}: {
  text: string;
  named: readonly DataViewSqlToken[];
  /** The field scrolls itself as the caret moves; whoever holds both keeps this one in step. */
  ref: Ref<HTMLDivElement>;
}) {
  const source = useHighlightedPostgresSource(text);
  const painted = useMemo(() => withSemanticTokens(source, named), [source, named]);

  return (
    <div className="filter-highlight" aria-hidden="true" ref={ref}>
      {painted.lines.map((line) => (
        <div className="filter-highlight-line" key={line.number}>
          {line.tokens.length === 0
            ? "\u200b"
            : line.tokens.map((token) => (
                <PostgresToken token={token} key={`${line.number}:${token.offset}`} />
              ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Keeps what is painted under a field in step with the field's own scrolling.
 *
 * A field scrolls itself as the caret walks past its edge, or down past its last visible line, and
 * says so through an event. It also scrolls without saying so — when it is given a value longer
 * than it is wide — so the text it holds is what re-runs this, and a text it can no longer scroll
 * puts it back at the start. It moves the paint directly rather than through state: a scroll is
 * not worth a render.
 */
export function useScrollFollower(
  field: RefObject<HTMLTextAreaElement | null>,
  painted: RefObject<HTMLDivElement | null>,
  text: string,
): () => void {
  const follow = useCallback(() => {
    const area = field.current;
    const layer = painted.current;
    if (!area || !layer) return;
    layer.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
  }, [field, painted]);

  useLayoutEffect(() => {
    if (text.length === 0) field.current?.scrollTo(0, 0);
    follow();
  }, [text, follow, field]);

  return follow;
}
