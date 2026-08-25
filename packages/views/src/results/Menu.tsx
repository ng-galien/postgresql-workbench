import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * What a menu offers, as data.
 *
 * An entry is named with a verb, not a sentence: a menu is read in a glance, and what it acts on
 * is whatever the reader opened it on. An action that cannot be run says why — the reason is what
 * a reader needs, and a greyed line that explains nothing is a question they cannot answer.
 *
 * Four kinds beside the separator, because a menu in the Workbench does four things: it runs
 * something, it turns something on and off, it puts what it offers under the table it belongs to,
 * and it shows something to read rather than to run — which, for the changes waiting to be applied,
 * carries the one control that takes back what it describes.
 */
export type MenuEntry =
  | {
      kind: "action";
      label: string;
      /** A codicon name, when the action is quicker to recognise than to read. */
      icon?: string;
      /** A second line: what the thing named by the label is. */
      detail?: string;
      /** What the whole line means, for a reader who stops on it. */
      title?: string;
      disabled?: string;
      run(): void;
    }
  | { kind: "check"; label: string; checked: boolean; disabled?: string; run(): void }
  | { kind: "group"; heading?: string; accent?: string; entries: readonly MenuEntry[] }
  /**
   * Something to read rather than to run — and, where what it describes can be taken back, one
   * control to take it. The control is a menu item like any other, so the arrows reach it and
   * Enter runs it: a list a reader can only act on with the pointer is half a list.
   */
  | { kind: "note"; content: ReactNode; dismiss?: { label: string; run(): void } }
  | { kind: "separator" };

/** The entries a reader can act on: what the arrows walk, and what Enter runs. */
type MenuAction = Extract<MenuEntry, { kind: "action" | "check" }>;

/** Where a menu opens: the point a reader asked for it at. */
export interface MenuPoint {
  x: number;
  y: number;
}

/** A menu waiting to be rendered: where it goes, what it offers, and what it is called. */
export interface OpenMenu {
  at: MenuPoint;
  label: string;
  entries: MenuEntry[];
}

const EDGE = 8;

/**
 * One menu, wherever a menu is needed: the ground that dismisses it, the keys that walk it, the
 * edge it must not fall off, and the focus it gives back when it closes.
 *
 * Every surface that offers actions renders this one — a column heading, a cell, the gutter, a
 * toolbar button — so a reader learns the keys once. Which entries appear is the caller's to say
 * and this component's to draw.
 *
 * A menu with a `header` walks differently: the field up there keeps the focus so a reader can go
 * on typing, and the arrows move a highlight over the entries below it rather than the focus. It
 * is the same walk either way — down, up, Home, End, wrapping — and Enter takes what it is on.
 */
export function Menu({
  at,
  label,
  entries,
  header,
  onClose,
}: {
  at: MenuPoint;
  label: string;
  entries: readonly MenuEntry[];
  /** A field above the entries, which keeps the focus while the arrows walk what is below it. */
  header?: ReactNode;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const [placed, setPlaced] = useState<MenuPoint>(at);
  const [highlighted, setHighlighted] = useState(0);
  const walking = header !== undefined;

  const actions = runnableEntries(entries);
  const places = new Map(actions.map((action, index) => [action, index] as const));
  const on = Math.min(highlighted, actions.length - 1);
  /*
   * A different list is a different walk: the highlight goes back to the first entry. What makes
   * it a different list is the labels it holds, joined on something no label can contain.
   */
  const shape = walking ? actions.map((action) => action.label).join("\u0000") : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list's shape is the subject.
  useEffect(() => setHighlighted(0), [shape]);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const x = Math.max(EDGE, Math.min(at.x, window.innerWidth - width - EDGE));
    const y = at.y + height > window.innerHeight - EDGE ? Math.max(EDGE, at.y - height) : at.y;
    /* A menu that already fits where it was asked for is not drawn a second time to say so. */
    setPlaced((current) => (current.x === x && current.y === y ? current : { x, y }));
    /*
     * Whoever holds the focus reads the keys: the field when there is one, the first entry else,
     * and the menu itself when it holds neither. A menu of nothing but text to read still answers
     * to Escape — one a reader can open and not close is worse than one that never opened.
     */
    const first = walking
      ? element.querySelector<HTMLElement>(".menu-header :is(input, textarea, select)")
      : element.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)");
    (first ?? element).focus();
    // The field is the caller's to render; it does not change which point the menu opened at.
  }, [at, walking]);

  const dismiss = useCallback(() => {
    const back = opener.current;
    onClose();
    if (back instanceof HTMLElement) back.focus({ preventScroll: true });
  }, [onClose]);

  const run = useCallback(
    (entry: MenuAction) => {
      /* A checkbox is one of several gestures; an action is the whole gesture, so the menu goes. */
      if (entry.kind === "action") dismiss();
      entry.run();
    },
    [dismiss],
  );

  return (
    <>
      <button type="button" className="menu-backdrop" aria-label="Close menu" onClick={dismiss} />
      <div
        className="menu"
        role="menu"
        aria-label={label}
        ref={menu}
        tabIndex={-1}
        style={{ left: placed.x, top: placed.y }}
        onKeyDown={(event) =>
          walk(event, {
            menu: menu.current,
            dismiss,
            walk: walking
              ? {
                  on,
                  count: actions.length,
                  to: setHighlighted,
                  run: () => actions[on] && run(actions[on]),
                }
              : undefined,
          })
        }
      >
        {header ? <div className="menu-header">{header}</div> : null}
        <MenuLines
          entries={entries}
          places={places}
          highlighted={walking ? on : undefined}
          onHighlight={walking ? setHighlighted : undefined}
          onRun={run}
        />
      </div>
    </>
  );
}

