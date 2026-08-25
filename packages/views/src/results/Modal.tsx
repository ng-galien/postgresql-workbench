import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * A dialog over the view: a titled panel and the ground behind it. Escape and the ground both
 * dismiss it, and focus moves into the panel when it opens so a keyboard reader is not left
 * behind on the control that opened it.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    panel.current?.focus();
    return () => opener?.focus();
  }, []);

  const keepFocusInside = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const current = panel.current;
    if (!current) return;
    const focusable = [
      ...current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      current.focus();
    } else if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-ground">
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the panel takes focus when it opens.
        tabIndex={0}
        onKeyDown={keepFocusInside}
      >
        <header className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="icon-button" title="Close" onClick={onClose}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>
        {description ? <p className="modal-description">{description}</p> : null}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
