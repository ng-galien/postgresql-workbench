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

/** A menu narrowed by a field: the proposals sit under it, grouped the way they are read. */
function openWithField(run = () => {}, onClose = () => {}) {
  return render(
    <Menu
      at={{ x: 10, y: 10 }}
      label="Columns and tables to add"
      header={<input placeholder="Filter" />}
      entries={[
        {
          kind: "group",
          heading: "shop.product",
          entries: [
            { kind: "action", label: "brand_id", detail: "shop.brand", run },
            { kind: "action", label: "name", detail: "text", run },
          ],
        },
        {
          kind: "group",
          heading: "shop",
          entries: [{ kind: "action", label: "shop.order_line", detail: "product_id", run }],
        },
      ]}
      onClose={onClose}
    />,
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

  it("turns what is on and off on, and stays open while it is being done", () => {
    const toggled: string[] = [];
    const onClose = vi.fn();
    open(
      [
        { kind: "group", heading: "shop.product", entries: [] },
        { kind: "check", label: "name", checked: true, run: () => toggled.push("name") },
        { kind: "check", label: "price", checked: false, run: () => toggled.push("price") },
      ],
      onClose,
    );

    expect(
      screen.getByRole("menuitemcheckbox", { name: "name" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "price" }));

    // Hiding several columns is one gesture, so the menu is still there for the next one.
    expect(toggled).toEqual(["price"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("walks a highlight under the field, and leaves the typing where it is", () => {
    openWithField();
    const menu = screen.getByRole("menu");
    const field = screen.getByPlaceholderText("Filter");
    expect(document.activeElement).toBe(field);

    const highlighted = () =>
      screen.getAllByRole("menuitem").find((item) => item.className.includes("highlighted"));
    expect(highlighted()?.textContent).toBe("brand_idshop.brand");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    // The walk crosses the groups it is drawn in, and wraps rather than stopping.
    expect(highlighted()?.textContent).toBe("shop.order_lineproduct_id");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(highlighted()?.textContent).toBe("brand_idshop.brand");
    // Whatever the arrows do, the field keeps the focus: a reader is still typing in it.
    expect(document.activeElement).toBe(field);
  });

  it("takes what the highlight is on when Enter is pressed", () => {
    const ran = vi.fn();
    const onClose = vi.fn();
    openWithField(ran, onClose);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "End" });
    fireEvent.keyDown(menu, { key: "Enter" });

    expect(ran).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows what is only to be read", () => {
    open([
      {
        kind: "group",
        heading: "2 changes waiting to be applied",
        entries: [{ kind: "note", content: <span>city → Saint-Nazaire</span> }],
      },
    ]);

    expect(screen.getByText("2 changes waiting to be applied")).toBeTruthy();
    expect(screen.getByText("city → Saint-Nazaire")).toBeTruthy();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
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
