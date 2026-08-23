#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: This capture command narrates its progress to the operator who watches it run.

import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveCodeMonikerTarget } from "../extension/code-moniker-target.mjs";
import { marketplaceMediaReport, sceneAssets, showcaseVsixName } from "./mediaContract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const extensionRoot = path.join(repoRoot, "vscode-extension");
const mediaRoot = path.join(extensionRoot, "media", "marketplace");
const rawRoot = path.join(mediaRoot, "raw");
const manifestPath = path.join(repoRoot, "docs", "marketplace-showcase.json");
const readmePath = path.join(extensionRoot, "README.md");
const showcaseConfig = path.join(extensionRoot, ".vscode-showcase.mjs");
const showcaseRunner = path.join(extensionRoot, "node_modules", ".bin", "vscode-test");
const dockerDesktopBin = "/Applications/Docker.app/Contents/Resources/bin";

if (process.platform === "darwin" && !process.env.PATH?.split(":").includes(dockerDesktopBin)) {
  process.env.PATH = `${dockerDesktopBin}:${process.env.PATH ?? ""}`;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
/*
 * The artifact a capture loads is the one this checkout builds: derived from the version and the
 * host's target, never written down. A filename pinned in the manifest is a release chore that is
 * remembered once and then quietly films the previous version.
 */
const configuredVsixPath = path.join(
  extensionRoot,
  showcaseVsixName(
    JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8")).version,
    resolveCodeMonikerTarget(),
  ),
);
const [command = "help", ...args] = process.argv.slice(2);

const commands = {
  help: printHelp,
  doctor,
  calibrate,
  prepare,
  run: runScene,
  capture,
  "capture-all": captureAll,
  optimize,
  validate,
  preview,
};

try {
  if (!commands[command]) fail(`Unknown command: ${command}\n`);
  await commands[command](...args);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function printHelp() {
  console.log(`PostgreSQL Workbench Marketplace showcase runner

Usage:
  npm run marketplace:media -- doctor
  npm run marketplace:media -- calibrate
  npm run marketplace:media -- prepare [--install]
  npm run marketplace:media -- run <scene> [--theme light|dark]
  npm run marketplace:media -- capture <scene> [--theme light|dark]
  npm run marketplace:media -- capture-all [--theme light|dark]
  npm run marketplace:media -- optimize <scene> [path/to/source.mov]
  npm run marketplace:media -- validate
  npm run marketplace:media -- preview

Scenes:
${manifest.scenes.map((scene) => `  ${scene.id.padEnd(18)} ${scene.title}`).join("\n")}

Each scene is an automated VS Code Extension Host choreography. The capture
command records only that deterministic 8–12 second sequence.`);
}

async function doctor() {
  console.log("PostgreSQL Workbench Marketplace media doctor\n");
  let failed = false;
  failed ||= checkPlatform();
  for (const binary of [
    "node",
    "npm",
    "code",
    "docker",
    "ffmpeg",
    "ffprobe",
    "screencapture",
    "osascript",
    "unzip",
  ]) {
    const location = findBinary(binary);
    if (location) console.log(`✓ ${binary.padEnd(14)} ${location}`);
    else {
      console.log(`✗ ${binary.padEnd(14)} not found`);
      failed = true;
    }
  }

  if (!(await isReadableFile(showcaseRunner))) {
    console.log("✗ VS Code test runner is missing; run npm ci in vscode-extension");
    failed = true;
  } else {
    console.log("✓ showcase runner installed");
  }

  if (!(await isReadableFile(configuredVsixPath))) {
    console.log(`✗ showcase VSIX  missing ${path.relative(repoRoot, configuredVsixPath)}`);
    failed = true;
  } else {
    console.log(`✓ showcase VSIX  ${path.relative(repoRoot, configuredVsixPath)}`);
  }

  if (process.platform === "darwin" && findBinary("screencapture")) {
    if (await checkScreenCaptureAccess()) console.log("✓ screen capture  available");
    else {
      console.log("✗ screen capture  permission is missing");
      console.log(
        "  Enable the current terminal in System Settings → Privacy & Security →\n" +
          "  Screen & System Audio Recording, then restart that terminal.",
      );
      failed = true;
    }
  }

  if (process.platform === "darwin" && findBinary("osascript")) {
    if (checkAccessibilityAccess()) console.log("✓ accessibility   VS Code window can be framed");
    else {
      console.log("✗ accessibility   permission is missing");
      console.log(
        "  Enable the current terminal in System Settings → Privacy & Security →\n" +
          "  Accessibility, then restart that terminal.",
      );
      failed = true;
    }
  }

  if (failed) process.exitCode = 1;
}

async function calibrate() {
  if (process.platform !== "darwin") fail("Window calibration requires macOS.\n");
  ensureBinary("osascript");
  const rect = readFrontVsCodeWindowRect();
  manifest.window = { ...manifest.window, ...rect };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ capture window calibrated to ${rect.width}×${rect.height} at ${rect.x},${rect.y}`);
  const captureRect = insetCaptureRect(rect);
  console.log(
    `✓ recorded area will be ${captureRect.width}×${captureRect.height} at ${captureRect.x},${captureRect.y}`,
  );
  console.log(`✓ ${path.relative(repoRoot, manifestPath)} updated`);
}

async function prepare(...options) {
  ensureBinary("docker");
  ensureBinary("npm");
  ensureBinary("code");
  await startDemoDatabase(true);
  await buildShowcase();

  if (options.includes("--install")) {
    console.log("Packaging and installing the current extension…");
    await run("npm", ["run", "package:ext"], { cwd: repoRoot });
    await access(configuredVsixPath, constants.R_OK);
    await run("code", ["--install-extension", configuredVsixPath, "--force"]);
  }

  console.log("✓ deterministic demo and showcase bundle are ready");
}

async function runScene(sceneId, ...options) {
  const scene = requireScene(sceneId);
  const { theme } = parseThemeOptions(options);
  await withShowcaseExtension(async (extension) => {
    await startDemoDatabase(false);
    await buildShowcase();
    await executeShowcase(scene, false, theme, extension);
  });
}

async function capture(sceneId, ...options) {
  const scene = requireScene(sceneId);
  const { theme, remaining } = parseThemeOptions(options);
  await ensureCaptureTools();
  await withShowcaseExtension(async (extension) => {
    await startDemoDatabase(false);
    if (!remaining.includes("--no-build")) await buildShowcase();
    await executeShowcase(scene, true, theme, extension);
    await optimize(scene.id);
  });
}

async function captureAll(...options) {
  const { theme } = parseThemeOptions(options);
  await ensureCaptureTools();
  await withShowcaseExtension(async (extension) => {
    await startDemoDatabase(false);
    await buildShowcase();
    for (const scene of manifest.scenes) {
      await executeShowcase(scene, true, theme, extension);
      await optimize(scene.id);
    }
    await validate();
    await preview();
  });
}

async function executeShowcase(scene, withCapture, theme, extension) {
  await mkdir(rawRoot, { recursive: true });
  const controlDir = await mkdtemp(path.join(tmpdir(), `postgresql-workbench-${scene.id}-`));
  const profileDir = await mkdtemp("/private/tmp/pgw-showcase-");
  await prepareShowcaseProfile(profileDir, theme);
  const rawPath = path.join(rawRoot, `${scene.file}.mov`);
  const readyPath = path.join(controlDir, "ready.json");
  const recordingPath = path.join(controlDir, "recording");
  const donePath = path.join(controlDir, "done");
  const stoppedPath = path.join(controlDir, "stopped");
  let recorder;
  let testProcess;
  /** The region the recorder was told to film, checked against what it actually produced. */
  let framed;

  try {
    if (withCapture) await rm(rawPath, { force: true });
    console.log(`\n▶ ${scene.title}`);
    testProcess = spawn(showcaseRunner, ["--config", showcaseConfig, "--fail-zero"], {
      cwd: extensionRoot,
      env: {
        ...process.env,
        POSTGRESQL_WORKBENCH_SHOWCASE_SCENE: scene.id,
        POSTGRESQL_WORKBENCH_SHOWCASE_CONTROL_DIR: controlDir,
        POSTGRESQL_WORKBENCH_SHOWCASE_PROFILE_DIR: profileDir,
        POSTGRESQL_WORKBENCH_SHOWCASE_THEME: theme,
        POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_PATH: extension.path,
        POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_VERSION: extension.version,
      },
      stdio: "inherit",
    });
    const testExit = processExit(testProcess);

    await waitForFile(readyPath, manifest.defaults.startupTimeoutMs, testExit);
    const readiness = JSON.parse(await readFile(readyPath, "utf8"));
    console.log(`VS Code ready · theme=${readiness.theme} · kind=${readiness.themeKind}`);
    if (readiness.themeKind !== theme) {
      fail(`The showcase refused to record with ${readiness.themeKind} instead of ${theme}.\n`);
    }
    if (withCapture) {
      const rect = insetCaptureRect(await resolveShowcaseWindowRect());
      recorder = await startRecorder(rawPath, rect, scene.maxDurationSeconds);
      framed = rect;
    }

    await writeFile(recordingPath, "ready\n");
    await waitForFile(donePath, (scene.maxDurationSeconds + 10) * 1000, testExit);

    if (recorder) await stopRecorder(recorder);
    await writeFile(stoppedPath, "stopped\n");
    const exitCode = await testExit;
    if (exitCode !== 0) fail(`VS Code showcase exited with code ${exitCode}.\n`);
    if (withCapture && !(await isReadableFile(rawPath))) {
      fail(`Screen recording did not produce ${rawPath}.\n`);
    }
    console.log(`✓ ${scene.id} choreography completed`);
  } finally {
    if (recorder && recorder.exitCode === null && recorder.signalCode === null) {
      recorder.kill("SIGINT");
      await processOutcomeWithin(recorder, 2_000);
    }
    if (testProcess && testProcess.exitCode === null && testProcess.signalCode === null) {
      await terminateProcess(testProcess);
    }
    /*
     * Tidying up must not become the failure. VS Code writes its logs on its way out, so removing
     * the throwaway profile races it — and an exception thrown here replaces the one that says
     * why the capture failed, which is how a framing error arrived as `ENOTEMPTY`.
     */
    await discard(controlDir);
    await discard(profileDir);
  }

  /*
   * What was filmed must be shaped like what was framed. The recorder crops in the display's
   * pixels while the window is measured in points, so a Retina screen legitimately films twice the
   * size — but never a different shape. A crop measured against the wrong bounds does change the
   * shape, and that is the failure that once produced a card showing the reader's own editor
   * beside a slice of the showcase, without complaint.
   */
  if (withCapture && framed && (await isReadableFile(rawPath))) {
    const filmed = probeDimensions(rawPath);
    const asked = framed.width / framed.height;
    const got = filmed.width / filmed.height;
    if (Math.abs(asked - got) / asked > 0.01) {
      fail(
        `The recording does not frame what it was asked to.\n` +
          `  asked for ${framed.width}×${framed.height} at ${framed.x},${framed.y}\n` +
          `  filmed   ${filmed.width}×${filmed.height}\n` +
          "The crop is measured against the whole desktop, so a second display makes it wrong.\n" +
          "Capture on a single display, then recalibrate and capture again.\n",
      );
    }
  }
}

/** Removes a throwaway directory, retrying what is still being written, and never throwing. */
async function discard(directory) {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`· left ${directory} behind (${error instanceof Error ? error.message : error})`);
  }
}

async function withShowcaseExtension(callback) {
  const extension = await extractConfiguredVsix();
  try {
    return await callback(extension);
  } finally {
    await rm(extension.root, { recursive: true, force: true });
    console.log(`✓ removed isolated VSIX ${extension.root}`);
  }
}

async function extractConfiguredVsix() {
  ensureBinary("unzip");
  if (!(await isReadableFile(configuredVsixPath))) {
    fail(`Missing configured showcase VSIX: ${configuredVsixPath}\n`);
  }

  const expectedPackage = JSON.parse(
    await readFile(path.join(extensionRoot, "package.json"), "utf8"),
  );
  const expectedName = `${expectedPackage.name}-${expectedPackage.version}-${process.platform}-${process.arch}.vsix`;
  if (path.basename(configuredVsixPath) !== expectedName) {
    fail(
      `Configured showcase VSIX is ${path.basename(configuredVsixPath)}; ` +
        `expected ${expectedName}.\n`,
    );
  }

  const root = await mkdtemp(path.join(tmpdir(), "postgresql-workbench-showcase-vsix-"));
  try {
    await run("unzip", ["-q", configuredVsixPath, "-d", root]);
    const extensionPath = await realpath(path.join(root, "extension"));
    const extensionPackage = JSON.parse(
      await readFile(path.join(extensionPath, "package.json"), "utf8"),
    );
    const expectedId = `${expectedPackage.publisher}.${expectedPackage.name}`;
    const extensionId = `${extensionPackage.publisher}.${extensionPackage.name}`;
    if (extensionId !== expectedId || extensionPackage.version !== expectedPackage.version) {
      fail(
        `Configured showcase VSIX contains ${extensionId}@${extensionPackage.version}; ` +
          `expected ${expectedId}@${expectedPackage.version}.\n`,
      );
    }
    if (!(await isReadableFile(path.join(extensionPath, extensionPackage.main)))) {
      fail(`Configured showcase VSIX has no readable ${extensionPackage.main}.\n`);
    }
    console.log(
      `✓ extracted ${path.basename(configuredVsixPath)} as ` +
        `${extensionId}@${extensionPackage.version} in ${extensionPath}`,
    );
    return { root, path: extensionPath, version: extensionPackage.version };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function prepareShowcaseProfile(profileDir, theme) {
  const colorTheme = theme === "dark" ? "Dark Modern" : "Light Modern";
  const userDir = path.join(profileDir, "user-data", "User");
  await mkdir(userDir, { recursive: true });
  await writeFile(
    path.join(userDir, "settings.json"),
    `${JSON.stringify(
      {
        "workbench.colorTheme": colorTheme,
        "workbench.preferredLightColorTheme": "Light Modern",
        "workbench.preferredDarkColorTheme": "Dark Modern",
        "window.autoDetectColorScheme": false,
        "git.openRepositoryInParentFolders": "never",
        "extensions.ignoreRecommendations": true,
        "telemetry.telemetryLevel": "off",
      },
      null,
      2,
    )}\n`,
  );
}

function parseThemeOptions(options) {
  let theme = manifest.defaults.theme ?? "light";
  const remaining = [];
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === "--theme") {
      theme = options[++index];
    } else if (option.startsWith("--theme=")) {
      theme = option.slice("--theme=".length);
    } else {
      remaining.push(option);
    }
  }
  if (theme !== "light" && theme !== "dark") {
    fail(`Unsupported theme ${theme}; expected light or dark.\n`);
  }
  return { theme, remaining };
}

async function optimize(sceneId, sourcePath) {
  const scene = requireScene(sceneId);
  ensureBinary("ffmpeg");
  ensureBinary("ffprobe");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(rawRoot, { recursive: true });

  const archivedRawPath = path.join(rawRoot, `${scene.file}.mov`);
  const rawPath = sourcePath ? path.resolve(process.cwd(), sourcePath) : archivedRawPath;
  if (!(await isReadableFile(rawPath))) fail(`Missing source movie: ${rawPath}\n`);
  if (path.resolve(rawPath) !== path.resolve(archivedRawPath)) {
    await copyFile(rawPath, archivedRawPath);
  }

  const gifPath = path.join(mediaRoot, `${scene.file}.gif`);
  const posterPath = path.join(mediaRoot, `${scene.file}.png`);
  const width = scene.width ?? manifest.defaults.width;
  const fps = scene.fps ?? manifest.defaults.fps;
  const scale = `scale='min(${width},iw)':-2:flags=lanczos`;
  const filter =
    `fps=${fps},${scale},split[frames][palette_source];` +
    "[palette_source]palettegen=max_colors=160:stats_mode=diff[palette];" +
    "[frames][palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle";

  console.log(`Optimizing ${path.basename(rawPath)}…`);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-i",
    rawPath,
    "-filter_complex",
    filter,
    "-loop",
    "0",
    gifPath,
  ]);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-ss",
    /*
     * The still a reader sees before the animation plays should show what the card is about, not
     * the state it opens on. A scene says when that is; a second in is right for one that starts
     * where it ends up.
     */
    String(scene.posterSeconds ?? 1),
    "-i",
    rawPath,
    "-vf",
    scale,
    "-frames:v",
    "1",
    posterPath,
  ]);

  console.log(`✓ ${path.relative(repoRoot, gifPath)} (${formatBytes((await stat(gifPath)).size)})`);
  console.log(`✓ ${path.relative(repoRoot, posterPath)}`);
}

async function validate() {
  ensureBinary("ffprobe");
  const readme = await readFile(readmePath, "utf8");
  /* Whether every card is where the page says it is: the same rule `npm run check` applies. */
  const { failures, pending } = marketplaceMediaReport({
    scenes: manifest.scenes,
    readme,
    captured: (asset) => existsSync(path.join(mediaRoot, asset)),
  });
  const issues = [...failures];
  const held = new Set(pending.map((scene) => scene.id));

  /* And what only a captured file can answer: that it is small enough and no wider than asked. */
  for (const scene of manifest.scenes) {
    if (held.has(scene.id)) continue;
    const gifPath = path.join(mediaRoot, sceneAssets(scene).gif);
    if (!(await isReadableFile(gifPath))) continue;

    const maxBytes = scene.maxGifBytes ?? manifest.defaults.maxGifBytes;
    const gifSize = (await stat(gifPath)).size;
    if (gifSize > maxBytes) {
      issues.push(
        `${path.basename(gifPath)} is ${formatBytes(gifSize)}; limit is ${formatBytes(maxBytes)}`,
      );
    }
    const dimensions = probeDimensions(gifPath);
    const expectedWidth = scene.width ?? manifest.defaults.width;
    if (dimensions.width > expectedWidth) {
      issues.push(
        `${path.basename(gifPath)} is ${dimensions.width}px wide; limit is ${expectedWidth}px`,
      );
    }
  }

  for (const scene of pending) {
    console.log(`· scene "${scene.id}" is written but never filmed; no card shows it yet`);
  }

  if (issues.length > 0) {
    console.error("Marketplace media validation failed:\n");
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }
  const shipped = manifest.scenes.length - pending.length;
  console.log(`✓ ${shipped} Marketplace scenes are complete and referenced`);
}

async function preview() {
  ensureBinary("code");
  await run("code", ["--reuse-window", readmePath]);
  console.log("README opened. Press ⇧⌘V in VS Code to open the rendered Markdown preview.");
}

async function startDemoDatabase(build) {
  ensureBinary("docker");
  const args = ["compose", "-f", path.join(repoRoot, "docker", "demo", "compose.yml"), "up", "-d"];
  if (build) args.push("--build");
  args.push("--wait");
  await run("docker", args);
}

async function buildShowcase() {
  ensureBinary("npm");
  await run("npm", ["run", "pretest"], { cwd: extensionRoot });
}

async function startRecorder(rawPath, rect, maxDurationSeconds) {
  const device = resolveScreenCaptureDevice();
  const screen = resolveMainScreenBounds();
  /*
   * The crop is a proportion of one captured display, and the bounds it is measured against are
   * the desktop's — which, with a second monitor attached, is the union of both. The proportion is
   * then meaningless and the card frames the wrong part of the screen. Say so before filming.
   */
  if (countCaptureScreens() > 1) {
    fail(
      "More than one display is attached.\n" +
        "The recorder films one display and measures the crop against the whole desktop, which\n" +
        "with a second monitor is the union of both — so the card would frame the wrong part of\n" +
        "the screen. Disconnect the second display or mirror it, then recalibrate and capture:\n" +
        "  npm run marketplace:media -- calibrate\n" +
        "  npm run marketplace:media -- capture <scene>\n",
    );
  }
  const crop = [
    `trunc(iw*${rect.width}/${screen.width}/2)*2`,
    `trunc(ih*${rect.height}/${screen.height}/2)*2`,
    `trunc(iw*${rect.x - screen.x}/${screen.width}/2)*2`,
    `trunc(ih*${rect.y - screen.y}/${screen.height}/2)*2`,
  ].join(":");
  const region = `${rect.x},${rect.y},${rect.width},${rect.height}`;
  console.log(`Recording VS Code region ${region}…`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const recorder = spawn(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "avfoundation",
        "-framerate",
        "12",
        "-capture_cursor",
        "1",
        "-capture_mouse_clicks",
        "1",
        "-i",
        `${device}:none`,
        "-vf",
        `crop=${crop}`,
        "-t",
        String(maxDurationSeconds),
        "-r",
        "12",
        "-c:v",
        "h264_videotoolbox",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "600",
        rawPath,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    await delay(900);
    if (recorder.exitCode === null && recorder.signalCode === null) return recorder;
    const outcome = await processOutcome(recorder);
    await rm(rawPath, { force: true });
    if (attempt < 3) {
      console.log(
        `Screen recorder initialization returned ` +
          `${outcome.code ?? outcome.signal ?? "an unknown status"}; retrying (${attempt}/3)…`,
      );
      await delay(600);
      continue;
    }
    fail(
      `The FFmpeg screen recorder could not start ` +
        `(${outcome.code ?? outcome.signal ?? "unknown status"}).\n`,
    );
  }
  throw new Error("unreachable");
}

async function stopRecorder(recorder) {
  console.log("Finalizing screen recording…");
  if (recorder.exitCode === null && recorder.signalCode === null) {
    recorder.stdin.write("q\n");
    recorder.stdin.end();
  }
  const outcome = await recorderOutcome(recorder, 5_000);
  if (!outcome) {
    recorder.kill("SIGKILL");
    fail("The FFmpeg screen recorder did not stop after the showcase completed.\n");
  }
  if (outcome.code !== 0) {
    fail(
      `The FFmpeg screen recorder exited with ${outcome.code ?? outcome.signal ?? "an unknown status"}.\n`,
    );
  }
}

/** How many displays avfoundation can film. More than one makes the crop below unreliable. */
function countCaptureScreens() {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { encoding: "utf8" },
  );
  return [...`${result.stdout}\n${result.stderr}`.matchAll(/\bCapture screen \d+\b/gu)].length;
}

function resolveScreenCaptureDevice() {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { encoding: "utf8" },
  );
  const match = `${result.stdout}\n${result.stderr}`.match(/\[(\d+)\]\s+Capture screen 0\b/);
  if (!match) fail("FFmpeg could not find the macOS Capture screen 0 device.\n");
  return match[1];
}

function resolveMainScreenBounds() {
  const result = spawnSync(
    "osascript",
    ["-e", 'tell application "Finder" to get bounds of window of desktop'],
    { encoding: "utf8" },
  );
  const [left, top, right, bottom] = result.stdout.split(",").map(Number);
  if (
    result.status !== 0 ||
    ![left, top, right, bottom].every(Number.isFinite) ||
    right <= left ||
    bottom <= top
  ) {
    fail("Could not resolve the main macOS screen bounds for recording.\n");
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function recorderOutcome(recorder, timeoutMs) {
  return processOutcomeWithin(recorder, timeoutMs);
}

async function terminateProcess(child) {
  child.kill("SIGTERM");
  if (await processOutcomeWithin(child, 3_000)) return;
  child.kill("SIGKILL");
  await processOutcomeWithin(child, 2_000);
}

async function resolveShowcaseWindowRect() {
  ensureBinary("osascript");
  const { x, y, width, height } = manifest.window;
  const escapedTitle = manifest.window.title.replaceAll('"', '\\"');
  const script = `
tell application "System Events"
  repeat with appProcess in application processes
    if name of appProcess is "Code" then
      repeat with candidateWindow in windows of appProcess
        if name of candidateWindow contains "${escapedTitle}" then
          set frontmost of appProcess to true
          -- A zoomed window ignores a size, and then the recording frames something else. Not
          -- every window answers that property, and an error here reads as "window not found".
          try
            if zoomed of candidateWindow then set zoomed of candidateWindow to false
          end try
          set position of candidateWindow to {${x}, ${y}}
          set size of candidateWindow to {${width}, ${height}}
          delay 0.4
          set position of candidateWindow to {${x}, ${y}}
          set size of candidateWindow to {${width}, ${height}}
          delay 0.4
          set {windowX, windowY} to position of candidateWindow
          set {windowWidth, windowHeight} to size of candidateWindow
          return (windowX as text) & "," & (windowY as text) & "," & (windowWidth as text) & "," & (windowHeight as text)
        end if
      end repeat
    end if
  end repeat
end tell`;

  /*
   * Framing is not a request, it is a result: a window can refuse a size — zoomed, clamped by the
   * display it opened on, still settling — and the recorder would then film a rectangle the window
   * is not in. It once produced a card showing the reader's own editor beside a slice of the
   * showcase, and said nothing. So the bounds are read back until they are the bounds asked for.
   */
  const deadline = Date.now() + 20_000;
  let last;
  while (Date.now() < deadline) {
    const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    const values = result.stdout.trim().split(",").map(Number);
    if (result.status === 0 && values.length === 4 && values.every(Number.isFinite)) {
      last = { x: values[0], y: values[1], width: values[2], height: values[3] };
      const off = Math.max(
        Math.abs(last.x - x),
        Math.abs(last.y - y),
        Math.abs(last.width - width),
        Math.abs(last.height - height),
      );
      if (off <= 2) return last;
    }
    await delay(400);
  }
  if (last) {
    fail(
      `The showcase window would not take the calibrated frame.\n` +
        `  asked for ${width}×${height} at ${x},${y}\n` +
        `  settled at ${last.width}×${last.height} at ${last.x},${last.y}\n` +
        "Recalibrate on the display this window opens on: place a VS Code window as the card\n" +
        "should appear and run: npm run marketplace:media -- calibrate\n",
    );
  }
  fail(
    `Could not find the VS Code window containing "${manifest.window.title}". ` +
      "Check the terminal Accessibility permission.\n",
  );
}

function readFrontVsCodeWindowRect() {
  const script = `
tell application "System Events"
  tell first application process whose name is "Code"
    set {windowX, windowY} to position of front window
    set {windowWidth, windowHeight} to size of front window
    return (windowX as text) & "," & (windowY as text) & "," & (windowWidth as text) & "," & (windowHeight as text)
  end tell
end tell`;
  const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
  const values = result.stdout.trim().split(",").map(Number);
  if (
    result.status !== 0 ||
    values.length !== 4 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    /*
     * Say what macOS said. The two causes look identical from here — no VS Code window in front,
     * or a terminal that was never granted assistive access — and the second one answers with a
     * specific error (-1719) that names itself. Guessing between them sent a reader looking at
     * their windows when the answer was in System Settings.
     */
    const reason = (result.stderr ?? "").trim();
    fail(
      `Could not read the front VS Code window${reason ? `:\n  ${reason}` : "."}\n` +
        (reason.includes("-1719") || reason.toLowerCase().includes("assistive")
          ? "That is the Accessibility permission. Enable this terminal in System Settings →\n" +
            "Privacy & Security → Accessibility, then quit it completely and open it again —\n" +
            "macOS only reads the permission when the process starts.\n"
          : "Keep a VS Code window open and in front, and check this terminal's Accessibility\npermission in System Settings → Privacy & Security → Accessibility.\n"),
    );
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function insetCaptureRect(windowRect) {
  const insets = manifest.captureInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const rect = {
    x: windowRect.x + insets.left,
    y: windowRect.y + insets.top,
    width: windowRect.width - insets.left - insets.right,
    height: windowRect.height - insets.top - insets.bottom,
  };
  if (rect.width <= 0 || rect.height <= 0) {
    fail("Capture insets exceed the calibrated VS Code window dimensions.\n");
  }
  return rect;
}

async function processExit(child) {
  const outcome = await processOutcome(child);
  return outcome.code ?? 1;
}

function processOutcome(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function processOutcomeWithin(child, timeoutMs) {
  return Promise.race([processOutcome(child), delay(timeoutMs).then(() => undefined)]);
}

async function waitForFile(file, timeoutMs, competingExit) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReadableFile(file)) return;
    const outcome = await Promise.race([
      competingExit.then((code) => ({ code })),
      delay(100).then(() => undefined),
    ]);
    if (outcome) fail(`VS Code showcase exited early with code ${outcome.code}.\n`);
  }
  fail(`Timed out waiting for ${path.basename(file)}.\n`);
}

function checkPlatform() {
  if (process.platform === "darwin") {
    console.log(`✓ platform       macOS ${process.arch}`);
    return false;
  }
  console.log(`✗ platform       ${process.platform} (capture requires macOS)`);
  return true;
}

async function ensureCaptureTools() {
  if (process.platform !== "darwin") fail("Screen capture requires macOS.\n");
  for (const binary of ["screencapture", "osascript", "ffmpeg", "ffprobe"]) {
    ensureBinary(binary);
  }
  if (!(await checkScreenCaptureAccess())) {
    fail(
      "Screen recording is not authorized for this terminal. Enable it in " +
        "System Settings → Privacy & Security → Screen & System Audio Recording, " +
        "then restart the terminal.\n",
    );
  }
}

function ensureBinary(binary) {
  if (!findBinary(binary)) fail(`Required command not found: ${binary}\n`);
}

function findBinary(binary) {
  const result = spawnSync("/usr/bin/env", ["which", binary], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function checkScreenCaptureAccess() {
  const directory = await mkdtemp(path.join(tmpdir(), "postgresql-workbench-media-"));
  const screenshot = path.join(directory, "screen.png");
  try {
    const result = spawnSync("screencapture", ["-x", "-D1", screenshot], { stdio: "ignore" });
    return result.status === 0 && (await isReadableFile(screenshot));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function checkAccessibilityAccess() {
  const result = spawnSync(
    "osascript",
    ["-e", 'tell application "System Events" to return UI elements enabled'],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

function probeDimensions(file) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) fail(`ffprobe failed for ${file}\n`);
  return JSON.parse(result.stdout).streams[0];
}

function requireScene(sceneId) {
  if (!sceneId) fail("A scene id is required. Run the help command to list scenes.\n");
  const scene = manifest.scenes.find(({ id }) => id === sceneId);
  if (!scene) fail(`Unknown scene: ${sceneId}. Run the help command to list scenes.\n`);
  return scene;
}

async function isReadableFile(file) {
  try {
    await access(file, constants.R_OK);
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function run(binary, binaryArgs, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, binaryArgs, { cwd: options.cwd ?? repoRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} exited with ${code ?? signal}`));
    });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message) {
  throw new Error(message.trimEnd());
}
