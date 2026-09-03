import type { PropsWithChildren } from "react";
import {
  WorkbenchNavigation,
  type WorkbenchNavigationEntry,
} from "../../views/src/navigation/WorkbenchNavigation.js";

export type ShellRoute = "data-view" | "cockpit" | "sources";

const SHELL_NAVIGATION = [
  { id: "data-view", href: "/data-view", label: "Data View" },
  { id: "cockpit", href: "/cockpit", label: "Cockpit" },
  { id: "sources", href: "/sources", label: "Sources" },
] as const satisfies readonly WorkbenchNavigationEntry<ShellRoute>[];

export function ShellPage({ active, children }: PropsWithChildren<{ active: ShellRoute }>) {
  return (
    <div className="shell-page">
      <WorkbenchNavigation activeId={active} entries={SHELL_NAVIGATION} />
      <div className="shell-page__content">{children}</div>
    </div>
  );
}
