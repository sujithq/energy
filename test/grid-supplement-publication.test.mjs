import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  findPublishedDayConflicts,
  publishManualSupplement,
  replaceFileAtomically,
  retryTransientWrite,
  withSupplementLock
} from "../scripts/grid-supplement-publication.mjs";

const lockWorkerPath = fileURLToPath(new URL("./fixtures/supplement-lock-worker.mjs", import.meta.url));

test("supplement publication locks serialize writers", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "supplement.json");
  const entered = deferred();
  const release = deferred();
  const order = [];

  const first = withSupplementLock(destination, async () => {
    order.push("first entered");
    entered.resolve();
    await release.promise;
    order.push("first leaving");
  });
  await entered.promise;

  const second = withSupplementLock(destination, async () => {
    order.push("second entered");
  });
  await delay(50);
  assert.deepEqual(order, ["first entered"]);

  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first entered", "first leaving", "second entered"]);
});

test("supplement publication locks serialize separate processes", { timeout: 5_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-process-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "supplement.json");
  const first = spawn(process.execPath, [lockWorkerPath, destination, "hold"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => first.kill());
  const firstOutput = observeOutput(first);
  await firstOutput.waitFor("ready");
  first.stdin.write("start\n");
  await firstOutput.waitFor("entered");

  const second = spawn(process.execPath, [lockWorkerPath, destination, "release"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => second.kill());
  const secondOutput = observeOutput(second);
  await secondOutput.waitFor("ready");
  second.stdin.write("start\n");
  await secondOutput.waitFor("locking");

  await delay(75);
  assert.equal(secondOutput.includes("entered"), false);

  first.stdin.write("release\n");
  await Promise.all([
    firstOutput.waitFor("released"),
    secondOutput.waitFor("entered"),
    waitForExit(first),
    waitForExit(second)
  ]);
});

test("supplement publication recovers a stale lock", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-stale-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "supplement.json");
  const lockPath = `${destination}.lock`;
  await mkdir(lockPath);
  const staleTime = new Date(Date.now() - 10_000);
  await utimes(lockPath, staleTime, staleTime);

  const result = await withSupplementLock(destination, async () => "recovered", {
    staleMs: 2_000,
    retryMs: 10,
    timeoutMs: 1_000
  });

  assert.equal(result, "recovered");
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("failed publication actions release their lock", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-release-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "supplement.json");
  const actionError = new Error("publication failed");

  await assert.rejects(
    withSupplementLock(destination, async () => { throw actionError; }),
    actionError
  );

  const result = await withSupplementLock(destination, async () => "next writer entered");
  assert.equal(result, "next writer entered");
});

test("publication propagates falsy thrown values", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-error-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "supplement.json");
  let rejected = false;

  try {
    await withSupplementLock(destination, async () => { throw undefined; });
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }

  assert.equal(rejected, true);
});

test("supplement replacement never writes through the published file", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-replace-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "candidate.json");
  const destination = path.join(directory, "published.json");
  await writeFile(source, "candidate");
  await writeFile(destination, "published");

  await replaceFileAtomically(source, destination);

  assert.equal(await readFile(destination, "utf8"), "candidate");
  await assert.rejects(readFile(`${destination}.next`), { code: "ENOENT" });
  await assert.rejects(readFile(`${destination}.backup`), { code: "ENOENT" });
});

test("supplement replacement checks cancellation after reading the candidate", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-abort-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "candidate.json");
  const destination = path.join(directory, "published.json");
  const interrupted = new Error("interrupted");
  let checks = 0;
  await writeFile(source, "candidate");
  await writeFile(destination, "published");

  await assert.rejects(
    replaceFileAtomically(source, destination, {
      throwIfAborted: () => {
        checks += 1;
        if (checks === 2) throw interrupted;
      }
    }),
    interrupted
  );

  assert.equal(await readFile(destination, "utf8"), "published");
});

test("atomic publication retries bounded Windows sharing errors", async () => {
  let attempts = 0;

  const result = await retryTransientWrite(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("file is busy"), { code: "EPERM" });
    return "published";
  }, { retries: 2, retryMs: 0 });

  assert.equal(result, "published");
  assert.equal(attempts, 3);
});

test("atomic publication does not retry permanent or exhausted errors", async () => {
  let permanentAttempts = 0;
  await assert.rejects(retryTransientWrite(async () => {
    permanentAttempts += 1;
    throw Object.assign(new Error("invalid destination"), { code: "EINVAL" });
  }, { retries: 2, retryMs: 0 }), { code: "EINVAL" });
  assert.equal(permanentAttempts, 1);

  let transientAttempts = 0;
  await assert.rejects(retryTransientWrite(async () => {
    transientAttempts += 1;
    throw Object.assign(new Error("file is busy"), { code: "EBUSY" });
  }, { retries: 2, retryMs: 0 }), { code: "EBUSY" });
  assert.equal(transientAttempts, 3);
});

test("manual candidates cannot remove or alter published days", () => {
  const existing = {
    days: {
      "2026-08-15": { import: [1], export: [2] },
      "2026-08-16": { import: [3], export: [4] }
    }
  };
  const candidate = {
    days: {
      "2026-08-15": { import: [9], export: [2] },
      "2026-08-17": { import: [5], export: [6] }
    }
  };

  assert.deepEqual(findPublishedDayConflicts(existing, candidate), {
    missingDates: ["2026-08-16"],
    changedDates: ["2026-08-15"]
  });
});

test("manual publication preserves conflicting published data", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-conflict-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "candidate.json");
  const destination = path.join(directory, "published.json");
  const published = gridSupplement({
    "2026-08-15": { import: [1], export: [2] },
    "2026-08-16": { import: [3], export: [4] }
  });
  const candidate = gridSupplement({
    "2026-08-15": { import: [9], export: [2] }
  });
  const publishedText = JSON.stringify(published);
  await writeFile(destination, publishedText);
  await writeFile(source, JSON.stringify(candidate));

  const result = await publishManualSupplement(source, destination);

  assert.deepEqual(result, {
    published: false,
    completeDays: 1,
    through: "2026-08-15",
    missingDays: 1,
    changedDays: 1
  });
  assert.equal(await readFile(destination, "utf8"), publishedText);
});

test("manual publication accepts identical history plus new days", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supplement-extension-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "candidate.json");
  const destination = path.join(directory, "published.json");
  const existingDay = { import: [1], export: [2] };
  const candidate = gridSupplement({
    "2026-08-15": existingDay,
    "2026-08-16": { import: [3], export: [4] }
  });
  await writeFile(destination, JSON.stringify(gridSupplement({ "2026-08-15": existingDay })));
  await writeFile(source, JSON.stringify(candidate));

  const result = await publishManualSupplement(source, destination);

  assert.equal(result.published, true);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), candidate);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gridSupplement(days) {
  return { schemaVersion: 1, days };
}

function observeOutput(child) {
  let output = "";
  const waiters = new Set();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (const waiter of waiters) {
      if (output.includes(waiter.expected)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });

  return {
    includes: (expected) => output.includes(expected),
    waitFor(expected) {
      if (output.includes(expected)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { expected, resolve, reject };
        waiters.add(waiter);
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!output.includes(expected)) reject(new Error(`Worker exited with code ${code}.`));
        });
      });
    }
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Worker exited with code ${code}.`));
    });
  });
}
