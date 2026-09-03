import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROLE_SOURCE = join(ROOT, "packages/presentation/src/roles.ts");
const DEFAULT_THEME = join(ROOT, "packages/presentation/src/defaultTheme.css");
const VSCODE_ADAPTER = join(ROOT, "vscode-extension/src/presentation/vscodeTheme.ts");
const failures = [];

function quotedValues(source, declaration) {
  const match = source.match(
    new RegExp(`(?:const|export const) ${declaration} = \\[([\\s\\S]*?)\\] as const`),
  );
  if (!match) throw new Error(`Cannot read ${declaration}`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
}

function objectKeys(source, declaration) {
  const match = source.match(
    new RegExp(`(?:const|export const) ${declaration} = \\{([\\s\\S]*?)\\} as const`),
  );
  if (!match) throw new Error(`Cannot read ${declaration}`);
  return [...match[1].matchAll(/^\s*(?:"([^"]+)"|([a-z][a-z0-9-]*)):\s*"[^"]+",?$/gmu)].map(
    (item) => item[1] ?? item[2],
  );
}

function assertSameSet(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));
  if (missing.length || extra.length) {
    failures.push(
      `${label}${missing.length ? ` missing [${missing.join(", ")}]` : ""}${extra.length ? ` has unknown [${extra.join(", ")}]` : ""}`,
    );
  }
}

async function productionFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await productionFiles(path)));
    else if (
      [".css", ".mjs", ".ts", ".tsx"].includes(extname(entry.name)) &&
      !/\.(?:spec|test)\.[^.]+$/u.test(entry.name)
    )
      files.push(path);
  }
  return files;
}

const roleSource = await readFile(ROLE_SOURCE, "utf8");
const colorRoles = quotedValues(roleSource, "WORKBENCH_COLOR_ROLES");
const fontFamilyRoles = quotedValues(roleSource, "WORKBENCH_FONT_FAMILY_ROLES");
const fontSizeRoles = quotedValues(roleSource, "WORKBENCH_FONT_SIZE_ROLES");
const appearanceRoles = quotedValues(roleSource, "WORKBENCH_APPEARANCE_ROLES");
const roles = new Set([...colorRoles, ...fontFamilyRoles, ...fontSizeRoles, ...appearanceRoles]);
if (
  roles.size !==
  colorRoles.length + fontFamilyRoles.length + fontSizeRoles.length + appearanceRoles.length
)
  failures.push("The presentation role registry contains a duplicate role");

const defaultTheme = await readFile(DEFAULT_THEME, "utf8");
if (!defaultTheme.includes(":where(:root, :host)"))
  failures.push("The default theme must apply in documents and renderer shadow roots");
const declaredVariables = new Set(
  [...defaultTheme.matchAll(/^\s*--pgw-([a-z0-9-]+):/gmu)].map((match) => match[1]),
);
const publicDefaults = new Set(
  [...declaredVariables].filter((role) => !role.startsWith("default-")),
);
const privateDefaults = new Set(
  [...declaredVariables]
    .filter((role) => role.startsWith("default-"))
    .map((role) => role.slice("default-".length)),
);
assertSameSet(publicDefaults, roles, "The public declarations in defaultTheme.css");
assertSameSet(privateDefaults, roles, "The private defaults in defaultTheme.css");

const vscodeAdapter = await readFile(VSCODE_ADAPTER, "utf8");
const projected = new Set(objectKeys(vscodeAdapter, "VSCODE_THEME_ROLE_PROJECTIONS"));
const defaultOnly = new Set(quotedValues(vscodeAdapter, "VSCODE_DEFAULT_THEME_ROLES"));
const appearance = new Set(quotedValues(vscodeAdapter, "VSCODE_APPEARANCE_THEME_ROLES"));
const assignments = [...projected, ...defaultOnly, ...appearance];
const duplicates = assignments.filter((role, index) => assignments.indexOf(role) !== index);
if (duplicates.length)
  failures.push(
    `VS Code assigns theme roles more than once [${[...new Set(duplicates)].join(", ")}]`,
  );
assertSameSet(new Set(assignments), roles, "The VS Code theme projection");
if (!/var\(--vscode-\$\{token\}, var\(--pgw-default-\$\{role\}\)\)/u.test(vscodeAdapter))
  failures.push("VS Code overrides must fall back to the product-owned default for every role");

const guardedRoots = [
  "packages/presentation",
  "packages/editor",
  "packages/views",
  "packages/shell",
];
for (const guardedRoot of guardedRoots) {
  for (const path of await productionFiles(join(ROOT, guardedRoot))) {
    if (path === DEFAULT_THEME) continue;
    const source = await readFile(path, "utf8");
    const sourceWithoutComments = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    const displayPath = relative(ROOT, path);
    if (/--vscode-[a-z0-9-]+/iu.test(source))
      failures.push(`${displayPath} reaches into the VS Code theme namespace`);
    if (/--postgres-[a-z0-9-]+/iu.test(source))
      failures.push(`${displayPath} declares the retired local PostgreSQL theme namespace`);
    if (
      /(?:#[0-9a-f]{3,8}\b|\b(?:color|hsla?|hwb|lab|lch|oklab|oklch|rgba?)\s*\()/iu.test(
        sourceWithoutComments,
      )
    )
      failures.push(`${displayPath} contains a color literal outside defaultTheme.css`);
    for (const match of source.matchAll(/--pgw-([a-z0-9-]+)/giu)) {
      const role = match[1];
      if (role.startsWith("default-"))
        failures.push(`${displayPath} reaches into private Workbench theme default --pgw-${role}`);
      else if (!roles.has(role))
        failures.push(`${displayPath} uses unknown Workbench theme role --pgw-${role}`);
    }
  }
}

for (const path of await productionFiles(join(ROOT, "vscode-extension/src"))) {
  if (path === VSCODE_ADAPTER) continue;
  const source = await readFile(path, "utf8");
  if (/--pgw-[a-z0-9-]+/iu.test(source))
    failures.push(
      `${relative(ROOT, path)} projects Workbench theme roles outside the VS Code theme adapter`,
    );
}

if (failures.length) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Presentation theme authority verified (${roles.size} roles).\n`);
}
