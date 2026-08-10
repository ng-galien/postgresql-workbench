import { spawnSync } from "node:child_process";

function run(script) {
  const result = spawnSync("npm", ["run", script], { stdio: "inherit" });
  return result.status ?? 1;
}

const prefix = process.argv[2] ? `test:e2e:${process.argv[2]}` : "test:e2e";
const setupStatus = run(`${prefix}:up`);
const testStatus = setupStatus === 0 ? run(`${prefix}:run`) : setupStatus;
const cleanupStatus = run(`${prefix}:down`);

process.exit(testStatus === 0 ? cleanupStatus : testStatus);
