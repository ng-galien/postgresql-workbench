import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export const DOCKER_DEBUGGER_IMAGE = "galien0xffffff/postgres-debugger";
export const DOCKER_DEBUGGER_VERSIONS = ["17", "18", "16", "15", "14", "13"] as const;
export type DockerDebuggerVersion = (typeof DOCKER_DEBUGGER_VERSIONS)[number];

const MANAGED_LABEL = "com.ng-galien.postgresql-workbench.managed";
const VERSION_LABEL = "com.ng-galien.postgresql-workbench.postgresql-version";

export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerCommandRunner {
  run(args: readonly string[]): Promise<DockerCommandResult>;
}

export interface DockerProvisioningOptions {
  version: DockerDebuggerVersion;
  hostPort: number;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
}

export interface DockerProvisioningResult {
  containerName: string;
  image: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  reused: boolean;
}

interface DockerInspect {
  Config?: {
    Labels?: Record<string, string>;
  };
  State?: {
    Running?: boolean;
  };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  };
}

function commandFailure(action: string, result: DockerCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return new Error(`${action}: ${detail}`);
}

function isMissingContainer(result: DockerCommandResult): boolean {
  return /no such (object|container)/i.test(`${result.stderr}\n${result.stdout}`);
}

function containerName(version: DockerDebuggerVersion, hostPort: number): string {
  return `postgresql-workbench-pg${version}-${hostPort}`;
}

function mappedHostPort(inspect: DockerInspect): number | undefined {
  const value = inspect.NetworkSettings?.Ports?.["5432/tcp"]?.[0]?.HostPort;
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) ? port : undefined;
}

export function findDockerExecutable(
  pathValue = process.env.PATH ?? "",
  platform = process.platform,
): string {
  const executable = platform === "win32" ? "docker.exe" : "docker";
  const candidates = pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executable));
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
    );
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? executable;
}

export class DockerCliRunner implements DockerCommandRunner {
  constructor(private readonly executable = findDockerExecutable()) {}

  run(args: readonly string[]): Promise<DockerCommandResult> {
    const executableDirectory = isAbsolute(this.executable) ? dirname(this.executable) : undefined;
    const pathValue = [executableDirectory, process.env.PATH].filter(Boolean).join(delimiter);
    return new Promise((resolve) => {
      execFile(
        this.executable,
        [...args],
        {
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, PATH: pathValue },
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout,
            stderr: error && !stderr ? error.message : stderr,
          });
        },
      );
    });
  }
}

export class DockerDebuggerProvisioner {
  constructor(
    private readonly runner: DockerCommandRunner = new DockerCliRunner(),
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async start(
    options: DockerProvisioningOptions,
    report: (message: string) => void = () => {},
  ): Promise<DockerProvisioningResult> {
    if (!Number.isInteger(options.hostPort) || options.hostPort < 1 || options.hostPort > 65535) {
      throw new Error(`Invalid local PostgreSQL port: ${options.hostPort}`);
    }

    const image = `${DOCKER_DEBUGGER_IMAGE}:${options.version}`;
    const name = containerName(options.version, options.hostPort);
    const password = "postgres";

    report("Checking Docker...");
    const version = await this.runner.run(["version", "--format", "{{.Server.Version}}"]);
    if (version.exitCode !== 0) {
      throw new Error(
        "Docker is not available. Install and start Docker Desktop, then run this command again.",
        { cause: commandFailure("docker version failed", version) },
      );
    }

    const reused = await this.ensureContainer(options, name, image, password, report);
    report("Waiting for PostgreSQL...");
    await this.waitUntilReady(
      name,
      options.readinessAttempts ?? 60,
      options.readinessIntervalMs ?? 500,
    );
    report("Enabling pldbgapi...");
    await this.enablePldbgapi(name);

    return {
      containerName: name,
      image,
      host: "127.0.0.1",
      port: options.hostPort,
      database: "postgres",
      user: "postgres",
      password,
      reused,
    };
  }

  private async ensureContainer(
    options: DockerProvisioningOptions,
    name: string,
    image: string,
    password: string,
    report: (message: string) => void,
  ): Promise<boolean> {
    const inspectResult = await this.runner.run(["inspect", name]);
    if (inspectResult.exitCode === 0) {
      const inspect = this.parseInspect(inspectResult);
      if (inspect.Config?.Labels?.[MANAGED_LABEL] !== "true") {
        throw new Error(
          `A Docker container named "${name}" already exists but is not managed by PostgreSQL Workbench. Rename or remove that container, or choose another port.`,
        );
      }
      if (inspect.Config.Labels[VERSION_LABEL] !== options.version) {
        throw new Error(
          `The managed container "${name}" does not match PostgreSQL ${options.version}.`,
        );
      }
      if (mappedHostPort(inspect) !== options.hostPort) {
        throw new Error(
          `The managed container "${name}" is not published on local port ${options.hostPort}.`,
        );
      }
      if (!inspect.State?.Running) {
        report(`Starting existing PostgreSQL ${options.version} container...`);
        const start = await this.runner.run(["start", name]);
        if (start.exitCode !== 0) throw commandFailure(`Could not start "${name}"`, start);
      } else {
        report(`Reusing PostgreSQL ${options.version} container...`);
      }
      return true;
    }
    if (!isMissingContainer(inspectResult)) {
      throw commandFailure(`Could not inspect Docker container "${name}"`, inspectResult);
    }

    report(`Pulling ${image}...`);
    const pull = await this.runner.run(["pull", image]);
    if (pull.exitCode !== 0) throw commandFailure(`Could not pull "${image}"`, pull);

    report(`Starting PostgreSQL ${options.version}...`);
    const run = await this.runner.run([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `${MANAGED_LABEL}=true`,
      "--label",
      `${VERSION_LABEL}=${options.version}`,
      "-p",
      `127.0.0.1:${options.hostPort}:5432`,
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      "POSTGRES_DB=postgres",
      image,
    ]);
    if (run.exitCode !== 0) throw commandFailure(`Could not start "${image}"`, run);
    return false;
  }

  private async enablePldbgapi(name: string): Promise<void> {
    const createExtension = await this.runner.run([
      "exec",
      name,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      "CREATE EXTENSION IF NOT EXISTS pldbgapi",
    ]);
    if (createExtension.exitCode !== 0) {
      throw commandFailure(`Could not enable pldbgapi in "${name}"`, createExtension);
    }
  }

  private parseInspect(result: DockerCommandResult): DockerInspect {
    try {
      const parsed = JSON.parse(result.stdout) as DockerInspect[];
      if (!Array.isArray(parsed) || !parsed[0]) throw new Error("empty inspect response");
      return parsed[0];
    } catch (error) {
      throw new Error(
        `Docker returned an unreadable container description: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async waitUntilReady(
    container: string,
    attempts: number,
    intervalMs: number,
  ): Promise<void> {
    const count = Math.max(1, attempts);
    for (let attempt = 0; attempt < count; attempt += 1) {
      const initProcess = await this.runner.run(["exec", container, "cat", "/proc/1/comm"]);
      if (initProcess.exitCode !== 0 || initProcess.stdout.trim() !== "postgres") {
        if (attempt + 1 < count) await this.sleep(Math.max(0, intervalMs));
        continue;
      }
      const ready = await this.runner.run([
        "exec",
        container,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ]);
      if (ready.exitCode === 0) return;
      if (attempt + 1 < count) await this.sleep(Math.max(0, intervalMs));
    }
    throw new Error(
      `PostgreSQL did not become ready in container "${container}". Inspect it with "docker logs ${container}".`,
    );
  }
}
