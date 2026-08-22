import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
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
 */
export type MenuEntry =
  | { kind: "action"; label: string; disabled?: string; run(): void }
  | { kind: "separator" };

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
 */
export function Menu({
  at,
  label,
  entries,
  onClose,
}: {
  at: MenuPoint;
  label: string;
  entries: readonly MenuEntry[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const [placed, setPlaced] = useState<MenuPoint>(at);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPlaced({
      x: Math.max(EDGE, Math.min(at.x, window.innerWidth - width - EDGE)),
      y: at.y + height > window.innerHeight - EDGE ? Math.max(EDGE, at.y - height) : at.y,
    });
    element.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, [at]);

  const dismiss = useCallback(() => {
    const back = opener.current;
    onClose();
    if (back instanceof HTMLElement) back.focus({ preventScroll: true });
  }, [onClose]);

  return (
    <>
      <button type="button" className="menu-backdrop" aria-label="Close menu" onClick={dismiss} />
      <div
        className="menu"
        role="menu"
        aria-label={label}
        ref={menu}
        style={{ left: placed.x, top: placed.y }}
        onKeyDown={(event) => walk(event, menu.current, dismiss)}
      >
        {entries.map((entry, index) => (
          <MenuLine
            entry={entry}
            onRun={dismiss}
            key={entry.kind === "separator" ? `separator-${index}` : entry.label}
          />
        ))}
      </div>
    </>
  );
}

function MenuLine({ entry, onRun }: { entry: MenuEntry; onRun: () => void }) {
  if (entry.kind === "separator") return <hr className="menu-separator" />;
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      disabled={entry.disabled !== undefined}
      title={entry.disabled}
      onClick={() => {
        onRun();
        entry.run();
      }}
    >
      {entry.label}
    </button>
  );
}

/**
 * The keys a menu answers to. The arrows walk what can be run and step over what cannot; Escape
 * and Tab leave, because a menu that keeps the focus is a menu a reader is stuck in.
 */
function walk(
  event: React.KeyboardEvent<HTMLDivElement>,
  menu: HTMLDivElement | null,
  dismiss: () => void,
): void {
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    dismiss();
    return;
  }
  const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
  const step = steps[event.key];
  const items = [
    ...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []),
  ];
  if (items.length === 0) return;
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    (event.key === "Home" ? items[0] : items.at(-1))?.focus();
    return;
  }
  if (step === undefined) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    current < 0
      ? step > 0
        ? 0
        : items.length - 1
      : (current + step + items.length) % items.length;
  items[next]?.focus();
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
