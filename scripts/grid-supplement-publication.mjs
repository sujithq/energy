import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 40_000;
const STALE_LOCK_MS = 30_000;
const WRITE_RETRIES = 20;
const WRITE_RETRY_MS = 100;
const TRANSIENT_WRITE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function withSupplementLock(destination, action, options = {}) {
  const retryMs = Math.max(1, options.retryMs ?? LOCK_RETRY_MS);
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  const release = await lockfile.lock(destination, {
    realpath: false,
    stale: staleMs,
    update: Math.max(1_000, Math.floor(staleMs / 2)),
    retries: {
      retries: Math.max(0, Math.ceil(timeoutMs / retryMs) - 1),
      factor: 1,
      minTimeout: retryMs,
      maxTimeout: retryMs,
      randomize: false
    }
  });

  let result;
  let actionFailed = false;
  let actionError;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  try {
    await release();
  } catch (releaseError) {
    if (actionFailed) {
      throw new AggregateError(
        [actionError, releaseError],
        "Grid supplement publication and lock release both failed."
      );
    }
    throw releaseError;
  }

  if (actionFailed) throw actionError;
  return result;
}

export async function replaceFileAtomically(source, destination, options = {}) {
  options.throwIfAborted?.();
  const contents = await readFile(source);
  options.throwIfAborted?.();
  await retryTransientWrite(
    () => {
      options.throwIfAborted?.();
      return writeFileAtomic(destination, contents);
    },
    { retries: WRITE_RETRIES, retryMs: WRITE_RETRY_MS }
  );
  options.throwIfAborted?.();
}

export async function retryTransientWrite(operation, options = {}) {
  const retries = Math.max(0, options.retries ?? WRITE_RETRIES);
  const retryMs = Math.max(0, options.retryMs ?? WRITE_RETRY_MS);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_WRITE_ERRORS.has(error?.code) || attempt >= retries) throw error;
      await delay(retryMs);
    }
  }
}

export function findPublishedDayConflicts(existing, candidate) {
  const existingDates = existing ? Object.keys(existing.days) : [];
  return {
    missingDates: existingDates.filter((date) => !candidate.days[date]),
    changedDates: existingDates.filter((date) => candidate.days[date]
      && !isDeepStrictEqual(existing.days[date], candidate.days[date]))
  };
}

export async function publishManualSupplement(source, destination) {
  const candidate = await readSupplement(source);
  const dates = Object.keys(candidate.days).sort();

  return withSupplementLock(destination, async () => {
    const existing = await readSupplement(destination, true);
    const { missingDates, changedDates } = findPublishedDayConflicts(existing, candidate);
    const result = {
      published: false,
      completeDays: dates.length,
      through: dates.at(-1),
      missingDays: missingDates.length,
      changedDays: changedDates.length
    };

    if (missingDates.length || changedDates.length) return result;

    await replaceFileAtomically(source, destination);
    return { ...result, published: true };
  });
}

async function readSupplement(filePath, optional = false) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw new Error("The grid supplement could not be read.");
  }

  let supplement;
  try {
    supplement = JSON.parse(raw);
  } catch {
    throw new Error("The grid supplement is not valid JSON.");
  }
  if (supplement?.schemaVersion !== 1 || !supplement.days || typeof supplement.days !== "object") {
    throw new Error("The grid supplement does not match schema version 1.");
  }
  return supplement;
}
