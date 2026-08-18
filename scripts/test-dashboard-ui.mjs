import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const dashboardRoot = process.env.ENERGY_DASHBOARD_ROOT
  ? path.resolve(process.env.ENERGY_DASHBOARD_ROOT)
  : repositoryRoot;
const DATA_URL_PATTERN = "https://raw.githubusercontent.com/**";
const CHART_URL_PATTERN = "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/**";
const LUCIDE_URL_PATTERN = "https://unpkg.com/lucide@0.468.0/**";
const MIME_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json"
};

const fixtureData = {
  2026: [
    fixtureRecord(1, intervalProfile({ importHours: [18], exportHours: [12] })),
    fixtureRecord(2, autumnIntervalProfile()),
    fixtureRecord(3, null)
  ]
};

let server;
let browser;

try {
  server = await startStaticServer();
  browser = await chromium.launch(await browserLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await installFixtureRoutes(page);

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await openDashboard(page, `${baseUrl}/?view=year&date=2026-01-02`);
  await verifyClockSelection(page);
  await openDashboard(page, `${baseUrl}/?view=day&date=2026-01-02`);
  await verifyAutumnProfile(page);

  await openDashboard(page, `${baseUrl}/?view=day&date=2026-01-03`);
  await page.locator("#gridClock .grid-clock-empty").waitFor();
  assert.equal(await page.locator("#gridClockLegend").isHidden(), true);

  await page.setViewportSize({ width: 640, height: 900 });
  await openDashboard(page, `${baseUrl}/?view=year&date=2026-01-02`);
  const layout = await page.locator(".grid-clock-body").evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns
  ));
  assert.equal(layout.trim().includes(" "), false, "Clock must stack at 640px.");
  assert.equal(await page.locator(".grid-clock-section").evaluate((element) => (
    element.scrollWidth > element.clientWidth
  )), false, "Clock panel must not overflow at 640px.");
  assert.equal(errors.length, 0, `Dashboard reported browser errors: ${errors.join(" | ")}`);

  console.log("dashboard-ui-grid-clock-ok");
} finally {
  await browser?.close().catch(() => {});
  await closeServer(server);
}

async function installFixtureRoutes(page) {
  await page.route(DATA_URL_PATTERN, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(fixtureData)
  }));
  await page.route(CHART_URL_PATTERN, (route) => route.fulfill({
    contentType: "text/javascript",
    body: "function Chart(){this.destroy=function(){};} Chart.defaults={font:{}}; Chart.register=function(){}; window.Chart=Chart;"
  }));
  await page.route(LUCIDE_URL_PATTERN, (route) => route.fulfill({
    contentType: "text/javascript",
    body: "window.lucide={createIcons:function(){}};"
  }));
}

async function openDashboard(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#app:not([hidden])").waitFor({ timeout: 30_000 });
}

async function verifyClockSelection(page) {
  const clock = page.locator("#gridClock");
  assert.equal(await clock.locator("button[role=radio]").count(), 24);
  const selected = clock.locator("button[aria-checked=true]");
  const previousHour = await selected.getAttribute("data-grid-clock-hour");
  await selected.press("ArrowRight");
  const selectedHour = await clock.locator("button[aria-checked=true]").getAttribute("data-grid-clock-hour");
  assert.notEqual(selectedHour, previousHour);
  const expectedRange = hourRange(Number(selectedHour));
  assert.equal(await clock.locator(".grid-clock-center-hour").innerText(), expectedRange);
  assert.equal(await clock.locator(".grid-clock-readout > strong").innerText(), expectedRange);
}

async function verifyAutumnProfile(page) {
  const selectedHour = page.locator('#gridClock button[data-grid-clock-hour="2"]');
  await selectedHour.click();
  const readout = await page.locator("#gridClock .grid-clock-readout").innerText();
  assert.match(readout, /Import-dominant/);
  assert.match(readout, /8\.0 kWh/);
}

async function startStaticServer() {
  const serverInstance = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(dashboardRoot, relativePath);
      if (!filePath.startsWith(`${dashboardRoot}${path.sep}`) && filePath !== path.join(dashboardRoot, "index.html")) {
        response.writeHead(403).end();
        return;
      }
      const content = await readFile(filePath);
      response.writeHead(200, { "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(0, "127.0.0.1", resolve);
  });
  return serverInstance;
}

async function browserLaunchOptions() {
  const configuredPath = process.env.ENERGY_TEST_BROWSER;
  if (configuredPath) return { executablePath: configuredPath, headless: true };

  const systemChrome = process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : null;
  if (systemChrome && await exists(systemChrome)) {
    return { executablePath: systemChrome, headless: true };
  }
  return { headless: true };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function closeServer(serverInstance) {
  if (!serverInstance) return;
  await new Promise((resolve) => serverInstance.close(resolve));
}

function fixtureRecord(day, profile) {
  const common = { D: day, P: 4, U: 2, I: 1000, J: true, S: true, M: true, MS: {} };
  return profile ? { ...common, Q: { C: profile.import, I: profile.export } } : common;
}

function intervalProfile({ importHours = [], exportHours = [] } = {}) {
  const importValues = Array(96).fill(0);
  const exportValues = Array(96).fill(0);
  importHours.forEach((hour) => importValues.splice(hour * 4, 4, ...Array(4).fill(1)));
  exportHours.forEach((hour) => exportValues.splice(hour * 4, 4, ...Array(4).fill(1)));
  return { import: importValues, export: exportValues };
}

function autumnIntervalProfile() {
  return {
    import: [...Array(8).fill(0), ...Array(4).fill(1), ...Array(4).fill(3), ...Array(84).fill(0)],
    export: Array(100).fill(0)
  };
}

function hourRange(hour) {
  return `${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00`;
}