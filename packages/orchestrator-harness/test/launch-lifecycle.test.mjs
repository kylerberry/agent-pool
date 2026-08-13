import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startLaunch } from "../scripts/launch.mjs";
import { createFixture, baseChildEnv } from "./helpers/fixture.mjs";

function runtimeFactory(fixture, calls) {
  return () => {
    const path = fixture.makeDir("runtime-owned-parent");
    const home = join(path, "home");
    const xdg = join(path, "xdg");
    mkdirSync(home); mkdirSync(xdg);
    return { path, home, xdg };
  };
}
function fakeChild() {
  const child = new EventEmitter();
  child.kill = (signal) => { child.signal = signal; return true; };
  return child;
}
function controlledEnv(fixture) {
  const launcher = fixture.writeLauncher();
  const workspace = fixture.makeDir("workspace");
  return baseChildEnv({ AGENT_POOL_LAUNCHER: join(launcher, "pi"), AGENT_POOL_WORKSPACE: workspace });
}

for (const [name, events, expectedCode] of [
  ["preflight nonzero exit", [["exit", 1]], 1],
  ["preflight spawn error", [["error", new Error("preflight")]], 1],
  ["decomposition nonzero exit", [["exit", 0], ["exit", 1]], 1],
  ["decomposition spawn error", [["exit", 0], ["error", new Error("decomposition")]], 1],
]) {
  test(`startLaunch cleans its exact runtime path after ${name}`, async (t) => {
    const fixture = createFixture(t); const children = []; const cleanupCalls = []; let runtime;
    const launch = startLaunch({ env: controlledEnv(fixture), signals: new EventEmitter(), onExit: () => {}, onRuntime: (value) => { runtime = value; },
      createRuntimeParent: runtimeFactory(fixture), cleanupRuntimeParent: (path) => { cleanupCalls.push(path); rmSync(path, { recursive: true, force: true }); },
      spawnChild: () => { const child = fakeChild(); children.push(child); return child; },
    });
    for (let index = 0; index < events.length; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      children[index].emit(...events[index]);
    }
    const result = await launch;
    assert.equal(result.code, expectedCode);
    assert.deepEqual(cleanupCalls, [runtime.path]);
    assert.equal(existsSync(runtime.path), false);
  });
}

test("startLaunch forwards SIGTERM after child readiness and cleans exactly once", async (t) => {
  const fixture = createFixture(t); const signals = new EventEmitter(); const cleanupCalls = []; const ready = Promise.withResolvers(); let runtime; let child;
  const launch = startLaunch({ env: controlledEnv(fixture), signals, onExit: () => {}, onRuntime: (value) => { runtime = value; },
    createRuntimeParent: runtimeFactory(fixture), cleanupRuntimeParent: (path) => { cleanupCalls.push(path); rmSync(path, { recursive: true, force: true }); },
    spawnChild: () => { child = fakeChild(); ready.resolve(); return child; },
  });
  await ready.promise;
  signals.emit("SIGTERM");
  const result = await launch;
  assert.equal(result.code, 143);
  assert.equal(child.signal, "SIGTERM");
  assert.deepEqual(cleanupCalls, [runtime.path]);
  assert.equal(existsSync(runtime.path), false);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});
