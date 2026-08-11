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
  try {
    compose(["up", "-d", "--build", "--wait"]);
  } catch (error) {
    stopDemoDatabase(true);
    throw error;
  }
  return {
    stop() {
      stopDemoDatabase(false);
    },
  };
}

function stopDemoDatabase(bestEffort: boolean): void {
  if (process.env.PGWB_ACCEPTANCE_KEEP_DEMO === "1") return;
  try {
    compose(["down", "-v"]);
  } catch (error) {
    if (!bestEffort) throw error;
  }
}

function compose(args: string[], capture = false): string {
  return execFileSync("docker", ["compose", "-f", demoCompose, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
}
