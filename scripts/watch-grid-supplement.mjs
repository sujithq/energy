import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEBOUNCE_MS = 750;
const RETRY_MS = 1500;
const [, , dataDirectoryArgument = "data", outputPathArgument = "data/grid-supplement.json"] = process.argv;
const dataDirectory = path.resolve(dataDirectoryArgument);
const outputPath = path.resolve(outputPathArgument);
const generatorPath = fileURLToPath(new URL("./build-grid-supplement.mjs", import.meta.url));
const directoryLabel = path.relative(process.cwd(), dataDirectory) || ".";

let debounceTimer = null;
let lastSuccessfulHash = null;
let pending = false;
let running = false;

await refreshSupplement();

console.log(`Watching ${directoryLabel} for Fluvius CSV content changes.`);

const watcher = watch(dataDirectory, (eventType, filename) => {
  if (filename && !filename.toString().toLowerCase().endsWith(".csv")) return;
  scheduleRefresh(DEBOUNCE_MS);
});

watcher.on("error", (error) => {
  console.error(`Fluvius CSV watcher failed: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    watcher.close();
    process.exit(0);
  });
}

function scheduleRefresh(delay) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void refreshSupplement(), delay);
}

async function refreshSupplement() {
  if (running) {
    pending = true;
    return;
  }

  running = true;
  try {
    const inputPath = await findNewestCsv();
    if (!inputPath) {
      console.log(`No Fluvius CSV found in ${directoryLabel || dataDirectory}.`);
      return;
    }

    const contentHash = await hashFile(inputPath);
    if (contentHash === lastSuccessfulHash) return;

    await runGenerator(inputPath);
    lastSuccessfulHash = contentHash;
    console.log(`Grid supplement refreshed at ${new Date().toLocaleTimeString()}.`);
  } catch (error) {
    console.error(`Grid supplement refresh failed: ${error.message}`);
    scheduleRefresh(RETRY_MS);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      scheduleRefresh(DEBOUNCE_MS);
    }
  }
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

async function runGenerator(inputPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [generatorPath, inputPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let standardOutput = "";
    let standardError = "";

    child.stdout.on("data", (chunk) => { standardOutput += chunk; });
    child.stderr.on("data", (chunk) => { standardError += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        if (standardOutput.trim()) console.log(standardOutput.trim());
        resolve();
        return;
      }
      reject(new Error(standardError.trim() || standardOutput.trim() || `Generator exited with code ${code}.`));
    });
  });
}