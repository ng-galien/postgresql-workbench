import { describe, expect, it } from "vitest";
import { followableAddress, followLinkRequest, isFollowLinkRequest } from "./followLink.js";

describe("what a host may open on a view's word", () => {
  it("takes an ordinary web address", () => {
    expect(followableAddress("https://example.test/a?b=c#d")).toBe("https://example.test/a?b=c#d");
    expect(followableAddress("  http://example.test  ")).toBe("http://example.test");
  });

  it("refuses every scheme a database value could otherwise reach", () => {
    for (const refused of [
      "file:///etc/passwd",
      "command:workbench.action.terminal.new",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vscode://ng-galien.postgresql-workbench/",
      "//example.test",
      "example.test",
      "",
    ]) {
      expect(followableAddress(refused), refused).toBeUndefined();
    }
  });

  it("refuses an address with something else written beside it", () => {
    expect(followableAddress("see https://example.test for more")).toBeUndefined();
  });
});

describe("the request a view sends", () => {
  it("is recognised by a host, and nothing else is", () => {
    expect(isFollowLinkRequest(followLinkRequest("https://example.test"))).toBe(true);
    expect(isFollowLinkRequest({ type: "follow-link" })).toBe(false);
    expect(isFollowLinkRequest({ type: "data-view/refresh" })).toBe(false);
    expect(isFollowLinkRequest(null)).toBe(false);
    expect(isFollowLinkRequest("follow-link")).toBe(false);
  });
});
