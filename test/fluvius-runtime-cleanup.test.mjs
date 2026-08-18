import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFluviusRuntimeCleanup, stopChildProcess } from "../scripts/fluvius-runtime-cleanup.mjs";

const workerPath = fileURLToPath(new URL("./fixtures/fluvius-interrupt-worker.mjs", import.meta.url));

test("interrupt cleanup closes the browser and removes temporary raw data", { timeout: 5_000 }, async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "fluvius-interrupt-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const child = spawn(process.execPath, [workerPath, temporaryRoot], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => child.kill());
  await waitForOutput(child, "ready");

  const beforeInterrupt = await readdir(temporaryRoot);
  assert.equal(beforeInterrupt.some((entry) => entry.startsWith("fluvius-sync-")), true);

  child.stdin.end("interrupt\ninterrupt\n");
  await waitForExit(child);

  const afterInterrupt = await readdir(temporaryRoot);
  assert.equal(afterInterrupt.some((entry) => entry.startsWith("fluvius-sync-")), false);
  assert.equal(await readFile(path.join(temporaryRoot, "browser-closed"), "utf8"), "closed");
});

test("cleanup retries transient temporary directory removal without forgetting the directory", async () => {
  let removalAttempts = 0;
  let removalFailures = 0;
  const cleanup = createFluviusRuntimeCleanup({
    removeTemporaryDirectory: async () => {
      removalAttempts += 1;
      if (removalAttempts === 1) {
        throw Object.assign(new Error("file is busy"), { code: "EPERM" });
      }
    },
    temporaryDataRemovalRetries: 1,
    temporaryDataRemovalRetryMs: 0,
    onTemporaryDataRemovalFailure: () => { removalFailures += 1; }
  });
  cleanup.setTemporaryDirectory("private-temporary-directory");

  await cleanup.cleanup();

  assert.equal(removalAttempts, 2);
  assert.equal(removalFailures, 0);
});

test("cleanup force-closes the browser server when graceful close fails", async () => {
  let gracefulCloseAttempts = 0;
  let forcedCloseAttempts = 0;
  let browserCloseFailures = 0;
  const cleanup = createFluviusRuntimeCleanup({
    onBrowserCloseFailure: () => { browserCloseFailures += 1; }
  });
  cleanup.setBrowser({
    close: async () => {
      gracefulCloseAttempts += 1;
      throw new Error("browser did not close gracefully");
    },
    forceClose: async () => { forcedCloseAttempts += 1; }
  });

  await cleanup.cleanup();

  assert.equal(gracefulCloseAttempts, 1);
  assert.equal(forcedCloseAttempts, 1);
  assert.equal(browserCloseFailures, 0);
});

test("uncooperative sanitizer receives platform-appropriate forced termination", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  let gracefulSignals = 0;
  let forcedTermination = 0;

  await stopChildProcess(child, {
    graceMs: 0,
    forceStopTimeoutMs: 0,
    signalProcessTree: async () => { gracefulSignals += 1; },
    forceTerminateProcessTree: async () => {
      forcedTermination += 1;
      child.exitCode = 0;
      child.emit("exit", 0);
    }
  });

  assert.equal(gracefulSignals, process.platform === "win32" ? 0 : 1);
  assert.equal(forcedTermination, 1);
});

test("Windows process-tree cleanup terminates a real child process", {
  skip: process.platform !== "win32",
  timeout: 10_000
}, async (context) => {
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  context.after(() => child.kill());
  await waitForSpawn(child);

  await stopChildProcess(child, { forceStopTimeoutMs: 5_000 });
  await waitForExit(child);
});

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (chunk) => {
      output += chunk;
      if (output.includes(expected)) resolve();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Worker exited before signaling readiness with code ${code}.`)));
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}