/**
 * What the arrows walk when the menu has a header holding the focus, in the order they are read —
 * groups flattened, refusals left out. A menu without one walks the DOM instead (see `walk`), which
 * is what reaches the control a note carries: give this list a header and that control leaves the
 * walk, so a dismissible note and a filter field do not belong in the same menu until both walks
 * are one.
 */
function runnableEntries(entries: readonly MenuEntry[], into: MenuAction[] = []): MenuAction[] {
  for (const entry of entries) {
    if (entry.kind === "group") runnableEntries(entry.entries, into);
    else if (entry.kind !== "separator" && entry.kind !== "note" && entry.disabled === undefined) {
      into.push(entry);
    }
  }
  return into;
}

interface Drawing {
  places: ReadonlyMap<MenuEntry, number>;
  highlighted: number | undefined;
  onHighlight: ((at: number) => void) | undefined;
  onRun: (entry: MenuAction) => void;
}

function MenuLines({ entries, ...drawing }: { entries: readonly MenuEntry[] } & Drawing) {
  return entries.map((entry, index) => (
    <MenuLine
      entry={entry}
      {...drawing}
      /* An action is known by its label; everything else by where it is in the list it was given in. */
      key={
        entry.kind === "action" || entry.kind === "check" ? entry.label : `${entry.kind}-${index}`
      }
    />
  ));
}

