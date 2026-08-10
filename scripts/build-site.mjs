import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked, Renderer } from "marked";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(repositoryRoot, "site");
const documentationDirectory = path.join(repositoryRoot, "docs", "user");
const outputDirectory = path.join(repositoryRoot, "dist", "site");
const marketplaceMedia = path.join(repositoryRoot, "vscode-extension", "media", "marketplace");
const extensionManifestPath = path.join(repositoryRoot, "vscode-extension", "package.json");
const icon = path.join(repositoryRoot, "vscode-extension", "icons", "plpgsql-icon.png");

const guides = [
  ["index.md", "Overview"],
  ["cockpit.md", "Workbench Cockpit"],
  ["notebooks.md", "SQL scratchpads"],
  ["testing-coverage.md", "pgTAP and coverage"],
  ["debugger.md", "PL/pgSQL debugger"],
  ["dap.md", "Standalone DAP server"],
  ["reference.md", "Commands and settings"],
];

const assets = [
  [path.join(marketplaceMedia, "01-cockpit.gif"), "cockpit.gif"],
  [path.join(marketplaceMedia, "01-cockpit.png"), "cockpit.png"],
  [path.join(marketplaceMedia, "02-sql-notebook.gif"), "notebook.gif"],
  [path.join(marketplaceMedia, "03-tests-coverage.gif"), "coverage.gif"],
  [path.join(marketplaceMedia, "04-debugger.gif"), "debugger.gif"],
  [icon, "icon.png"],
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseFrontmatter(source) {
  if (!source.startsWith("---\n")) {
    return { attributes: {}, markdown: source };
  }

  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("Unterminated documentation frontmatter");
  }

  const attributes = {};
  for (const line of source.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    attributes[key] = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
  }

  return { attributes, markdown: source.slice(end + 5).trimStart() };
}

