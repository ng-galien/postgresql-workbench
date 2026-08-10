import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import {
  CODE_MONIKER_TARGETS,
  resolveCodeMonikerTarget,
} from "./code-moniker-target.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(extensionRoot, "..");
const localCheckout = resolve(
  process.env.CODE_MONIKER_CHECKOUT ?? resolve(repositoryRoot, "..", "code-moniker"),
);
const runtimeRoot = resolve(extensionRoot, "runtime", "code-moniker");
const clientOutput = resolve(runtimeRoot, "client", "index.cjs");
const nodeOutput = resolve(runtimeRoot, "client", "node.cjs");
const requireFromExtension = createRequire(import.meta.url);
const target = resolveCodeMonikerTarget();
const targetPackage = CODE_MONIKER_TARGETS[target];

const temporaryRoot = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-package-"));
try {
  const packageSource = resolveInstalledPackages() ?? materializeLocalPackages(temporaryRoot);
  await stageRuntime(packageSource);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function resolveInstalledPackages() {
  let clientIndexSource;
  try {
    clientIndexSource = requireFromExtension.resolve("@code-moniker/client");
  } catch (error) {
    if (isMissingModule(error, "@code-moniker/client")) return undefined;
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
    sourceKind: "registry",
  };
}

function materializeLocalPackages(temporaryDirectory) {
  const clientRoot = resolve(localCheckout, "packages", "client");
  const clientManifestPath = resolve(clientRoot, "package.json");
  const clientIndexBuild = resolve(clientRoot, "dist", "index.cjs");
  const clientNodeBuild = resolve(clientRoot, "dist", "node.cjs");
  const binaryBuild = resolve(localCheckout, "target", "release", targetPackage.executable);
  const nativeStageScript = resolve(clientRoot, "scripts", "stage-native-package.mjs");
  for (const required of [
    clientManifestPath,
    clientIndexBuild,
    clientNodeBuild,
    binaryBuild,
    nativeStageScript,
  ]) {
    if (!existsSync(required)) {
      throw new Error(
        `Local Code Moniker package artifact is missing: ${required}. ` +
          "Build @code-moniker/client and the release binary before building the Workbench.",
      );
    }
  }

  const packDirectory = resolve(temporaryDirectory, "packs");
  const cacheDirectory = resolve(temporaryDirectory, "npm-cache");
  const nativeStage = resolve(temporaryDirectory, "native-stage");
  mkdirSync(packDirectory, { recursive: true });
  execFileSync(
    process.execPath,
    [nativeStageScript, target, binaryBuild, nativeStage],
    { stdio: "inherit" },
  );

  const clientTarball = packPackage(clientRoot, packDirectory, cacheDirectory);
  const nativeTarball = packPackage(nativeStage, packDirectory, cacheDirectory);
  const clientPackageRoot = extractPackage(
    clientTarball.path,
    resolve(temporaryDirectory, "client-package"),
  );
  const nativePackageRoot = extractPackage(
    nativeTarball.path,
    resolve(temporaryDirectory, "native-package"),
  );

  return {
    clientIndexSource: resolve(clientPackageRoot, "dist", "index.cjs"),
    clientNodeSource: resolve(clientPackageRoot, "dist", "node.cjs"),
    clientManifestPath: resolve(clientPackageRoot, "package.json"),
    nativeManifestPath: resolve(nativePackageRoot, "package.json"),
    binarySource: resolve(nativePackageRoot, "bin", targetPackage.executable),
    clientLicense: resolve(clientPackageRoot, "LICENSE"),
    nativeLicense: resolve(nativePackageRoot, "LICENSE"),
    nodePaths: [resolve(clientRoot, "node_modules")],
    sourceKind: "local-tarballs",
    clientTarballSha256: clientTarball.sha256,
    nativeTarballSha256: nativeTarball.sha256,
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
  const source =
    packageSource.sourceKind === "registry"
      ? `npm:${clientManifest.name}@${clientManifest.version}+${nativeManifest.name}@${nativeManifest.version}`
      : `local-npm:${clientManifest.name}@${clientManifest.version}#sha256:${packageSource.clientTarballSha256}+${nativeManifest.name}@${nativeManifest.version}#sha256:${packageSource.nativeTarballSha256}`;

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

function packPackage(packageRootPath, packDirectory, cacheDirectory) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("Local Code Moniker npm packages must be staged through npm");
  }
  const output = execFileSync(
    process.execPath,
    [
      npmCli,
      "pack",
      packageRootPath,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cacheDirectory },
    },
  );
  const [packed] = JSON.parse(output);
  if (!packed?.filename) {
    throw new Error(`npm pack returned no tarball for ${packageRootPath}`);
  }
  const path = resolve(packDirectory, packed.filename);
  return {
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function extractPackage(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = gunzipSync(readFileSync(tarball));
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(tarText(header, 124, 12).trim() || "0", 8);
    const mode = Number.parseInt(tarText(header, 100, 8).trim() || "644", 8);
    const type = String.fromCharCode(header[156] || 48);
    const contentStart = offset + 512;
    const output = resolve(destination, relativePath);
    if (output !== destination && !output.startsWith(`${destination}${sep}`)) {
      throw new Error(`npm tarball path escapes its destination: ${relativePath}`);
    }
    if (type === "5") {
      mkdirSync(output, { recursive: true });
    } else if (type === "0") {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, archive.subarray(contentStart, contentStart + size));
      if (process.platform !== "win32") chmodSync(output, mode);
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  const extracted = resolve(destination, "package");
  if (!existsSync(extracted)) {
    throw new Error(`npm tarball did not contain a package directory: ${tarball}`);
  }
  return extracted;
}

function tarText(header, start, length) {
  const end = header.indexOf(0, start);
  return header.toString("utf8", start, end === -1 || end > start + length ? start + length : end);
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
