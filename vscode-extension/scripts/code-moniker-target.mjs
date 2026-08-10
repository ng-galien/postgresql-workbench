export const CODE_MONIKER_TARGETS = {
  "darwin-arm64": {
    platform: "darwin",
    architecture: "arm64",
    packageName: "@code-moniker/cli-darwin-arm64",
    executable: "code-moniker",
  },
  "darwin-x64": {
    platform: "darwin",
    architecture: "x64",
    packageName: "@code-moniker/cli-darwin-x64",
    executable: "code-moniker",
  },
  "linux-x64": {
    platform: "linux",
    architecture: "x64",
    packageName: "@code-moniker/cli-linux-x64",
    executable: "code-moniker",
  },
  "win32-x64": {
    platform: "win32",
    architecture: "x64",
    packageName: "@code-moniker/cli-win32-x64",
    executable: "code-moniker.exe",
  },
};

export function hostCodeMonikerTarget() {
  const target = Object.entries(CODE_MONIKER_TARGETS).find(
    ([, candidate]) =>
      candidate.platform === process.platform && candidate.architecture === process.arch,
  );
  if (!target) {
    throw new Error(`Code Moniker does not publish a package for ${process.platform}-${process.arch}`);
  }
  return target[0];
}

export function resolveCodeMonikerTarget(requested = process.env.CODE_MONIKER_TARGET) {
  const host = hostCodeMonikerTarget();
  const target = requested || host;
  if (!(target in CODE_MONIKER_TARGETS)) {
    throw new Error(`Unsupported Code Moniker target: ${target}`);
  }
  if (target !== host) {
    throw new Error(
      `Cannot package ${target} on ${host}; Code Moniker VSIX builds must run on their target host`,
    );
  }
  return target;
}

export function targetFromPlatform(platform, architecture) {
  return Object.entries(CODE_MONIKER_TARGETS).find(
    ([, candidate]) =>
      candidate.platform === platform && candidate.architecture === architecture,
  )?.[0];
}
