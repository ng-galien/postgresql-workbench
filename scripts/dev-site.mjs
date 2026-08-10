import { createReadStream } from "node:fs";
import { stat, watch } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "./build-site.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "dist", "site");
const port = Number.parseInt(process.env.SITE_PORT ?? "4173", 10);
const clients = new Set();
const liveReload = `<script>new EventSource("/__site_reload").onmessage=()=>location.reload()</script>`;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://127.0.0.1:${port}`).pathname);
  const requested = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const resolved = path.resolve(outputDirectory, `.${requested}`);
  return resolved.startsWith(`${outputDirectory}${path.sep}`) ? resolved : undefined;
}

async function respondWithFile(request, response) {
  const file = resolveRequestPath(request.url ?? "/");
  if (!file) {
    response.writeHead(400).end("Invalid path");
    return;
  }

  try {
    const details = await stat(file);
    if (!details.isFile()) {
      throw new Error("Not a file");
    }
  } catch {
    response.writeHead(404).end("Not found");
    return;
  }

  const extension = path.extname(file);
  if (extension === ".html") {
    const chunks = [];
    for await (const chunk of createReadStream(file)) {
      chunks.push(chunk);
    }
    const html = Buffer.concat(chunks).toString("utf8").replace("</body>", `${liveReload}</body>`);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes.get(extension),
    });
    response.end(html);
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  if (request.url === "/__site_reload") {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    response.write("retry: 300\n\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  respondWithFile(request, response).catch((error) => {
    // biome-ignore lint/suspicious/noConsole: The development server must expose request failures to its operator.
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500);
    }
    response.end("Internal server error");
  });
});

let rebuildTimer;
let rebuilding = false;
let rebuildAgain = false;

async function rebuild() {
  if (rebuilding) {
    rebuildAgain = true;
    return;
  }
  rebuilding = true;
  try {
    await buildSite();
    for (const client of clients) {
      client.write(`data: ${Date.now()}\n\n`);
    }
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: A failed rebuild must remain visible while the last successful build stays served.
    console.error("Site rebuild failed; keeping the last successful build.", error);
  } finally {
    rebuilding = false;
    if (rebuildAgain) {
      rebuildAgain = false;
      await rebuild();
    }
  }
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
}

await buildSite();
server.listen(port, "127.0.0.1", () => {
  // biome-ignore lint/suspicious/noConsole: The development command reports the URL that the user should open.
  console.log(`Live site available at http://127.0.0.1:${port}`);
});

const watchedPaths = [
  path.join(repositoryRoot, "site"),
  path.join(repositoryRoot, "docs", "user"),
  path.join(repositoryRoot, "vscode-extension", "media", "marketplace"),
  path.join(repositoryRoot, "vscode-extension", "package.json"),
];

for (const watchedPath of watchedPaths) {
  const watcher = watch(watchedPath, { recursive: true });
  void (async () => {
    for await (const _event of watcher) {
      scheduleRebuild();
    }
  })();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const client of clients) {
      client.end();
    }
    server.close(() => process.exit(0));
  });
}
