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
const GRID_SUPPLEMENT_PATTERN = "**/data/grid-supplement.json";
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
    fixtureRecord(3, null),
    fixtureRecord(32, intervalProfile({ importHours: [18] }), { M: false, MS: {}, SRS: null }),
    fixtureRecord(60, springForwardIntervalProfile())
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
  await verifyOvernightProfile(page);
  await verifyPeakTiming(page);
  await verifyDailyDistribution(page);
  await verifyWeatherScatter(page);
  await openDashboard(page, `${baseUrl}/?view=year&date=2026-01-02`);
  await verifyGoodSolarScorecard(page);
  await openDashboard(page, `${baseUrl}/?view=day&date=2026-01-02`);
  await verifyAutumnProfile(page);
  await page.locator("#peakTiming .peak-timing-empty").waitFor();
  assert.equal(await page.locator("#weatherSection").isHidden(), true);

  await openDashboard(page, `${baseUrl}/?view=day&date=2026-01-03`);
  await page.locator("#gridClock .grid-clock-empty").waitFor();
  assert.equal(await page.locator("#gridClockLegend").isHidden(), true);
  await page.locator("#overnightProfile .overnight-empty").waitFor();
  assert.equal(await page.locator("#distributionSection").isHidden(), true);

  await openDashboard(page, `${baseUrl}/?view=month&date=2026-02-01`);
  const noPositiveExportControl = page.locator('#peakTimingControls button[data-peak-timing-metric="export"]');
  await noPositiveExportControl.click();
  await page.locator("#peakTiming .peak-timing-empty").waitFor();
  assert.match(await page.locator("#peakTimingSubtitle").innerText(), /none had positive export/);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-peak-timing-metric")), "export");
  await page.locator("#weatherScatter .weather-empty").waitFor();

  await openDashboard(page, `${baseUrl}/?view=month&date=2026-03-01`);
  assert.match(await page.locator("#overnightSubtitle").innerText(), /1 daylight-saving window was excluded/);

  await page.setViewportSize({ width: 640, height: 900 });
  await openDashboard(page, `${baseUrl}/?view=year&date=2026-01-02`);
  const layout = await page.locator(".grid-clock-body").evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns
  ));
  assert.equal(layout.trim().includes(" "), false, "Clock must stack at 640px.");
  assert.equal(await page.locator(".grid-clock-section").evaluate((element) => (
    element.scrollWidth > element.clientWidth
  )), false, "Clock panel must not overflow at 640px.");

  await page.setViewportSize({ width: 390, height: 844 });
  await openDashboard(page, `${baseUrl}/?view=year&date=2026-01-02`);
  const peakScroll = page.locator(".peak-timing-scroll");
  assert.equal(await peakScroll.getAttribute("tabindex"), "0");
  assert.equal(await peakScroll.evaluate((element) => element.scrollWidth > element.clientWidth), true);
  assert.equal(await page.locator("#overnightProfile button[role=radio]").count(), 6);
  assert.equal(await page.locator(".overnight-section").evaluate((element) => (
    element.scrollWidth > element.clientWidth
  )), false, "Overnight panel must not overflow on mobile.");
  assert.equal(await page.locator(".good-solar-section").evaluate((element) => (
    element.scrollWidth > element.clientWidth
  )), false, "Good solar scorecard must not overflow on mobile.");
  assert.equal(await page.locator(".distribution-section").evaluate((element) => (
    element.scrollWidth > element.clientWidth
  )), false, "Daily distribution panel must not overflow on mobile.");
  assert.equal(await page.locator("#weatherScatter button[role=radio]").count(), 4);
  assert.equal(await page.locator(".weather-section").evaluate((element) => (
    element.scrollWidth > element.clientWidth
  )), false, "Weather scatter must not overflow on mobile.");
  assert.equal(errors.length, 0, `Dashboard reported browser errors: ${errors.join(" | ")}`);

  console.log("dashboard-ui-smoke-ok");
} finally {
  await browser?.close().catch(() => {});
  await closeServer(server);
}

async function installFixtureRoutes(page) {
  await page.route(DATA_URL_PATTERN, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(fixtureData)
  }));
  await page.route(GRID_SUPPLEMENT_PATTERN, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ schemaVersion: 1, unit: "kWh", days: {} })
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

async function verifyOvernightProfile(page) {
  const panel = page.locator(".overnight-section");
  assert.equal(await panel.locator("#overnightSummary .overnight-metric").count(), 3);
  assert.equal(await panel.locator("#overnightProfile button[role=radio]").count(), 6);
  const selected = panel.locator("#overnightProfile button[aria-checked=true]");
  await selected.press("ArrowRight");
  const selectedHour = await panel.locator("#overnightProfile button[aria-checked=true]").getAttribute("data-overnight-hour");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-overnight-hour")), selectedHour);
  assert.match(await panel.locator("#overnightReadout").innerText(), /DST-normalized overnight windows/);
}

