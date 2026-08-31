import { useEffect, useMemo, useState } from "react";
import { type WorkbenchMonacoTheme, workbenchMonacoTheme } from "./theme.js";

/** Reprojects host-overridable CSS roles whenever the embedding host changes its appearance. */
export function useWorkbenchMonacoTheme(themeRoot: Element): WorkbenchMonacoTheme {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let frame: number | undefined;
    const refresh = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setRevision((current) => current + 1);
      });
    };
    const observer = new MutationObserver(refresh);
    const observed = new Set<Element>([themeRoot, document.documentElement]);
    if (document.body) observed.add(document.body);
    for (const element of observed) {
      observer.observe(element, { attributes: true, attributeFilter: ["class", "style"] });
    }
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [themeRoot]);

  return useMemo(() => {
    // Reading the revision binds the projection to host appearance mutations.
    void revision;
    return workbenchMonacoTheme(themeRoot);
  }, [revision, themeRoot]);
}
