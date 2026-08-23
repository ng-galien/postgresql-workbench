import type { Page } from "@playwright/test";

export type PageProvider = Page | (() => Page);

export function currentPage(provider: PageProvider): Page {
  return typeof provider === "function" ? provider() : provider;
}
