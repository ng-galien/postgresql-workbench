import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  CODE_MONIKER_TARGETS,
  resolveCodeMonikerTarget,
} from "./code-moniker-target.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDirectory, "..");
const runtimeRoot = resolve(extensionRoot, "runtime", "code-moniker");
const clientOutput = resolve(runtimeRoot, "client", "index.cjs");
const nodeOutput = resolve(runtimeRoot, "client", "node.cjs");
const requireFromExtension = createRequire(import.meta.url);
const target = resolveCodeMonikerTarget();
const targetPackage = CODE_MONIKER_TARGETS[target];

await stageRuntime(resolveInstalledPackages());

function resolveInstalledPackages() {
  let clientIndexSource;
  try {
    clientIndexSource = requireFromExtension.resolve("@code-moniker/client");
  } catch (error) {
    if (isMissingModule(error, "@code-moniker/client")) {
      throw new Error(
        "Published @code-moniker/client is not installed. Run npm ci in vscode-extension.",
      );
    }
    throw error;
  }

  const clientNodeSource = requireFromExtension.resolve("@code-moniker/client/node");
  const clientRoot = packageRoot(clientIndexSource, "@code-moniker/client");
  const clientManifestPath = resolve(clientRoot, "package.json");
  let binarySource;
  try {
    binarySource = requireFromExtension.resolve(
      `${targetPackage.packageName}/bin/${targetPackage.executable}`,
    );
  } catch (error) {
    if (!isMissingModule(error, targetPackage.packageName)) throw error;
    throw new Error(
      `Installed @code-moniker/client has no ${targetPackage.packageName} binary. ` +
        "Reinstall it without omitting optional dependencies.",
    );
  }
  const nativeRoot = packageRoot(binarySource, targetPackage.packageName);
  const nativeManifestPath = resolve(nativeRoot, "package.json");

  return {
    clientIndexSource,
    clientNodeSource,
    clientManifestPath,
    nativeManifestPath,
    binarySource,
    clientLicense: resolve(clientRoot, "LICENSE"),
    nativeLicense: resolve(nativeRoot, "LICENSE"),
    nodePaths: [],
  };
}

async function stageRuntime(packageSource) {
  for (const required of [
    packageSource.clientIndexSource,
    packageSource.clientNodeSource,
    packageSource.clientManifestPath,
    packageSource.nativeManifestPath,
    packageSource.binarySource,
    packageSource.clientLicense,
    packageSource.nativeLicense,
  ]) {
    if (!existsSync(required)) {
      throw new Error(`Code Moniker npm package is missing required artifact: ${required}`);
    }
  }

  const clientManifest = readManifest(packageSource.clientManifestPath);
  const nativeManifest = readManifest(packageSource.nativeManifestPath);
  if (clientManifest.name !== "@code-moniker/client") {
    throw new Error(`Unexpected Code Moniker client package: ${clientManifest.name}`);
  }
  if (nativeManifest.name !== targetPackage.packageName) {
    throw new Error(
      `Code Moniker native package is ${nativeManifest.name}, expected ${targetPackage.packageName}`,
    );
  }
  if (clientManifest.version !== nativeManifest.version) {
    throw new Error(
      `Code Moniker client ${clientManifest.version} and native package ${nativeManifest.version} do not match`,
    );
  }

  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(resolve(runtimeRoot, "client"), { recursive: true });
  mkdirSync(resolve(runtimeRoot, "bin"), { recursive: true });

  await Promise.all([
    build({
      entryPoints: [packageSource.clientIndexSource],
      bundle: true,
      platform: "neutral",
      format: "cjs",
      target: "es2022",
      outfile: clientOutput,
      nodePaths: packageSource.nodePaths,
    }),
    build({
      entryPoints: [packageSource.clientNodeSource],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: nodeOutput,
      nodePaths: packageSource.nodePaths,
    }),
  ]);

  const binaryOutput = resolve(runtimeRoot, "bin", targetPackage.executable);
  copyFileSync(packageSource.binarySource, binaryOutput);
  if (targetPackage.platform !== "win32") chmodSync(binaryOutput, 0o755);
  copyFileSync(
    packageSource.clientLicense,
    resolve(runtimeRoot, "CODE_MONIKER_CLIENT_LICENSE.txt"),
  );
  copyFileSync(
    packageSource.nativeLicense,
    resolve(runtimeRoot, "CODE_MONIKER_NATIVE_LICENSE.txt"),
  );

  const client = requireFromExtension(clientOutput);
  const nodeClient = requireFromExtension(nodeOutput);
  if (!Number.isInteger(client.PROTOCOL_VERSION)) {
    throw new Error("Staged Code Moniker client does not expose PROTOCOL_VERSION");
  }
  if (typeof nodeClient.NodeDaemonRuntime !== "function") {
    throw new Error("Staged Code Moniker Node client does not expose NodeDaemonRuntime");
  }
  const binaryVersionOutput = execFileSync(binaryOutput, ["--version"], {
    encoding: "utf8",
  }).trim();
  const binaryVersion = binaryVersionOutput.replace(/^code-moniker\s+/, "");
  if (binaryVersion !== clientManifest.version) {
    throw new Error(
      `Code Moniker binary ${binaryVersion} and client ${clientManifest.version} do not match`,
    );
  }
  const binarySha256 = createHash("sha256").update(readFileSync(binaryOutput)).digest("hex");
  const source = `npm:${clientManifest.name}@${clientManifest.version}+${nativeManifest.name}@${nativeManifest.version}`;

  writeFileSync(
    resolve(runtimeRoot, "manifest.json"),
    `${JSON.stringify(
      {
        format: 2,
        platform: targetPackage.platform,
        arch: targetPackage.architecture,
        target,
        clientVersion: clientManifest.version,
        protocolVersion: client.PROTOCOL_VERSION,
        binaryVersion,
        source,
        clientEntry: "client/index.cjs",
        nodeEntry: "client/node.cjs",
        binary: `bin/${targetPackage.executable}`,
        binarySha256,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    `Staged Code Moniker npm packages ${clientManifest.version} ` +
      `protocol=${client.PROTOCOL_VERSION} target=${target} source=${source}\n`,
  );
}

function packageRoot(path, expectedName) {
  let current = statSync(path).isDirectory() ? path : dirname(path);
  while (true) {
    const manifestPath = resolve(current, "package.json");
    if (existsSync(manifestPath) && readManifest(manifestPath).name === expectedName) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Cannot find ${expectedName} package root from ${path}`);
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isMissingModule(error, packageName) {
  return (
    error &&
    typeof error === "object" &&
    error.code === "MODULE_NOT_FOUND" &&
    String(error.message).includes(packageName)
  );
}
