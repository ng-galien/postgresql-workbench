import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installProjectConfiguration,
  readProjectConfiguration,
  updateProjectConfiguration,
} from "./projectConfiguration.js";

describe("project MCP configuration", () => {
  it("refuses a Git reinclusion before writing a token", async () => {
    const root = await mkdtemp(join(tmpdir(), "pgwb-reincluded-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      await writeFile(join(root, ".gitignore"), "!.mcp.json\n");
      await expect(
        installProjectConfiguration(root, "claude", "http://127.0.0.1:7432/mcp", "private-token"),
      ).rejects.toThrow("not effectively ignored");
      await expect(readFile(join(root, ".mcp.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("preserves TOML comments and other servers through installation and port changes", async () => {
    const original = '# Keep this\nmodel = "example"\n[mcp_servers.other]\ncommand = "example"\n';
    const first = await updateProjectConfiguration(
      original,
      "codex",
      "http://127.0.0.1:7432/mcp",
      "token",
    );
    const second = await updateProjectConfiguration(
      first,
      "codex",
      "http://127.0.0.1:7433/mcp",
      "token",
    );
    expect(second.startsWith(original)).toBe(true);
    expect(second.match(/\[mcp_servers.postgresql-workbench\]/gu)).toHaveLength(1);
    expect(second).not.toContain(":7432");
    await expect(
      updateProjectConfiguration(
        '[mcp_servers.postgresql-workbench]\ncommand="custom"',
        "codex",
        "url",
        "token",
      ),
    ).rejects.toThrow("managed elsewhere");
  });
  it("preserves JSON entries, excludes credentials from Git and refuses tracked files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pgwb-config-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      await writeFile(
        join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { other: { command: "other" } } }),
      );
      await installProjectConfiguration(root, "claude", "http://127.0.0.1:7432/mcp", "token");
      const parsed = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
      expect(parsed.mcpServers.other).toEqual({ command: "other" });
      expect(
        (await readProjectConfiguration(root, "claude", "http://127.0.0.1:7432/mcp", "token"))
          .status,
      ).toMatch(/^Installed/u);
      expect(
        execFileSync("git", ["check-ignore", ".mcp.json"], { cwd: root, encoding: "utf8" }).trim(),
      ).toBe(".mcp.json");
      execFileSync("git", ["add", "-f", ".mcp.json"], { cwd: root });
      await expect(installProjectConfiguration(root, "claude", "url", "token")).rejects.toThrow(
        "tracked by Git",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
