// biome-ignore-all lint/suspicious/noConsole: A developer harness reports where it is listening.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

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
const { startDataViewHost, startSourcesHost } = createRequire(import.meta.url)(`${OUT}host.cjs`);

// The language server the shell drives: the same source the extension ships, built the same way.
await esbuild.build({
  entryPoints: [new URL("../sql/src/languageServer/server.ts", import.meta.url).pathname],
  bundle: true,
  outfile: `${OUT}sql-authoring-server.cjs`,
  format: "cjs",
  platform: "node",
  target: "es2022",
  packages: "external",
});

/** One response stream per view: a page subscribes to its own, a rebuild reloads every one. */
const channels = new Map([
  ["data-view", new Set()],
  ["sources", new Set()],
]);
const emitTo = (channel) => (response) => {
  const frame = `data: ${JSON.stringify(response)}\n\n`;
  for (const client of channels.get(channel)) client.write(frame);
};
const emit = emitTo("data-view");
const clients = channels.get("data-view");

const host = await startDataViewHost({
  connection: CONNECTION,
  ...(RELATION ? { relation: RELATION } : {}),
  languageServerPath: `${OUT}sql-authoring-server.cjs`,
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

const page = (title, script) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><div id="root"></div><script src="${script}"></script></body></html>`;

/** The shell's front door: every view it manages, one link each, nothing else. */
const MENU = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PostgreSQL Workbench — shell</title><style>
  body { background: #1f1f1f; color: #ccc; font-family: -apple-system, sans-serif;
    display: grid; place-content: center; height: 100vh; margin: 0; }
  h1 { font-size: 14px; font-weight: 600; opacity: .7; margin: 0 0 12px; }
  a { display: block; color: #75beff; text-decoration: none; font-size: 16px;
    padding: 8px 14px; border: 1px solid #333; border-radius: 6px; margin: 6px 0; width: 220px; }
  a:hover { background: #2a2d2e; }
  small { opacity: .5 }
</style></head><body><div>
<h1>PostgreSQL Workbench — shell</h1>
<a href="/data-view">Data View</a>
<a href="/cockpit">Cockpit <small>— soon</small></a>
<a href="/sources">Sources</a>
</div></body></html>`;

const sources = await startSourcesHost({
  connection: CONNECTION,
  tokens: (uri, text, languageId) =>
    host.language?.semanticTokens(uri, text, languageId) ?? Promise.resolve([]),
  emit: emitTo("sources"),
});

createServer(async (request, response) => {
  const stream = /^\/(data-view|sources)\/responses$/.exec(request.url ?? "");
  if (stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    channels.get(stream[1]).add(response);
    request.on("close", () => channels.get(stream[1]).delete(response));
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
  if (/^\/(data-view|sources)\.js(\.map)?$/.test(request.url ?? "")) {
    const { readFile } = await import("node:fs/promises");
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(await readFile(`${OUT}${request.url.slice(1)}`));
    return;
  }
  if (request.url === "/data-view" || request.url?.startsWith("/data-view?")) {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Data View — shell", "/data-view.js"));
    return;
  }
  if (request.url === "/sources") {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Sources — shell", "/sources.js"));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" }).end(MENU);
}).listen(PORT, () => {
  console.log(
    `PostgreSQL Workbench shell on http://localhost:${PORT} — ${RELATION ? `${RELATION.schema}.${RELATION.name}` : "empty"} of ${CONNECTION.database}`,
  );
});

process.on("SIGINT", async () => {
  await sources.dispose();
  await host.dispose();
  process.exit(0);
});
