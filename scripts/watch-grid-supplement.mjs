import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { publishManualSupplement } from "./grid-supplement-publication.mjs";
import { sanitizeGridExport } from "./grid-supplement-sanitizer.mjs";

const DEBOUNCE_MS = 750;
const RETRY_MS = 1500;
const [, , dataDirectoryArgument = "data", outputPathArgument = "data/grid-supplement.json"] = process.argv;
const dataDirectory = path.resolve(dataDirectoryArgument);
const outputPath = path.resolve(outputPathArgument);

let debounceTimer = null;
let activeRefresh = null;
let lastSuccessfulHash = null;
let pending = false;
let stopping = false;

const watcher = createWatcher();
if (watcher) {
  watcher.on("error", () => {
    console.error("Fluvius CSV watcher failed; no published data was changed.");
    process.exitCode = 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void stopWatcher());
  }

  await refreshSupplement();
  console.log("Watching the configured data directory for Fluvius CSV content changes.");
}

function createWatcher() {
  try {
    return watch(dataDirectory, (eventType, filename) => {
      if (filename && !filename.toString().toLowerCase().endsWith(".csv")) return;
      scheduleRefresh(DEBOUNCE_MS);
    });
  } catch {
    console.error("Fluvius CSV watcher could not start; no published data was changed.");
    process.exitCode = 1;
    return null;
  }
}

function scheduleRefresh(delay) {
  if (stopping) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void refreshSupplement(), delay);
}

function refreshSupplement() {
  if (stopping) return Promise.resolve();
  if (activeRefresh) {
    pending = true;
    return activeRefresh;
  }

  activeRefresh = performRefresh();
  return activeRefresh;
}

async function performRefresh() {
  try {
    const inputPath = await findNewestCsv();
    if (!inputPath) {
      console.log("No Fluvius CSV found in the configured data directory.");
      return;
    }

    const contentHash = await hashFile(inputPath);
    if (contentHash === lastSuccessfulHash) return;

    const published = await publishCandidate(inputPath);
    lastSuccessfulHash = contentHash;
    if (published) console.log(`Grid supplement refreshed at ${new Date().toLocaleTimeString()}.`);
  } catch {
    console.error("Grid supplement refresh failed; no published data was changed.");
    if (!stopping) scheduleRefresh(RETRY_MS);
  } finally {
    activeRefresh = null;
    if (pending && !stopping) {
      pending = false;
      scheduleRefresh(DEBOUNCE_MS);
    }
  }
}

async function stopWatcher() {
  if (stopping) return;
  stopping = true;
  pending = false;
  clearTimeout(debounceTimer);
  debounceTimer = null;
  watcher.close();
  await activeRefresh;
}

async function findNewestCsv() {
  const entries = await readdir(dataDirectory, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map(async (entry) => {
      const filePath = path.join(dataDirectory, entry.name);
      const fileStats = await stat(filePath);
      return { filePath, modified: fileStats.mtimeMs };
    }));

  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0]?.filePath || null;
}

async function hashFile(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function publishCandidate(inputPath) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fluvius-watch-"));
  const candidatePath = path.join(temporaryDirectory, "grid-supplement.json");
  try {
    await sanitizeGridExport(inputPath, candidatePath);
    const result = await publishManualSupplement(candidatePath, outputPath);
    if (result.published) return true;

    const conflicts = [];
    if (result.missingDays) conflicts.push(`remove ${result.missingDays}`);
    if (result.changedDays) conflicts.push(`change ${result.changedDays}`);
    console.log(`Skipped local CSV refresh because it would ${conflicts.join(" and ")} published day(s).`);
    return false;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
