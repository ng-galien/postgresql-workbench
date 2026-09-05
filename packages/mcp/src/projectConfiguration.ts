import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve } from "node:path";
import { promisify } from "node:util";

export type McpClient = "codex" | "claude";
export const MCP_NAME = "postgresql-workbench";
export const clientPaths = { codex: ".codex/config.toml", claude: ".mcp.json" } as const;
const begin = "# Workbench MCP start";
const end = "# Workbench MCP end";
const managed = /# Workbench MCP start\n[\s\S]*?# Workbench MCP end\n?/u;
const run = promisify(execFile);
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid client configuration object.");
  return value as ObjectValue;
}

export async function readProjectConfiguration(
  root: string,
  client: McpClient,
  url: string,
  token: string,
) {
  const path = join(root, clientPaths[client]);
  try {
    const { parse } = await import("smol-toml");
    const text = await readFile(path, "utf8");
    const data = object(client === "codex" ? parse(text) : JSON.parse(text));
    const raw = object((client === "codex" ? data.mcp_servers : data.mcpServers) ?? {})[MCP_NAME];
    if (!raw) return { client, path, status: "Not installed" };
    const entry = object(raw);
    if (client === "codex" && entry.enabled === false)
      return { client, path, status: "Disabled in project configuration" };
    const headers = object((client === "codex" ? entry.http_headers : entry.headers) ?? {});
    return {
      client,
      path,
      status:
        entry.url === url && headers?.Authorization === `Bearer ${token}`
          ? "Installed · client approval not checked"
          : "Different configuration",
    };
  } catch (error) {
    return {
      client,
      path,
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "Not installed"
          : "Invalid or unreadable configuration",
    };
  }
}

/** Preserve every other client entry. Only our marked TOML block or matching HTTP entry is updated. */
export async function updateProjectConfiguration(
  text: string,
  client: McpClient,
  url: string,
  token: string,
): Promise<string> {
  const { parse } = await import("smol-toml");
  const data = object(text.trim() ? (client === "codex" ? parse(text) : JSON.parse(text)) : {});
  const servers = object((client === "codex" ? data.mcp_servers : data.mcpServers) ?? {});
  const current = servers[MCP_NAME] ? object(servers[MCP_NAME]) : undefined;
  if (
    current &&
    (client === "codex"
      ? !managed.test(text)
      : object(current.headers ?? {}).Authorization !== `Bearer ${token}`)
  )
    throw new Error(
      "An existing Workbench configuration is managed elsewhere. Edit it in your client before installing here.",
    );
  if (client === "codex") {
    const block = `${begin}\n[mcp_servers.postgresql-workbench]\nurl = ${JSON.stringify(url)}\nenabled = true\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n${end}\n`;
    const result = managed.test(text)
      ? text.replace(managed, block)
      : `${text}${text.endsWith("\n") || !text ? "" : "\n"}\n${block}`;
    parse(result);
    return result;
  }
  data.mcpServers = {
    ...servers,
    [MCP_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Configs contain a local bearer token: do not follow links, overwrite tracked files, or stage secrets. */
export async function installProjectConfiguration(
  root: string,
  client: McpClient,
  url: string,
  token: string,
) {
  const relative = clientPaths[client];
  if (!relative) throw new Error("Unknown MCP client.");
  const path = join(root, relative);
  for (const entry of [dirname(path), path]) {
    const stat = await lstat(entry).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat?.isSymbolicLink())
      throw new Error("MCP configuration paths must not be symbolic links.");
  }
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  const updated = await updateProjectConfiguration(text, client, url, token);
  const repository = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root }).catch(
    () => undefined,
  );
  if (repository) {
    const tracked = await run("git", ["ls-files", "--", relative], { cwd: root });
    if (tracked.stdout.trim())
      throw new Error(
        "This configuration is tracked by Git. Workbench will not put a local access token in a tracked file.",
      );
    const excludeResult = await run("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: root,
    });
    const exclude = resolve(root, excludeResult.stdout.trim());
    const existing = await readFile(exclude, "utf8").catch(() => "");
    const prefix = relativePath(await realpath(repository.stdout.trim()), await realpath(root));
    const ignored = `/${join(prefix, relative)
      .replaceAll("\\", "/")
      .replace(/([*?[\] ])/gu, "\\$1")}`;
    await mkdir(dirname(exclude), { recursive: true });
    if (!existing.split("\n").includes(ignored))
      await writeFile(exclude, `${existing}\n${ignored}\n`);
    const ignoredByGit = await run("git", ["check-ignore", "--quiet", "--", relative], {
      cwd: root,
    }).then(
      () => true,
      () => false,
    );
    if (!ignoredByGit)
      throw new Error(
        "This configuration is not effectively ignored by Git. Remove its reinclusion rule before installing MCP.",
      );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, updated, {
    mode: 0o600,
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  });
  await chmod(path, 0o600);
}
