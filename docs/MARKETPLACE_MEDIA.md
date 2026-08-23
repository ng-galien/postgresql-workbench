# Marketplace showcase workflow

The Marketplace README is a product surface. Its animations must be captured
from a real VS Code Extension Host running PostgreSQL Workbench against the
deterministic demo database.

The workflow is automated. A showcase scene is not a manual recording and is not
a complete integration test: it prepares a known UI state, synchronizes with the
external recorder, performs one bounded 8–12 second choreography through the VS
Code and extension APIs, then exits. Each scene communicates one feature family.

## Requirements

The capture workflow requires macOS, VS Code, Docker, Node.js 24+, and FFmpeg.
Install FFmpeg with Homebrew if necessary:

```bash
brew install ffmpeg
```

The terminal running the workflow needs two macOS permissions:

- **Screen & System Audio Recording** to capture the isolated VS Code window;
- **Accessibility** to locate, focus, and frame that window deterministically.

Enable them under **System Settings → Privacy & Security**, restart the terminal,
then run:

```bash
npm run marketplace:media -- doctor
```

Before the first capture, place and size a normal VS Code window exactly as the
showcase should appear, keep it open, then persist those bounds with:

```bash
npm run marketplace:media -- calibrate
```

Calibration only reads the front VS Code window through macOS Accessibility and
updates the `window` block in `docs/marketplace-showcase.json`. Later captures
reproduce those exact bounds on the isolated Extension Host window. The adjacent
`captureInsets` block crops the macOS title bar, VS Code status bar, and small
side margins without changing the layout used by the showcase scenes.

## Prepare and exercise the runner

Package the target-specific VSIX named by `docs/marketplace-showcase.json`, then
prepare the PostgreSQL demo and compile the showcase code:

```bash
npm run package:ext
npm run marketplace:media -- prepare
```

Every `run` and `capture` command extracts that VSIX into a temporary directory,
loads the extracted extension, and verifies its ID, version, and runtime path.
This prevents a capture from silently exercising the development checkout.

Pass `--install` to package and install the same VSIX into the normal VS Code
profile as an additional manual preview step:

```bash
npm run marketplace:media -- prepare --install
```

Exercise a choreography without recording it:

```bash
npm run marketplace:media -- run cockpit
```

Marketplace assets use the manifest's `light` theme by default. Every run and
capture command accepts an explicit variant when a dark-theme comparison is
useful:

```bash
npm run marketplace:media -- run cockpit --theme light
npm run marketplace:media -- capture cockpit --theme dark
npm run marketplace:media -- capture-all --theme light
```

Before recording, the runner resolves the requested built-in VS Code theme,
applies it through the theme service, and refuses to continue unless the active
theme kind matches the request.

This launches an isolated VS Code profile and is the fastest way to diagnose a
scene. It never reads or migrates the installed extension's connection storage.

## Capture feature scenes

The versioned scene manifest is `docs/marketplace-showcase.json`. It owns stable
asset names, window geometry, duration, dimensions, frame rate, and size budget.
The implementation lives in `vscode-extension/showcase/marketplace.showcase.ts`.

```bash
npm run marketplace:media -- capture data-view
npm run marketplace:media -- capture cockpit
npm run marketplace:media -- capture sql-notebook
npm run marketplace:media -- capture tests-coverage
npm run marketplace:media -- capture debugger
```

A scene can be written before it is filmed. Declaring `"card": "pending"` on it says so: the
build accepts a manifest entry with no media and no card in the extension README, and prints a
note instead. Capturing it, showing it in the README, and dropping the field are one act — the
release gate (`node scripts/extension/check-marketplace-media.mjs --release`) refuses a tag that
still carries a pending card.

The scene must also be given a `site` name to appear on the documentation landing page; the file
names themselves are never repeated outside this manifest.

Or regenerate all feature families:

```bash
npm run marketplace:media -- capture-all
```

The orchestrator starts the isolated Extension Host and waits while the scene
prepares. Once ready, it frames and records only that VS Code window for the
scene's declared maximum duration. The scene then runs its deterministic actions
and signals completion; the recorder exits normally so macOS can finalize the
movie. The tool retains the source movie under
`vscode-extension/media/marketplace/raw/`, and generates an optimized looping GIF
plus a PNG poster alongside it.

To re-encode an existing source movie without rerunning VS Code:

```bash
npm run marketplace:media -- optimize cockpit path/to/cockpit.mov
```

## Quality gate and preview

```bash
npm run marketplace:media -- validate
npm run marketplace:media -- preview
```

Validation checks that every declared GIF and poster exists, is readable,
respects its width and size budget, and is referenced by the extension README —
the same rule `npm run check` applies, from the same module
(`scripts/marketplace/mediaContract.mjs`), so the two can never give opposite
verdicts on the same tree. A scene marked `"card": "pending"` is reported and
skipped.
The preview command opens that README in VS Code; press **Shift+Command+V** to
render it.

When a feature changes, update and recapture only its scene. Add a new scene only
when it communicates a distinct product promise; do not turn the Marketplace
page into a complete user manual.
