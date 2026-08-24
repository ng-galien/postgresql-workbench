import type { MouseEvent as ReactMouseEvent, ReactNode, Ref } from "react";

/** A toolbar control that shows a codicon, and optionally a short text beside it. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
  expanded,
  controls,
  popup,
  buttonRef,
  text,
}: {
  icon: string;
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  primary?: boolean;
  /** Whether the menu this control opens is showing — given only by a control that opens one. */
  expanded?: boolean;
  controls?: string;
  popup?: "menu" | "dialog" | false;
  buttonRef?: Ref<HTMLButtonElement>;
  /** Optional short text shown next to the icon. */
  text?: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      className={`icon-button${primary ? " primary" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      {...(expanded === undefined
        ? {}
        : {
            ...(popup === false ? {} : { "aria-haspopup": popup ?? ("menu" as const) }),
            "aria-expanded": expanded,
            ...(controls ? { "aria-controls": controls } : {}),
          })}
      onClick={onClick}
    >
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      {text !== undefined ? <span className="icon-button-text">{text}</span> : null}
    </button>
  );
}
