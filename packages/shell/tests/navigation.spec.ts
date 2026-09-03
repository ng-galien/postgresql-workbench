import { expect, test } from "@playwright/test";
import { MonacoEditor } from "./harness.js";

test("keeps Data View, Cockpit, and Sources one tab away", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.request.post("/reset");
  await page.goto("/");
  await expect(page).toHaveURL(/\/data-view$/u);

  const tabs = page.getByRole("navigation", { name: "Workbench views" });
  await expect(tabs.getByRole("link")).toHaveText(["Data View", "Cockpit", "Sources"]);
  await expect(tabs.getByRole("link", { name: "Data View" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator(".monaco-editor")).toHaveCount(1);
  await expect(page.locator(".monaco-editor")).toHaveClass(/standalone/u);

  await tabs.getByRole("link", { name: "Sources" }).click();
  await expect(page).toHaveURL(/\/sources$/u);
  await expect(page.getByRole("navigation", { name: "Virtual sources" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sources" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".monaco-editor")).toHaveCount(1);
  await expect(page.locator(".monaco-editor")).toHaveClass(/standalone/u);
  await expect(page.getByRole("textbox", { name: "PostgreSQL source code" })).toHaveCount(1);
  const sourceEditor = new MonacoEditor(page, "PostgreSQL source code");
  const keyword = await sourceEditor.presentationColour("--pgw-syntax-keyword");
  const type = await sourceEditor.presentationColour("--pgw-syntax-type");
  const string = await sourceEditor.presentationColour("--pgw-syntax-string");
  // These pieces cross the complete LSP path: SQL wrapper, PL/pgSQL body and dollar delimiter.
  await expect.poll(() => sourceEditor.tokenColours("CREATE")).toEqual([keyword]);
  await expect.poll(() => sourceEditor.tokenColours("BEGIN")).toEqual([keyword]);
  await expect.poll(() => sourceEditor.tokenColours("text")).toEqual([type]);
  await expect.poll(() => sourceEditor.tokenColours("$function$")).toEqual([string]);

  await page.getByRole("link", { name: "Cockpit" }).click();
  await expect(page).toHaveURL(/\/cockpit$/u);
  await expect(page.getByRole("link", { name: "Cockpit" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "PostgreSQL graph canvas" })).toBeVisible();
  const graphCard = page.locator("[data-graph-card]").first();
  await expect(graphCard).toBeVisible();
  await expect(page.getByText(/\d+ objects · \d+ links/u)).toBeVisible();

  await graphCard.getByRole("button", { name: "DDL" }).click();
  await expect.poll(() => pageErrors).toEqual([]);
  await expect(page.getByRole("complementary", { name: "PostgreSQL source inset" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "PostgreSQL source preview" })).toHaveCount(1);
  await expect(page.locator(".monaco-editor")).toHaveCount(1);
  await expect(page.locator(".monaco-editor")).toHaveClass(/standalone/u);

  await page.getByRole("link", { name: "Data View" }).click();
  await expect(page).toHaveURL(/\/data-view$/u);
  await expect(page.getByText("The query is empty")).toBeVisible();
  await expect(page.locator(".monaco-editor")).toHaveCount(1);
  await expect(page.locator(".monaco-editor")).toHaveClass(/standalone/u);
});
