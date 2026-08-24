import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("one-time import failures do not print private paths", async () => {
  const privateMarker = "private-import-path-marker";
  const input = path.join(os.tmpdir(), privateMarker, "input.csv");
  const output = path.join(os.tmpdir(), privateMarker, "output.json");

  const result = await runNode("scripts/publish-grid-supplement.mjs", input, output);

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /refresh failed; no published data was changed/);
});

test("one-time import temp setup failures do not print private paths", async () => {
  const privateMarker = "private-temp-root-marker";
  const missingTempRoot = path.join(os.tmpdir(), privateMarker, "missing");
  const result = await runNode("scripts/publish-grid-supplement.mjs", "input.csv", {
    env: cleanChildEnvironment({
      TEMP: missingTempRoot,
      TMP: missingTempRoot,
      TMPDIR: missingTempRoot
    })
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /refresh failed; no published data was changed/);
});

test("authenticated sync does not repeat a malformed private URL", async () => {
  const privateMarker = "private-detail-url-marker";
  const result = await runNode("scripts/sync-fluvius.mjs", {
    env: cleanChildEnvironment({
      FLUVIUS_EMAIL: "test@example.invalid",
      FLUVIUS_PASSWORD: "test-password",
      FLUVIUS_DETAIL_URL: privateMarker
    })
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /must be an HTTPS mijn\.fluvius\.be URL/);
});

test("authenticated sync temp setup failures do not print private paths", async () => {
  const privateMarker = "private-sync-temp-root-marker";
  const missingTempRoot = path.join(os.tmpdir(), privateMarker, "missing");
  const result = await runNode("scripts/sync-fluvius.mjs", {
    env: cleanChildEnvironment({
      TEMP: missingTempRoot,
      TMP: missingTempRoot,
      TMPDIR: missingTempRoot,
      FLUVIUS_EMAIL: "test@example.invalid",
      FLUVIUS_PASSWORD: "test-password",
      FLUVIUS_DETAIL_URL: "https://mijn.fluvius.be/verbruik/000000000000000000/detail"
    })
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /Temporary Fluvius workspace could not be created/);
});

test("authenticated sync hides arbitrary output paths", async () => {
  const privateMarker = "private-sync-output-marker";
  const output = path.join(os.tmpdir(), privateMarker, "missing", "supplement.json");
  const result = await runNode("scripts/sync-fluvius.mjs", {
    env: cleanChildEnvironment({
      FLUVIUS_EMAIL: "test@example.invalid",
      FLUVIUS_PASSWORD: "test-password",
      FLUVIUS_DETAIL_URL: "https://mijn.fluvius.be/verbruik/000000000000000000/detail",
      FLUVIUS_OUTPUT: output
    })
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /refresh failed; no published data was changed/);
});

test("API sync requires a meter serial without repeating private configuration", async () => {
  const privateMarker = "private-api-detail-marker";
  const result = await runNode("scripts/sync-fluvius.mjs", {
    env: cleanChildEnvironment({
      FLUVIUS_EMAIL: "test@example.invalid",
      FLUVIUS_PASSWORD: "test-password",
      FLUVIUS_DETAIL_URL: `https://mijn.fluvius.be/verbruik/000000000000000000/detail?marker=${privateMarker}`,
      FLUVIUS_TRANSPORT: "api"
    })
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /FLUVIUS_METER_SERIAL is required/);
});

test("API sync never prints a configured meter serial", async () => {
  const privateMarker = "private-meter-serial-marker";
  const result = await runNode("scripts/sync-fluvius.mjs", {
    env: cleanChildEnvironment({
      FLUVIUS_EMAIL: "test@example.invalid",
      FLUVIUS_PASSWORD: "test-password",
      FLUVIUS_DETAIL_URL: "https://mijn.fluvius.be/verbruik/000000000000000000/detail",
      FLUVIUS_METER_SERIAL: privateMarker,
      FLUVIUS_TRANSPORT: "api",
      FLUVIUS_FROM_DATE: "not-a-date"
    })
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /FLUVIUS_FROM_DATE must use YYYY-MM-DD/);
});

test("watcher startup failures do not print private paths", async () => {
  const privateMarker = "private-watcher-path-marker";
  const dataDirectory = path.join(os.tmpdir(), privateMarker, "missing");
  const output = path.join(os.tmpdir(), privateMarker, "output.json");

  const result = await runNode("scripts/watch-grid-supplement.mjs", dataDirectory, output);

  assert.equal(result.code, 1);
  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /watcher could not start; no published data was changed/);
});

test("watcher sanitizer failures do not print private paths", { timeout: 5_000 }, async (context) => {
  const privateMarker = "private-watcher-csv-marker-";
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), privateMarker));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(path.join(dataDirectory, "input.csv"), "not a Fluvius export");
  const output = path.join(dataDirectory, "output.json");

  const result = await runNodeUntil(
    "scripts/watch-grid-supplement.mjs",
    [dataDirectory, output],
    "Grid supplement refresh failed; no published data was changed."
  );

  assert.equal(result.output.includes(privateMarker), false);
  assert.match(result.output, /refresh failed; no published data was changed/);
});

function runNode(script, ...parameters) {
  const options = parameters.at(-1)?.env ? parameters.pop() : {};
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repositoryRoot, script), ...parameters], {
      cwd: repositoryRoot,
      env: cleanChildEnvironment(options.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

function runNodeUntil(script, arguments_, expected) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repositoryRoot, script), ...arguments_], {
      cwd: repositoryRoot,
      env: cleanChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let matched = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for path-free watcher failure output."));
    }, 4_000);

    const collect = (chunk) => {
      output += chunk;
      if (!matched && output.includes(expected)) {
        matched = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (matched) resolve({ code, output });
      else reject(new Error(`Watcher exited before expected output with code ${code}.`));
    });
  });
}

function cleanChildEnvironment(overrides = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("FLUVIUS_"))
  );
  return { ...environment, ...overrides };
}