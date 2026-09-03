export interface WorkbenchNavigationEntry<Id extends string = string> {
  id: Id;
  href: string;
  label: string;
}

export function WorkbenchNavigation<Id extends string>(props: {
  activeId: Id;
  entries: readonly WorkbenchNavigationEntry<Id>[];
}) {
  return (
    <nav className="workbench-navigation" aria-label="Workbench views">
      {props.entries.map((entry) => (
        <a
          className="workbench-navigation__entry"
          href={entry.href}
          aria-current={entry.id === props.activeId ? "page" : undefined}
          key={entry.id}
        >
          {entry.label}
        </a>
      ))}
    </nav>
  );
}
