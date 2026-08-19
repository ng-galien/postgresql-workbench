import type { ReactNode } from "react";

/** A toolbar control that shows a codicon, and optionally a short text beside it. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
  text,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
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
      onClick={onClick}
    >
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      {text !== undefined ? <span className="icon-button-text">{text}</span> : null}
    </button>
  );
}
