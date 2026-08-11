import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(__dirname, "../../..");
const demoCompose = resolve(repositoryRoot, "demo", "docker-compose.yml");

export const demoConnectionUrl = "postgresql://postgres:postgres@localhost:5434/demo";

export function startDemoDatabase(): { stop(): void } {
  const running = compose(["ps", "--status", "running", "--services"], true)
    .split(/\r?\n/)
    .includes("postgres");
  if (running) return { stop() {} };
  compose(["up", "-d", "--build", "--wait"]);
  return {
    stop() {
      if (process.env.PGWB_ACCEPTANCE_KEEP_DEMO !== "1") compose(["down", "-v"]);
    },
  };
}

function compose(args: string[], capture = false): string {
  return execFileSync("docker", ["compose", "-f", demoCompose, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
}
