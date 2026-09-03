// biome-ignore-all lint/suspicious/noConsole: A developer harness reports where it is listening.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { WebSocketServer } from "ws";

/**
 * Serves the Data View in a browser and bridges it to the real Extension Host logic: the page
 * POSTs what the view would post to VS Code, and reads what the host answers over an event stream.
 * The wire is different; everything on either side of it is the product's.
 */
const PORT = Number(process.env.PGWB_DEV_PORT ?? 5175);
const CONNECTION = {
  host: process.env.PGWB_DEV_HOST ?? "localhost",
  port: Number(process.env.PGWB_DEV_PGPORT ?? 5434),
  user: process.env.PGWB_DEV_USER ?? "postgres",
  password: process.env.PGWB_DEV_PASSWORD ?? "postgres",
  database: process.env.PGWB_DEV_DATABASE ?? "demo",
};
// The shell opens on an empty query, the way the product opens a Data View with nothing in it:
// the reader adds the first table and composition starts there. Name one to skip that step.
const RELATION =
  process.env.PGWB_DEV_SCHEMA && process.env.PGWB_DEV_RELATION
    ? { schema: process.env.PGWB_DEV_SCHEMA, name: process.env.PGWB_DEV_RELATION }
    : undefined;

// The repository writes `.js` in its specifiers, which Node cannot resolve to `.ts`; esbuild can.
const OUT = new URL("../../node_modules/.pgwb-shell/", import.meta.url).pathname;
await esbuild.build({
  entryPoints: [new URL("src/hosts.ts", import.meta.url).pathname],
  bundle: true,
  outfile: `${OUT}host.cjs`,
  // CommonJS, because the Code Moniker client resolves its runtime through `__filename`.
  format: "cjs",
  platform: "node",
  target: "es2022",
  packages: "external",
});
const nodeRequire = createRequire(import.meta.url);
const { startCockpitHost, startDataViewHost, startSourcesHost, startSqlLanguageServerSession } =
  nodeRequire(`${OUT}host.cjs`);

/** One response stream per view: a page subscribes to its own, a rebuild reloads every one. */
const channels = new Map([
  ["data-view", new Set()],
  ["cockpit", new Set()],
  ["sources", new Set()],
]);
const emitTo = (channel) => (response) => {
  const frame = `data: ${JSON.stringify(response)}\n\n`;
  for (const client of channels.get(channel)) client.write(frame);
};
const emit = emitTo("data-view");

const host = await startDataViewHost({
  connection: CONNECTION,
  ...(RELATION ? { relation: RELATION } : {}),
  ...(process.env.PGWB_CODE_MONIKER_RUNTIME
    ? { codeMonikerRuntimePath: process.env.PGWB_CODE_MONIKER_RUNTIME }
    : {}),
  navigationDelayMs: Number(process.env.PGWB_NAVIGATION_DELAY_MS ?? 0),
  emit,
});

/** Reloads the page the moment the view is rebuilt, so a change is looked at rather than restarted. */
const liveReload = {
  name: "live-reload",
  setup(build) {
    let first = true;
    build.onEnd((result) => {
      if (first) {
        first = false;
        return;
      }
      if (result.errors.length > 0) {
        emit({
          type: "data-view/notice",
          message: `The view did not build: ${result.errors[0].text}`,
          severity: "error",
        });
        return;
      }
      for (const set of channels.values())
        for (const client of set) client.write("event: reload\ndata: {}\n\n");
      console.log("view rebuilt — reloading the page");
    });
  },
};

const bundle = await esbuild.context({
  entryPoints: [
    { in: new URL("browser/index.tsx", import.meta.url).pathname, out: "data-view" },
    { in: new URL("browser/sources.tsx", import.meta.url).pathname, out: "sources" },
    { in: new URL("browser/cockpit.tsx", import.meta.url).pathname, out: "cockpit" },
  ],
  bundle: true,
  outdir: OUT,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "text", ".ttf": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  sourcemap: true,
  plugins: [liveReload],
});
await bundle.watch();

