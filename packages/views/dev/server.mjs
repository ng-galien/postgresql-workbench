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
const SCHEMA = process.env.PGWB_DEV_SCHEMA ?? "shop";
const RELATION = process.env.PGWB_DEV_RELATION ?? "product";

// The repository writes `.js` in its specifiers, which Node cannot resolve to `.ts`; esbuild can.
const OUT = new URL("../../../node_modules/.pgwb-dev/", import.meta.url).pathname;
await esbuild.build({
  entryPoints: [new URL("dataViewHost.ts", import.meta.url).pathname],
  bundle: true,
  outfile: `${OUT}host.cjs`,
  // CommonJS, because the Code Moniker client resolves its runtime through `__filename`.
  format: "cjs",
  platform: "node",
  target: "es2022",
  packages: "external",
});
const { startDataViewHost } = createRequire(import.meta.url)(`${OUT}host.cjs`);

const clients = new Set();
const emit = (response) => {
  const frame = `data: ${JSON.stringify(response)}\n\n`;
  for (const client of clients) client.write(frame);
};

const host = await startDataViewHost({
  connection: CONNECTION,
  schema: SCHEMA,
  relation: RELATION,
  emit,
});

const bundle = await esbuild.context({
  entryPoints: [new URL("index.tsx", import.meta.url).pathname],
  bundle: true,
  outfile: `${OUT}data-view.js`,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "text", ".ttf": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  sourcemap: true,
});
await bundle.watch();

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Data View — harness</title></head>
<body><div id="root"></div><script src="/data-view.js"></script></body></html>`;

createServer(async (request, response) => {
  if (request.url === "/responses") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.url === "/request" && request.method === "POST") {
    const body = await new Blob(await Array.fromAsync(request)).text();
    response.writeHead(204).end();
    await host.handle(JSON.parse(body)).catch((error) => {
      emit({ type: "data-view/notice", message: String(error), severity: "error" });
    });
    return;
  }
  if (request.url === "/data-view.js" || request.url === "/data-view.js.map") {
    const { readFile } = await import("node:fs/promises");
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(await readFile(`${OUT}${request.url.slice(1)}`));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
}).listen(PORT, () => {
  console.log(
    `Data View harness on http://localhost:${PORT} — ${SCHEMA}.${RELATION} of ${CONNECTION.database}`,
  );
});

process.on("SIGINT", async () => {
  await host.dispose();
  process.exit(0);
});
