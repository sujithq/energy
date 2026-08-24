import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { authenticateFluvius, fetchFluviusMeasurements } from "./fluvius-api-client.mjs";
import { buildGridSupplementFromApi } from "./fluvius-api-supplement.mjs";
import { publicSyncErrorMessage } from "./fluvius-error-reporting.mjs";
import { validateDetailUrl, validateIsoDate } from "./fluvius-input-validation.mjs";
import { replaceFileAtomically, withSupplementLock } from "./grid-supplement-publication.mjs";
import {
  createFluviusRuntimeCleanup,
  installFluviusInterruptHandlers,
  stopChildProcess
} from "./fluvius-runtime-cleanup.mjs";

const LOGIN_HOST = "login.fluvius.be";
const DEFAULT_OUTPUT = "data/grid-supplement.json";
const DEFAULT_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const NAVIGATION_ATTEMPTS = 2;
const REDACTED = "[REDACTED]";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
let email;
let password;
let detailUrl;
let meterId;
let meterSerial;
let sanitizerProcess;
const runtimeCleanup = createFluviusRuntimeCleanup({
  beforeTemporaryDataRemoval: stopActiveSanitizer,
  onTemporaryProcessStopFailure: () => {
    console.error("Failed to stop the temporary Fluvius export process.");
    process.exitCode = 1;
  },
  onBrowserCloseFailure: () => {
    console.error("Failed to close the temporary browser session.");
    process.exitCode = 1;
  },
  onTemporaryDataRemovalFailure: () => {
    console.error("Failed to remove temporary Fluvius download data.");
    process.exitCode = 1;
  }
});
const interruptHandlers = installFluviusInterruptHandlers(runtimeCleanup);

try {
  interruptHandlers.throwIfInterrupted();
  const outputPath = path.resolve(repositoryRoot, process.env.FLUVIUS_OUTPUT ?? DEFAULT_OUTPUT);
  email = requiredEnvironmentVariable("FLUVIUS_EMAIL");
  password = requiredEnvironmentVariable("FLUVIUS_PASSWORD");
  detailUrl = validateDetailUrl(requiredEnvironmentVariable("FLUVIUS_DETAIL_URL"));
  meterId = meterIdFromDetailUrl(detailUrl);
  const transport = fluviusTransport();
  if (transport === "api") meterSerial = requiredEnvironmentVariable("FLUVIUS_METER_SERIAL");
  const existingSupplement = await readSupplement(outputPath);
  const fromDate = process.env.FLUVIUS_FROM_DATE?.trim() || firstCoveredDate(existingSupplement);
  const throughDate = process.env.FLUVIUS_THROUGH_DATE?.trim() || yesterdayInBrussels();

  validateIsoDate(fromDate, "FLUVIUS_FROM_DATE");
  validateIsoDate(throughDate, "FLUVIUS_THROUGH_DATE");
  if (fromDate > throughDate) {
    throw new Error("FLUVIUS_FROM_DATE must not be after FLUVIUS_THROUGH_DATE.");
  }

  interruptHandlers.throwIfInterrupted();
  const temporaryDirectory = await createTemporaryDirectory();
  runtimeCleanup.setTemporaryDirectory(temporaryDirectory);
  interruptHandlers.throwIfInterrupted();
  const candidatePath = path.join(temporaryDirectory, "grid-supplement.json");
  if (transport === "api") {
    const accessToken = await authenticateFluvius(
      { email, password },
      { signal: interruptHandlers.signal }
    );
    interruptHandlers.throwIfInterrupted();
    const measurements = await fetchFluviusMeasurements({
      accessToken,
      meterId,
      meterSerial,
      fromDate,
      throughDate
    }, { signal: interruptHandlers.signal });
    interruptHandlers.throwIfInterrupted();
    const candidate = buildGridSupplementFromApi(measurements);
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
  } else {
    const csvPath = path.join(temporaryDirectory, "fluvius.csv");
    const { chromium } = await import("playwright");
    const browserServer = await chromium.launchServer({
      headless: true,
      downloadsPath: temporaryDirectory
    });
    runtimeCleanup.setBrowser({
      close: () => browserServer.close(),
      forceClose: () => browserServer.kill()
    });
    interruptHandlers.throwIfInterrupted();
    const browser = await chromium.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: "nl-BE",
      timezoneId: "Europe/Brussels"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    await navigateToFluvius(page, detailUrl);
    await signInIfRequired(page);
    await openMeterHistory(page);
    await downloadQuarterHourCsv(page, csvPath, fromDate, throughDate, meterId);
    await runSanitizer(csvPath, candidatePath);
  }

  const candidateSupplement = await readSupplement(candidatePath);
  interruptHandlers.throwIfInterrupted();
  await withSupplementLock(outputPath, async () => {
    interruptHandlers.throwIfInterrupted();
    const currentSupplement = await readSupplement(outputPath);
    interruptHandlers.throwIfInterrupted();
    validateCandidate(currentSupplement, candidateSupplement, fromDate, throughDate);
    interruptHandlers.throwIfInterrupted();
    await replaceFileAtomically(candidatePath, outputPath, {
      throwIfAborted: () => interruptHandlers.throwIfInterrupted()
    });
  });

  interruptHandlers.throwIfInterrupted();
  const dates = Object.keys(candidateSupplement.days).sort();
  console.log(`Fluvius supplement refreshed: ${dates.length} complete days through ${dates.at(-1)}.`);
} catch (error) {
  if (!interruptHandlers.interrupted) {
    console.error(publicSyncErrorMessage(error));
    process.exitCode = 1;
  }
} finally {
  await runtimeCleanup.cleanup();
  interruptHandlers.dispose();
}

