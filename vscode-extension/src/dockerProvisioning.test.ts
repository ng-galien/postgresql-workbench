import { describe, expect, it } from "vitest";
import {
  type DockerCommandResult,
  type DockerCommandRunner,
  DockerDebuggerProvisioner,
  findDockerExecutable,
} from "./dockerProvisioning.js";

function result(exitCode = 0, stdout = "", stderr = ""): DockerCommandResult {
  return { exitCode, stdout, stderr };
}

function inspect(running: boolean, managed = true): DockerCommandResult {
  return result(
    0,
    JSON.stringify([
      {
        Config: {
          Labels: managed
            ? {
                "com.ng-galien.postgresql-workbench.managed": "true",
                "com.ng-galien.postgresql-workbench.postgresql-version": "17",
              }
            : {},
        },
        State: { Running: running },
        NetworkSettings: {
          Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] },
        },
      },
    ]),
  );
}

class QueueRunner implements DockerCommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly results: DockerCommandResult[]) {}

  async run(args: readonly string[]): Promise<DockerCommandResult> {
    this.calls.push([...args]);
    const next = this.results.shift();
    if (!next) throw new Error(`Unexpected docker call: ${args.join(" ")}`);
    return next;
  }
}

describe("DockerDebuggerProvisioner", () => {
  it("pulls, starts, and waits for a new debug-ready PostgreSQL container", async () => {
    const runner = new QueueRunner([
      result(0, "27.0.0"),
      result(1, "", "Error: No such object: postgresql-workbench-pg17-55432"),
      result(0, "pulled"),
      result(0, "container-id"),
      result(0, "docker-entrypoint.sh\n"),
      result(0, "postgres\n"),
      result(0, "accepting connections"),
      result(0, "CREATE EXTENSION"),
    ]);
    const progress: string[] = [];
    const provisioner = new DockerDebuggerProvisioner(runner, async () => {});

    const connection = await provisioner.start(
      {
        version: "17",
        hostPort: 55432,
        readinessAttempts: 2,
        readinessIntervalMs: 0,
      },
      (message) => progress.push(message),
    );

    expect(connection).toMatchObject({
      containerName: "postgresql-workbench-pg17-55432",
      image: "galien0xffffff/postgres-debugger:17",
      host: "127.0.0.1",
      port: 55432,
      database: "postgres",
      user: "postgres",
      password: "postgres",
      reused: false,
    });
    expect(runner.calls[2]).toEqual(["pull", "galien0xffffff/postgres-debugger:17"]);
    expect(runner.calls[3]).toEqual([
      "run",
      "-d",
      "--name",
      "postgresql-workbench-pg17-55432",
      "--label",
      "com.ng-galien.postgresql-workbench.managed=true",
      "--label",
      "com.ng-galien.postgresql-workbench.postgresql-version=17",
      "-p",
      "127.0.0.1:55432:5432",
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=postgres",
      "galien0xffffff/postgres-debugger:17",
    ]);
    expect(progress).toContain("Waiting for PostgreSQL...");
    expect(runner.calls.at(-1)).toEqual([
      "exec",
      "postgresql-workbench-pg17-55432",
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
  });

  it("restarts an existing managed container without pulling the image", async () => {
    const runner = new QueueRunner([
      result(0, "27.0.0"),
      inspect(false),
      result(0, "postgresql-workbench-pg17-55432"),
      result(0, "postgres\n"),
      result(0, "accepting connections"),
      result(0, "NOTICE: extension already exists"),
    ]);
    const provisioner = new DockerDebuggerProvisioner(runner, async () => {});

    const connection = await provisioner.start({
      version: "17",
      hostPort: 55432,
      readinessAttempts: 1,
    });

    expect(connection.reused).toBe(true);
    expect(runner.calls).toContainEqual(["start", "postgresql-workbench-pg17-55432"]);
    expect(runner.calls.some((call) => call[0] === "pull")).toBe(false);
    expect(runner.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("does not take over a same-named user container", async () => {
    const runner = new QueueRunner([result(0, "27.0.0"), inspect(true, false)]);
    const provisioner = new DockerDebuggerProvisioner(runner);

    await expect(provisioner.start({ version: "17", hostPort: 55432 })).rejects.toThrow(
      "is not managed by PostgreSQL Workbench",
    );
    expect(runner.calls).toHaveLength(2);
  });

  it("reports a bounded readiness failure", async () => {
    const runner = new QueueRunner([
      result(0, "27.0.0"),
      inspect(true),
      result(0, "postgres\n"),
      result(1, "", "not ready"),
      result(0, "postgres\n"),
      result(1, "", "not ready"),
    ]);
    const provisioner = new DockerDebuggerProvisioner(runner, async () => {});

    await expect(
      provisioner.start({
        version: "17",
        hostPort: 55432,
        readinessAttempts: 2,
        readinessIntervalMs: 0,
      }),
    ).rejects.toThrow("docker logs postgresql-workbench-pg17-55432");
  });
});

describe("findDockerExecutable", () => {
  it("falls back to the command name when no known executable exists", () => {
    expect(findDockerExecutable("/path/that/does/not/exist", "linux")).toBe("docker");
  });
});