function MenuLine({
  entry,
  places,
  highlighted,
  onHighlight,
  onRun,
}: { entry: MenuEntry } & Drawing) {
  if (entry.kind === "separator") return <hr className="menu-separator" />;
  if (entry.kind === "note") {
    return (
      <div className="menu-note">
        {entry.content}
        {entry.dismiss ? (
          <button
            type="button"
            role="menuitem"
            className="menu-note-dismiss codicon codicon-close"
            title={entry.dismiss.label}
            aria-label={entry.dismiss.label}
            /* The menu stays open: taking several changes out of the list is one gesture, and a
               list with nothing left in it closes itself. */
            onClick={() => entry.dismiss?.run()}
          />
        ) : null}
      </div>
    );
  }
  if (entry.kind === "group") {
    return (
      <div
        className={`menu-group${entry.accent ? " accented" : ""}`}
        style={entry.accent ? ({ "--menu-accent": entry.accent } as CSSProperties) : undefined}
      >
        {entry.heading ? <div className="menu-heading">{entry.heading}</div> : null}
        <MenuLines
          entries={entry.entries}
          places={places}
          highlighted={highlighted}
          onHighlight={onHighlight}
          onRun={onRun}
        />
      </div>
    );
  }

  const at = places.get(entry);
  const lit = at !== undefined && at === highlighted;
  /* A checkbox says on and off in the one place it belongs: its role, and its own pictogram. */
  const checkable =
    entry.kind === "check"
      ? ({ role: "menuitemcheckbox", "aria-checked": entry.checked } as const)
      : ({ role: "menuitem" } as const);
  const icon =
    entry.kind === "check" ? (entry.checked ? "pass-filled" : "circle-large-outline") : entry.icon;
  const detail = entry.kind === "action" ? entry.detail : undefined;
  return (
    <button
      type="button"
      {...checkable}
      className={`menu-item${detail ? " detailed" : ""}${lit ? " highlighted" : ""}`}
      disabled={entry.disabled !== undefined}
      title={entry.disabled ?? (entry.kind === "action" ? entry.title : undefined)}
      /* The one the arrows are on scrolls itself into view as they move; nothing else is asked. */
      ref={lit ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
      onMouseEnter={at === undefined || !onHighlight ? undefined : () => onHighlight(at)}
      onClick={() => onRun(entry)}
    >
      {icon ? <span className={`codicon codicon-${icon}`} aria-hidden="true" /> : null}
      <span className="menu-label">{entry.label}</span>
      {detail ? <span className="menu-detail">{detail}</span> : null}
    </button>
  );
}

/** The walk a menu with a header does: over a highlight, without taking the focus off the field. */
interface Highlighting {
  on: number;
  count: number;
  to(at: number): void;
  run(): void;
}

/**
 * Where a key lands in a list of `count` entries when the walk is on `from`. One arithmetic, so
 * the two walks below cannot disagree about what Home means or where the end wraps to.
 */
function nextInWalk(key: string, from: number, count: number): number | undefined {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : undefined;
  if (step === undefined) return undefined;
  return from < 0 ? (step > 0 ? 0 : count - 1) : (from + step + count) % count;
}

/**
 * The keys a menu answers to. The arrows walk what can be run and step over what cannot; Escape
 * and Tab leave, because a menu that keeps the focus is a menu a reader is stuck in.
 *
 * Where they land is the only difference a header makes: on the highlight when there is a field
 * to go on typing in, on the focus itself when there is not.
 */
function walk(
  event: React.KeyboardEvent<HTMLDivElement>,
  {
    menu,
    dismiss,
    walk: highlighting,
  }: { menu: HTMLDivElement | null; dismiss: () => void; walk?: Highlighting },
): void {
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    dismiss();
    return;
  }
  if (highlighting && event.key === "Enter") {
    event.preventDefault();
    highlighting.run();
    return;
  }

  if (highlighting) {
    const next = nextInWalk(event.key, highlighting.on, highlighting.count);
    if (next === undefined || highlighting.count === 0) return;
    event.preventDefault();
    highlighting.to(next);
    return;
  }

  const items = [
    ...(menu?.querySelectorAll<HTMLButtonElement>(
      "[role=menuitem]:not(:disabled), [role=menuitemcheckbox]:not(:disabled)",
    ) ?? []),
  ];
  const next = nextInWalk(
    event.key,
    items.indexOf(document.activeElement as HTMLButtonElement),
    items.length,
  );
  if (next === undefined || items.length === 0) return;
  event.preventDefault();
  items[next]?.focus();
}

/** Where a menu opens when a control asks for one: under it, aligned on its leading edge. */
export function anchorUnder(control: Element): MenuPoint {
  const bounds = control.getBoundingClientRect();
  return { x: bounds.left, y: bounds.bottom + 4 };
}

/**
 * Holding one open menu at a time, for a surface that offers several — a grid where every cell,
 * every row and every heading has its own. The pointer's own menu is refused so this one takes its
 * place, and a second request replaces the first rather than stacking on it.
 */
export function useMenu(): {
  menu: OpenMenu | undefined;
  /** From a point: under the control that opened it, or where a heading was clicked. */
  openAt(at: MenuPoint, menu: Omit<OpenMenu, "at">): void;
  /** From the gesture that asks for one, whose own menu is refused so this one takes its place. */
  open(event: ReactMouseEvent, menu: Omit<OpenMenu, "at">): void;
  close(): void;
} {
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined);
  const openAt = (at: MenuPoint, opened: Omit<OpenMenu, "at">) => setMenu({ ...opened, at });
  return {
    menu,
    openAt,
    open: (event, opened) => {
      event.preventDefault();
      event.stopPropagation();
      openAt({ x: event.clientX, y: event.clientY }, opened);
    },
    close: () => setMenu(undefined),
  };
}