async function createTemporaryDirectory() {
  try {
    return await mkdtemp(path.join(os.tmpdir(), "fluvius-sync-"));
  } catch {
    throw new Error("Temporary Fluvius workspace could not be created.");
  }
}

async function signInIfRequired(page) {
  if (await waitForFluviusPageState(page) === "app") return;

  const personalAccount = page.getByRole("button", { name: "Persoonlijk account", exact: true });
  if (await personalAccount.isVisible().catch(() => false)) await personalAccount.click();

  await page.locator("#signInName").fill(email);
  await page.locator("#password").fill(password);
  const authenticationResult = await Promise.all([
    waitForAuthenticationResult(page),
    page.locator("#next").click()
  ]).then(([result]) => result);

  if (new URL(page.url()).hostname === LOGIN_HOST) {
    throw new Error(`AUTH_REQUIRED: ${await classifyAuthenticationFailure(page, authenticationResult)}`);
  }
}

async function waitForAuthenticationResult(page) {
  const authenticated = page.waitForURL((url) => url.hostname === "mijn.fluvius.be"
      && !url.pathname.startsWith("/redirect"), {
    timeout: DOWNLOAD_TIMEOUT_MS,
    waitUntil: "commit"
  }).then(() => "authenticated");
  const visibleError = page.locator('[role="alert"]:visible, .error:visible').first()
    .waitFor({ state: "visible", timeout: DOWNLOAD_TIMEOUT_MS })
    .then(() => "error");

  return Promise.race([authenticated, visibleError]).catch(() => "timeout");
}

async function classifyAuthenticationFailure(page, result) {
  const messages = await page.locator('[role="alert"]:visible, .error:visible')
    .allTextContents()
    .catch(() => []);
  const text = messages.join(" ").replace(/\s+/g, " ").trim().toLocaleLowerCase("nl-BE");

  if (/wachtwoord|password|gebruikersnaam|username|e-mail|email/.test(text)
      && /onjuist|incorrect|ongeldig|invalid|niet gevonden|not found/.test(text)) {
    return "INVALID_CREDENTIALS: Fluvius did not accept the supplied email or password.";
  }
  if (/geblokkeerd|vergrendeld|blocked|locked|te veel|too many/.test(text)) {
    return "ACCOUNT_LOCKED: Fluvius temporarily blocked this sign-in.";
  }
  if (/captcha|verificatie|verification|beveiligingscode|security code|multi-factor|tweestaps/.test(text)) {
    return "INTERACTIVE_VERIFICATION_REQUIRED: Fluvius requested a step that cannot run unattended.";
  }
  if (result === "error") {
    return "LOGIN_REJECTED: Fluvius displayed a sign-in error.";
  }
  return "LOGIN_TIMEOUT: Fluvius did not complete the sign-in or display a public error.";
}

async function openMeterHistory(page) {
  const currentUrl = new URL(page.url());
  const targetUrl = new URL(detailUrl);
  if (currentUrl.origin !== targetUrl.origin || currentUrl.pathname !== targetUrl.pathname) {
    await navigateToFluvius(page, detailUrl);
  }

  let pageState;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      pageState = await waitForFluviusPageState(page, 60_000);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await navigateToFluvius(page, detailUrl);
    }
  }
  if (pageState === "login") {
    throw new Error("AUTH_REQUIRED: LOGIN_REJECTED: Fluvius did not accept the authenticated session.");
  }

  await dismissCookieBanner(page);
  const historyTab = page.getByRole("tab", {
    name: /^(?:Gemeten historiek|Verbruikshistoriek|Verbruik)$/i
  });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await page.evaluate(isHistoryPanelReady)) return;
    await historyTab.click();
    try {
      await page.waitForFunction(isHistoryPanelReady, null, { timeout: 10_000 });
      return;
    } catch {
      // Fluvius can replace the first tab instance while its detail page finishes rendering.
    }
  }

  const state = await readHistoryState(page, historyTab);
  throw new Error(`Fluvius history action was not available: ${JSON.stringify(state)}`);
}

