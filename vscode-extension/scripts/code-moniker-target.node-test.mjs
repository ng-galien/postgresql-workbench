import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_MONIKER_TARGETS,
  hostCodeMonikerTarget,
  resolveCodeMonikerTarget,
  targetFromPlatform,
} from "./code-moniker-target.mjs";

test("the host target is the only accepted native VSIX target", () => {
  const host = hostCodeMonikerTarget();
  assert.equal(resolveCodeMonikerTarget(), host);
  assert.equal(resolveCodeMonikerTarget(host), host);

  const foreign = Object.keys(CODE_MONIKER_TARGETS).find((target) => target !== host);
  assert.ok(foreign);
  assert.throws(() => resolveCodeMonikerTarget(foreign), /must run on their target host/);
});

test("platform and architecture map to one declared target", () => {
  for (const [target, specification] of Object.entries(CODE_MONIKER_TARGETS)) {
    assert.equal(targetFromPlatform(specification.platform, specification.architecture), target);
  }
  assert.equal(targetFromPlatform("aix", "ppc64"), undefined);
});