async function verifyPeakTiming(page) {
  const panel = page.locator("#peakTiming");
  assert.equal(await panel.locator("button.peak-timing-cell").count(), 72);
  assert.equal(await page.locator('#peakTimingControls button[role="radio"]').count(), 2);
  const importControl = page.locator('#peakTimingControls button[data-peak-timing-metric="import"]');
  assert.equal(await importControl.getAttribute("aria-checked"), "true");
  await importControl.press("ArrowRight");
  const exportControl = page.locator('#peakTimingControls button[data-peak-timing-metric="export"]');
  assert.equal(await exportControl.getAttribute("aria-checked"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-peak-timing-metric")), "export");
  const exportPeak = panel.locator("button.peak-timing-cell:not(.is-empty)").first();
  await exportPeak.click();
  assert.match(await page.locator("#peakTimingReadout").innerText(), /daily export peaks/);
}

async function verifyGoodSolarScorecard(page) {
  const panel = page.locator("#goodSolarSection");
  assert.equal(await panel.locator("button.good-solar-card").count(), 3);
  assert.match(await panel.locator("#goodSolarMethod").innerText(), /self-sufficiency 40%/);
  await panel.locator("button.good-solar-card").first().click();
  await page.locator("#dayDetailSection:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "dayDetailTitle");
  assert.equal(await panel.isHidden(), true);
}

async function verifyDailyDistribution(page) {
  const panel = page.locator("#distributionSection");
  assert.equal(await panel.locator("#distributionControls button[role=radio]").count(), 4);
  assert.equal(await panel.locator("#distributionRows button.distribution-row").count(), 3);
  const solar = panel.locator('#distributionControls button[data-distribution-metric="production"]');
  assert.equal(await solar.getAttribute("aria-checked"), "true");
  await solar.press("ArrowRight");
  const household = panel.locator('#distributionControls button[data-distribution-metric="householdUse"]');
  assert.equal(await household.getAttribute("aria-checked"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-distribution-metric")), "householdUse");
  const selected = panel.locator('#distributionRows button[aria-checked="true"]');
  await selected.press("ArrowDown");
  const focusedMonth = await page.evaluate(() => document.activeElement?.getAttribute("data-distribution-month"));
  assert.equal(await panel.locator(`#distributionRows button[data-distribution-month="${focusedMonth}"]`).getAttribute("aria-checked"), "true");
  assert.match(await panel.locator("#distributionReadout").innerText(), /middle 50%/);
}

async function verifyWeatherScatter(page) {
  const panel = page.locator("#weatherSection");
  assert.equal(await panel.locator("#weatherControls button[role=radio]").count(), 2);
  assert.equal(await panel.locator("#weatherScatter button[role=radio]").count(), 4);
  const precipitation = panel.locator('#weatherControls button[data-weather-metric="precipitation"]');
  assert.equal(await precipitation.getAttribute("aria-checked"), "true");
  await precipitation.press("ArrowRight");
  const temperature = panel.locator('#weatherControls button[data-weather-metric="temperature"]');
  assert.equal(await temperature.getAttribute("aria-checked"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-weather-metric")), "temperature");
  const selected = panel.locator('#weatherScatter button[aria-checked="true"]');
  await selected.press("ArrowRight");
  const selectedDate = await panel.locator('#weatherScatter button[aria-checked="true"]').getAttribute("data-weather-point");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-weather-point")), selectedDate);
  assert.match(await panel.locator("#weatherReadout").innerText(), /solar per daylight hour/);
  await panel.locator('#weatherScatter button[aria-checked="true"]').click();
  await page.locator("#dayDetailSection:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "dayDetailTitle");
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
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 1_000);
    safetyTimer.unref();
    serverInstance.close(finish);
    serverInstance.closeIdleConnections?.();
    serverInstance.closeAllConnections?.();
  });
}

function fixtureRecord(day, profile, overrides = {}) {
  const iso = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
  const common = {
    D: day,
    P: 4,
    U: 2,
    I: 1000,
    J: true,
    S: true,
    M: true,
    MS: { prcp: day % 3, tavg: 10 + (day % 7) },
    SRS: { R: `${iso}T06:00:00Z`, S: `${iso}T16:00:00Z` }
  };
  return { ...common, ...(profile ? { Q: { C: profile.import, I: profile.export } } : {}), ...overrides };
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

function springForwardIntervalProfile() {
  return { import: Array(92).fill(1), export: Array(92).fill(0) };
}

function hourRange(hour) {
  return `${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00`;
}