import { useEffect, useRef, useState } from "react";

/** Whether the last copy worked, for as long as it is worth saying so. */
export type ClipboardCopyState = "idle" | "copied" | "error";

/** How long the answer stays on screen: long enough to read, short enough not to be in the way. */
const SAID_FOR_MS = 1_200;

/**
 * Putting something on the clipboard, and saying whether it got there.
 *
 * A copy gives no sign of having happened — the page looks exactly as it did — so every control
 * that offers one has to say so itself, and they all say it the same way: for a moment, in place
 * of the label, and out loud for a reader who is not looking at it.
 */
export function useClipboardCopy(): {
  state: ClipboardCopyState;
  copy: (text: string) => void;
} {
  const [state, setState] = useState<ClipboardCopyState>("idle");
  const timer = useRef<number>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );
  return {
    state,
    copy(text) {
      const say = (said: ClipboardCopyState) => {
        if (timer.current !== undefined) window.clearTimeout(timer.current);
        setState(said);
        timer.current = window.setTimeout(() => setState("idle"), SAID_FOR_MS);
      };
      Promise.resolve(navigator.clipboard?.writeText(text))
        .then(() => say("copied"))
        .catch(() => say("error"));
    },
  };
}