function isHistoryPanelReady() {
  const tab = document.querySelector('[role="tab"][aria-controls="gemeten-historiek"]');
  const activePanelText = document.querySelector("fluv-tab.fluv-active")?.innerText ?? "";
  return tab?.getAttribute("aria-selected") === "true"
    && /Historiek downloaden/i.test(activePanelText);
}

async function readHistoryState(page, historyTab) {
  const activePanel = page.locator("fluv-tab.fluv-active");
  const activePanelText = await activePanel.first().innerText().catch(() => "");
  return {
    historyTabSelected: await historyTab.getAttribute("aria-selected").catch(() => null),
    activePanelCount: await activePanel.count(),
    activePanelHasHistory: /historiek/i.test(activePanelText),
    activePanelHasDownload: /download/i.test(activePanelText),
    pageHistoryLabelCount: await page.getByText(/Historiek downloaden/i).count()
  };
}

async function navigateToFluvius(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(url, {
        timeout: DOWNLOAD_TIMEOUT_MS,
        waitUntil: "commit"
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Fluvius navigation failed after ${NAVIGATION_ATTEMPTS} attempts: ${redactText(reason)}`);
}

async function waitForFluviusPageState(page, timeout = DOWNLOAD_TIMEOUT_MS) {
  const personalAccount = page.getByRole("button", { name: "Persoonlijk account", exact: true });
  const emailInput = page.locator("#signInName");
  const historyTab = page.getByRole("tab", {
    name: /^(?:Gemeten historiek|Verbruikshistoriek|Verbruik)$/i
  });
  const downloadButton = historyDownloadAction(page);

  await personalAccount
    .or(emailInput)
    .or(historyTab)
    .or(downloadButton)
    .first()
    .waitFor({ state: "visible", timeout });

  return new URL(page.url()).hostname === LOGIN_HOST
    || await personalAccount.isVisible().catch(() => false)
    || await emailInput.isVisible().catch(() => false)
    ? "login"
    : "app";
}

async function downloadQuarterHourCsv(page, destination, startDate, endDate, expectedMeterId) {
  await historyDownloadAction(page).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor();

  await chooseOption(dialog, /Aangepaste periode/i, false);
  const granularity = /Kwartiertotalen|Kwartiergegevens/i;
  if (!await chooseOption(dialog, granularity, false)
      && !await chooseComboboxOption(page, dialog, "granularity", granularity)) {
    throw new Error(`Fluvius export dialog no longer offers ${granularity}.`);
  }
  await waitForGranularityRerender(dialog, granularity);
  const { fromInput, throughInput } = await fillAndConfirmDateRange(dialog, startDate, endDate);

  const downloadButton = dialog.getByRole("button", {
    name: /Historiek downloaden als CSV|Downloaden als CSV|Downloaden$/i
  });
  await downloadButton.waitFor();
  await assertDateInputValue(fromInput, startDate, "start");
  await assertDateInputValue(throughInput, endDate, "end");

  const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS });

async function waitForGranularityRerender(dialog, granularity) {
  const combobox = dialog.locator('[role="combobox"][name="granularity"]').first();
  if (await combobox.isVisible().catch(() => false)) {
    await combobox.filter({ hasText: granularity }).waitFor({ state: "visible" });
  }
  await waitForAnimationFrames(dialog);
}

async function fillAndConfirmDateRange(dialog, startDate, endDate) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const dateRange = await fillDateRange(dialog, startDate, endDate);
    await waitForAnimationFrames(dialog);
    try {
      await assertDateInputValue(dateRange.fromInput, startDate, "start");
      await assertDateInputValue(dateRange.throughInput, endDate, "end");
      return dateRange;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function waitForAnimationFrames(locator) {
  await locator.evaluate(() => new Promise((resolve) => requestAnimationFrame(
    () => requestAnimationFrame(resolve)
  )));
}
  await downloadButton.click();
  const download = await downloadPromise;
  const failure = await download.failure();
  if (failure) throw new Error(`Fluvius CSV download failed: ${failure}`);
  validateDownloadIdentity(download.suggestedFilename(), expectedMeterId);
  await download.saveAs(destination);
}

async function chooseComboboxOption(page, container, controlName, name) {
  const combobox = container.locator(`[role="combobox"][name="${controlName}"]`).first();
  if (!await combobox.isVisible().catch(() => false)) return false;

  await combobox.click();
  const option = page.getByRole("option", { name }).first();
  try {
    await option.waitFor({ state: "visible", timeout: 10_000 });
    await option.click();
    return true;
  } catch {
    await page.keyboard.press("Escape");
    return false;
  }
}

function historyDownloadAction(page) {
  return page.locator("fluv-tab.fluv-active")
    .locator("button.fluv-button.fluv-link-button")
    .filter({
      has: page.locator("span").filter({ hasText: /^Historiek downloaden$/i })
    })
    .first();
}

async function chooseOption(container, name, required) {
  const labelledControl = container.getByLabel(name).first();
  if (await labelledControl.isVisible().catch(() => false)) {
    const tagName = await labelledControl.evaluate((element) => element.tagName.toLowerCase());
    const type = await labelledControl.getAttribute("type");
    if (tagName === "input" && ["checkbox", "radio"].includes(type)) {
      await labelledControl.check();
    } else {
      await labelledControl.click();
    }
    return true;
  }

  for (const role of ["radio", "option", "button"]) {
    const control = container.getByRole(role, { name }).first();
    if (await control.isVisible().catch(() => false)) {
      await control.click();
      return true;
    }
  }

  const selects = container.locator("select");
  for (let index = 0; index < await selects.count(); index += 1) {
    const select = selects.nth(index);
    const matchingOption = select.locator("option").filter({ hasText: name }).first();
    if (await matchingOption.count()) {
      const optionValue = await matchingOption.evaluate((option) => option.value);
      await select.selectOption(optionValue);
      return true;
    }
  }

  if (required) throw new Error(`Fluvius export dialog no longer offers ${name}.`);
  return false;
}

async function fillDateRange(dialog, startDate, endDate) {
  const dateInputs = dialog.locator('input[type="date"]:visible');
  if (await dateInputs.count() >= 2) {
    const fromInput = dateInputs.nth(0);
    const throughInput = dateInputs.nth(1);
    await fillDateInput(fromInput, startDate);
    await fillDateInput(throughInput, endDate);
    return { fromInput, throughInput };
  }

  const namedFromInput = dialog.locator('input[name="from"]:visible');
  const namedThroughInput = dialog.locator('input[name="until"]:visible');
  if (await namedFromInput.count() && await namedThroughInput.count()) {
    const fromInput = namedFromInput.first();
    const throughInput = namedThroughInput.first();
    await fillDateInput(fromInput, startDate);
    await fillDateInput(throughInput, endDate);
    return { fromInput, throughInput };
  }

  const fromInput = dialog.getByLabel(/Van|Begindatum|Startdatum/i).first();
  const throughInput = dialog.getByLabel(/Tot(?: en met)?|Einddatum/i).first();
  if (!await fromInput.isVisible().catch(() => false) || !await throughInput.isVisible().catch(() => false)) {
    throw new Error("Fluvius export dialog date fields could not be identified.");
  }

  await fillDateInput(fromInput, startDate);
  await fillDateInput(throughInput, endDate);
  return { fromInput, throughInput };
}

async function fillDateInput(input, isoDate) {
  const type = await input.getAttribute("type");
  await input.fill(type === "date" ? isoDate : formatBelgianDate(isoDate));
  await input.press("Tab");
}

async function assertDateInputValue(input, isoDate, boundary) {
  const type = await input.getAttribute("type");
  const expected = type === "date" ? isoDate : formatBelgianDate(isoDate);
  const actual = await input.inputValue();
  if (actual !== expected) {
    throw new Error(`Fluvius reset the requested ${boundary} date to ${actual || "an empty value"}.`);
  }
}

async function dismissCookieBanner(page) {
  const cookieDialog = page.locator("#fluv-cookies-popup-container");
  await cookieDialog.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (!await cookieDialog.isVisible().catch(() => false)) return;

  const rejectButton = cookieDialog.getByRole("button", {
    name: "Weiger alle cookies",
    exact: true
  });
  const acceptButton = cookieDialog.getByRole("button", {
    name: /Aanvaard alle cookies|Alle cookies aanvaarden|Alles aanvaarden|Accepteren/i
  }).first();
  const dismissButton = await rejectButton.isVisible().catch(() => false)
    ? rejectButton
    : acceptButton;
  if (await dismissButton.isVisible().catch(() => false)) await dismissButton.click();
  await cookieDialog.waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT_MS });
}

async function runSanitizer(input, output) {
  const sanitizerPath = path.join(scriptDirectory, "build-grid-supplement.mjs");
  await new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(process.execPath, [sanitizerPath, input, output], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"]
    });
    sanitizerProcess = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (sanitizerProcess === child) sanitizerProcess = undefined;
      reject(error);
    });
    child.once("exit", (code) => {
      if (sanitizerProcess === child) sanitizerProcess = undefined;
      if (code === 0) resolve();
      else {
        const reason = redactText(stderr.trim()).slice(0, 1_000);
        reject(new Error(`Grid supplement sanitizer rejected the export.${reason ? ` ${reason}` : ""}`));
      }
    });
  });
}

async function stopActiveSanitizer() {
  const child = sanitizerProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await stopChildProcess(child);
}

async function readSupplement(filePath) {
  const raw = await readFile(filePath, "utf8");
  const supplement = JSON.parse(raw);
  if (supplement?.schemaVersion !== 1 || !supplement.days || typeof supplement.days !== "object") {
    throw new Error("The grid supplement does not match schema version 1.");
  }
  return supplement;
}

function validateCandidate(existing, candidate, startDate, endDate) {
  const existingDates = Object.keys(existing.days);
  const candidateDates = Object.keys(candidate.days).sort();
  if (!candidateDates.length) throw new Error("The downloaded CSV produced no complete grid days.");
  const excludedDates = Array.isArray(candidate.excluded)
    ? candidate.excluded.map((item) => item?.date).filter(Boolean)
    : [];
  const observedDates = new Set([...candidateDates, ...excludedDates]);
  const requestedDates = datesBetween(startDate, endDate);
  const missingRequestedDates = requestedDates.filter((date) => !observedDates.has(date));
  const outOfRangeDates = [...observedDates].filter((date) => date < startDate || date > endDate);
  if (missingRequestedDates.length || outOfRangeDates.length) {
    const observedDateList = [...observedDates].sort();
    const observedRange = observedDateList.length
      ? `${observedDateList[0]} through ${observedDateList.at(-1)}`
      : "no dated rows";
    throw new Error(
      `The downloaded CSV does not match the requested range ${startDate} through ${endDate}: `
      + `observed ${observedRange}; ${missingRequestedDates.length} missing and `
      + `${outOfRangeDates.length} out-of-range day(s).`
    );
  }

  const missingDates = existingDates.filter((date) => !candidate.days[date]);
  if (missingDates.length) {
    throw new Error(`The new export would remove ${missingDates.length} previously published day(s).`);
  }

  const serialized = JSON.stringify(candidate);
  if (/\b\d{18}\b/.test(serialized)) {
    throw new Error("Privacy validation failed: candidate output contains an 18-digit identifier.");
  }
}

function validateDownloadIdentity(fileName, expectedMeterId) {
  const identifiers = fileName.match(/\d{18}/g) ?? [];
  if (identifiers.length !== 1 || identifiers[0] !== expectedMeterId) {
    throw new Error("The downloaded CSV filename does not match the configured Fluvius meter.");
  }
}

function meterIdFromDetailUrl(value) {
  const match = /\/verbruik\/(\d{18})\/detail(?:\/|$)/.exec(new URL(value).pathname);
  if (!match) {
    throw new Error("FLUVIUS_DETAIL_URL must point to an 18-digit meter detail page.");
  }
  return match[1];
}

function datesBetween(fromDate, throughDate) {
  const dates = [];
  const current = new Date(`${fromDate}T12:00:00Z`);
  const through = new Date(`${throughDate}T12:00:00Z`);
  while (current <= through) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function firstCoveredDate(supplement) {
  const dates = Object.keys(supplement.days).sort();
  if (!dates.length) throw new Error("FLUVIUS_FROM_DATE is required when the supplement is empty.");
  return dates[0];
}

function yesterdayInBrussels() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const today = formatter.format(new Date());
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

function formatBelgianDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function fluviusTransport() {
  const transport = process.env.FLUVIUS_TRANSPORT?.trim().toLowerCase() || "browser";
  if (!["api", "browser"].includes(transport)) {
    throw new Error("FLUVIUS_TRANSPORT must be api or browser.");
  }
  return transport;
}

function redactText(value) {
  let message = value;
  for (const secret of [email, password, detailUrl, meterId, meterSerial]) {
    if (secret) message = message.replaceAll(secret, REDACTED);
  }
  return message.replace(/\b\d{18}\b/g, REDACTED);
}