const editorWorker = await esbuild.context({
  entryPoints: [
    {
      in: nodeRequire.resolve("@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js"),
      out: "editor.worker",
    },
  ],
  bundle: true,
  outdir: OUT,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
await editorWorker.watch();

/** The HTTP shell serves resources and routes; React owns every visible application surface. */
const page = (title, script) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><div id="root"></div><script src="${script}"></script></body></html>`;

const sources = await startSourcesHost({
  connection: CONNECTION,
  emit: emitTo("sources"),
});
const cockpit = await startCockpitHost({
  connection: CONNECTION,
  ...(process.env.PGWB_CODE_MONIKER_RUNTIME
    ? { codeMonikerRuntimePath: process.env.PGWB_CODE_MONIKER_RUNTIME }
    : {}),
  emit: emitTo("cockpit"),
});

const httpServer = createServer(async (request, response) => {
  const stream = /^\/(data-view|cockpit|sources)\/responses$/.exec(request.url ?? "");
  if (stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    channels.get(stream[1]).add(response);
    request.on("close", () => channels.get(stream[1]).delete(response));
    response.flushHeaders();
    response.write(": connected\n\n");
    return;
  }
  if (request.url === "/cockpit/request" && request.method === "POST") {
    const body = await new Blob(await Array.fromAsync(request)).text();
    response.writeHead(204).end();
    const message = JSON.parse(body);
    console.log(`→ ${message.type}`);
    await cockpit.handle(message).catch((error) => {
      emitTo("cockpit")({ type: "scopeError", message: String(error) });
    });
    return;
  }
  if (request.url === "/sources/request" && request.method === "POST") {
    const body = await new Blob(await Array.fromAsync(request)).text();
    response.writeHead(204).end();
    const message = JSON.parse(body);
    console.log(`→ ${message.type}`);
    await sources.handle(message).catch((error) => {
      emitTo("sources")({ type: "sources/notice", message: String(error), severity: "error" });
    });
    return;
  }
  if (request.url === "/reset" && request.method === "POST") {
    await host.reset();
    response.writeHead(204).end();
    return;
  }
  if (request.url === "/data-view/request" && request.method === "POST") {
    const body = await new Blob(await Array.fromAsync(request)).text();
    response.writeHead(204).end();
    const message = JSON.parse(body);
    // A harness that cannot say what it was asked is a harness that cannot be debugged.
    console.log(`→ ${message.type}`);
    if (process.env.SHELL_REQUEST_LOG)
      (await import("node:fs")).appendFileSync(
        process.env.SHELL_REQUEST_LOG,
        `${JSON.stringify(message)}\n`,
      );
    await host.handle(message).catch((error) => {
      emit({ type: "data-view/notice", message: String(error), severity: "error" });
    });
    return;
  }
  if (/^\/(data-view|sources|cockpit)\.js(\.map)?$/.test(request.url ?? "")) {
    const { readFile } = await import("node:fs/promises");
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(await readFile(`${OUT}${request.url.slice(1)}`));
    return;
  }
  if (request.url === "/editor.worker.js") {
    const { readFile } = await import("node:fs/promises");
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(await readFile(`${OUT}editor.worker.js`));
    return;
  }
  if (request.url === "/data-view" || request.url?.startsWith("/data-view?")) {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Data View — shell", "/data-view.js"));
    return;
  }
  if (request.url === "/sources" || request.url?.startsWith("/sources?")) {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Sources — shell", "/sources.js"));
    return;
  }
  if (request.url === "/cockpit" || request.url?.startsWith("/cockpit?")) {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Cockpit — shell", "/cockpit.js"));
    return;
  }
  response.writeHead(302, { location: "/data-view" }).end();
});

const languageServerSockets = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  if (request.url !== "/sql-language-server") {
    socket.destroy();
    return;
  }
  languageServerSockets.handleUpgrade(request, socket, head, (webSocket) => {
    startSqlLanguageServerSession(webSocket, host.authoring);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `PostgreSQL Workbench shell on http://localhost:${PORT} — ${RELATION ? `${RELATION.schema}.${RELATION.name}` : "empty"} of ${CONNECTION.database}`,
  );
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of languageServerSockets.clients) socket.terminate();
  httpServer.closeAllConnections();
  await Promise.allSettled([cockpit.dispose(), sources.dispose(), host.dispose()]);
  await bundle.dispose();
  await editorWorker.dispose();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