function slug(value) {
  return value
    .toLowerCase()
    .replaceAll(/<[^>]+>/g, "")
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function cockpitMap() {
  return `<figure class="annotated-cockpit">
  <img src="../assets/cockpit.png" alt="PostgreSQL Cockpit with the Workbench tree, graph canvas, filters, source inspector, and perspectives" width="1080" height="612" />
  ${[1, 2, 3, 4, 5, 6].map((number) => `<span class="annotation-marker marker-${number}" aria-hidden="true">${number}</span>`).join("\n  ")}
</figure>`;
}

function dapFlow() {
  return `<div class="dap-flow" aria-label="Debug Adapter Protocol architecture">
  <div class="dap-flow-node">DAP client<br /><small class="dap-flow-detail">VS Code · Neovim · Emacs</small></div>
  <span class="dap-flow-connector">stdio</span>
  <div class="dap-flow-node">PostgreSQL Workbench DAP</div>
  <span class="dap-flow-connector">SQL</span>
  <div class="dap-flow-node">PostgreSQL<br /><small class="dap-flow-detail">pldbgapi</small></div>
</div>`;
}

function mediaMarkup(attributes) {
  if (!attributes.media) {
    return "";
  }
  const darkClass = attributes.mediaDark ? " docs-media-dark" : "";
  return `<figure class="docs-media${darkClass}"><img src="../assets/${escapeHtml(attributes.media)}" alt="${escapeHtml(attributes.mediaAlt ?? "PostgreSQL Workbench feature")}" width="1080" height="612" /></figure>`;
}

function referenceMarkup(extensionManifest) {
  const commandRows = extensionManifest.contributes.commands
    .map(
      ({ command, title }) =>
        `<tr data-reference-row><td>${escapeHtml(title)}</td><td><code>${escapeHtml(command)}</code></td></tr>`,
    )
    .join("\n");

  const settingRows = Object.entries(extensionManifest.contributes.configuration.properties)
    .map(([name, setting]) => {
      const defaultValue = setting.default === undefined ? "—" : JSON.stringify(setting.default);
      return `<tr data-reference-row><td><code>${escapeHtml(name)}</code></td><td><code>${escapeHtml(defaultValue)}</code></td><td>${escapeHtml(setting.description ?? "")}</td></tr>`;
    })
    .join("\n");

  return `<label class="reference-search">Filter reference
  <input type="search" placeholder="Try: scratchpad, coverage, timeout…" data-filter-reference />
</label>
<h2>Commands</h2>
<div class="reference-table"><table><thead><tr><th>Command</th><th>Identifier</th></tr></thead><tbody>${commandRows}</tbody></table></div>
<h2>Settings</h2>
<div class="reference-table"><table><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody>${settingRows}</tbody></table></div>`;
}

function guideNavigation(currentFile) {
  return `<p>Guides</p>${guides
    .map(([file, label]) => {
      const current = file === currentFile ? ' aria-current="page"' : "";
      return `<a href="${file.replace(/\.md$/, ".html")}"${current}>${escapeHtml(label)}</a>`;
    })
    .join("")}`;
}

function renderDocumentation(markdown, currentFile) {
  const headings = [];
  const renderer = new Renderer();

  renderer.heading = function ({ tokens, depth }) {
    const rendered = this.parser.parseInline(tokens);
    const text = tokens.map((token) => token.text ?? token.raw ?? "").join("");
    const id = slug(text);
    if (depth === 2 || depth === 3) {
      headings.push({ depth, id, text });
    }
    return `<h${depth} id="${id}">${rendered}</h${depth}>\n`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const target = href.endsWith(".md") ? href.replace(/\.md$/, ".html") : href;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(target)}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`;
  };

  const content = marked.parse(markdown, { gfm: true, renderer });
  const tableOfContents = headings.length
    ? headings
        .map(
          ({ depth, id, text }) =>
            `<a class="toc-depth-${depth}" href="#${id}">${escapeHtml(text)}</a>`,
        )
        .join("")
    : "<span>No sections</span>";

  return { content, tableOfContents, navigation: guideNavigation(currentFile) };
}

export async function buildSite() {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(path.join(outputDirectory, "assets"), { recursive: true });
  await cp(sourceDirectory, outputDirectory, { recursive: true });
  await rm(path.join(outputDirectory, "docs-layout.html"), { force: true });

  for (const [source, destination] of assets) {
    await cp(source, path.join(outputDirectory, "assets", destination));
  }

  const layout = await readFile(path.join(sourceDirectory, "docs-layout.html"), "utf8");
  const extensionManifest = JSON.parse(await readFile(extensionManifestPath, "utf8"));
  const documentationOutput = path.join(outputDirectory, "docs");
  await mkdir(documentationOutput, { recursive: true });

  const documentationFiles = (await readdir(documentationDirectory))
    .filter((file) => file.endsWith(".md"))
    .sort();

  for (const file of documentationFiles) {
    const source = await readFile(path.join(documentationDirectory, file), "utf8");
    const { attributes, markdown } = parseFrontmatter(source);
    const expandedMarkdown = markdown
      .replace("{{cockpit-map}}", cockpitMap())
      .replace("{{dap-flow}}", dapFlow())
      .replace("{{media}}", mediaMarkup(attributes))
      .replace("{{reference}}", attributes.reference ? referenceMarkup(extensionManifest) : "");
    const rendered = renderDocumentation(expandedMarkdown, file);
    const outputFile = file.replace(/\.md$/, ".html");
    const canonicalUrl = `https://ng-galien.github.io/postgresql-workbench/docs/${outputFile}`;
    const rawTitle = attributes.title ?? "Documentation";
    const title = escapeHtml(rawTitle);
    const isDocumentationIndex = file === "index.md";
    const breadcrumb = isDocumentationIndex
      ? ""
      : `<p class="docs-breadcrumb"><a href="index.html">Documentation</a> / ${title}</p>`;
    const eyebrow = attributes.eyebrow ?? "Documentation";
    const repeatsTitle = eyebrow.trim().toLocaleLowerCase() === rawTitle.trim().toLocaleLowerCase();
    const eyebrowBlock =
      isDocumentationIndex || repeatsTitle ? "" : `<p class="eyebrow">${escapeHtml(eyebrow)}</p>`;
    const output = layout
      .replaceAll("{{title}}", title)
      .replaceAll(
        "{{description}}",
        escapeHtml(attributes.description ?? "PostgreSQL Workbench documentation"),
      )
      .replaceAll("{{canonicalUrl}}", canonicalUrl)
      .replace("{{breadcrumb}}", breadcrumb)
      .replace("{{eyebrowBlock}}", eyebrowBlock)
      .replaceAll("{{guideNavigation}}", rendered.navigation)
      .replace("{{tableOfContents}}", rendered.tableOfContents)
      .replace("{{content}}", rendered.content);
    await writeFile(path.join(documentationOutput, outputFile), output, "utf8");
  }

  await writeFile(path.join(outputDirectory, ".nojekyll"), "", "utf8");
  // biome-ignore lint/suspicious/noConsole: This build script reports its generated artifact to CI and local users.
  console.log(
    `Built GitHub Pages site with ${documentationFiles.length} Markdown guides in ${path.relative(repositoryRoot, outputDirectory)}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildSite();
}
