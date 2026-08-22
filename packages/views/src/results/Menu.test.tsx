// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, type MenuEntry } from "./Menu.js";

afterEach(cleanup);

function entries(run = () => {}): MenuEntry[] {
  return [
    { kind: "action", label: "Filter", run },
    { kind: "action", label: "Exclude", disabled: "This value cannot be compared.", run },
    { kind: "separator" },
    { kind: "action", label: "Copy", run },
  ];
}

function open(given: MenuEntry[] = entries(), onClose = () => {}) {
  return render(
    <Menu at={{ x: 10, y: 10 }} label="Actions for this cell" entries={given} onClose={onClose} />,
  );
}

describe("Menu", () => {
  it("offers what can be run, and says why the rest cannot", () => {
    open();
    expect(screen.getByRole("menu", { name: "Actions for this cell" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Filter",
      "Exclude",
      "Copy",
    ]);
    const refused = screen.getByRole("menuitem", { name: "Exclude" });
    expect(refused.hasAttribute("disabled")).toBe(true);
    expect(refused.getAttribute("title")).toBe("This value cannot be compared.");
  });

  it("opens on the first thing a reader can do", () => {
    open();
    expect(document.activeElement?.textContent).toBe("Filter");
  });

  it("walks what can be run and steps over what cannot", () => {
    open();
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // `Exclude` is refused, so the walk lands past it.
    expect(document.activeElement?.textContent).toBe("Copy");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Filter");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Copy");
  });

  it("runs an entry once, and closes before it runs", () => {
    const order: string[] = [];
    open(
      entries(() => order.push("ran")),
      () => order.push("closed"),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Filter" }));
    expect(order).toEqual(["closed", "ran"]);
  });

  it("leaves on Escape, on Tab, and on a click outside", () => {
    for (const leave of [
      (menu: HTMLElement) => fireEvent.keyDown(menu, { key: "Escape" }),
      (menu: HTMLElement) => fireEvent.keyDown(menu, { key: "Tab" }),
      () => fireEvent.click(screen.getByRole("button", { name: "Close menu" })),
    ]) {
      const onClose = vi.fn();
      open(entries(), onClose);
      leave(screen.getByRole("menu"));
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});
