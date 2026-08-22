import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

/** A toolbar control that shows a codicon, and optionally a short text beside it. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
  expanded,
  text,
}: {
  icon: string;
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  primary?: boolean;
  /** Whether the menu this control opens is showing — given only by a control that opens one. */
  expanded?: boolean;
  /** Optional short text shown next to the icon. */
  text?: ReactNode;
}) {
  return (
    <button
      className={`icon-button${primary ? " primary" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      {...(expanded === undefined
        ? {}
        : { "aria-haspopup": "menu" as const, "aria-expanded": expanded })}
      onClick={onClick}
    >
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      {text !== undefined ? <span className="icon-button-text">{text}</span> : null}
    </button>
  );
}
