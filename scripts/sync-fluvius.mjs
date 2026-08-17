import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const LOGIN_HOST = "login.fluvius.be";
const DEFAULT_OUTPUT = "data/grid-supplement.json";
const DEFAULT_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const NAVIGATION_ATTEMPTS = 2;
const REDACTED = "[REDACTED]";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputPath = path.resolve(repositoryRoot, process.env.FLUVIUS_OUTPUT ?? DEFAULT_OUTPUT);
const email = requiredEnvironmentVariable("FLUVIUS_EMAIL");
const password = requiredEnvironmentVariable("FLUVIUS_PASSWORD");
const detailUrl = validateDetailUrl(requiredEnvironmentVariable("FLUVIUS_DETAIL_URL"));
const meterId = meterIdFromDetailUrl(detailUrl);
const existingSupplement = await readSupplement(outputPath);
const fromDate = process.env.FLUVIUS_FROM_DATE?.trim() || firstCoveredDate(existingSupplement);
const throughDate = process.env.FLUVIUS_THROUGH_DATE?.trim() || yesterdayInBrussels();

validateIsoDate(fromDate, "FLUVIUS_FROM_DATE");
validateIsoDate(throughDate, "FLUVIUS_THROUGH_DATE");
if (fromDate > throughDate) {
  throw new Error("FLUVIUS_FROM_DATE must not be after FLUVIUS_THROUGH_DATE.");
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fluvius-sync-"));
const csvPath = path.join(temporaryDirectory, "fluvius.csv");
const candidatePath = path.join(temporaryDirectory, "grid-supplement.json");
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    downloadsPath: temporaryDirectory
  });
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

  const candidateSupplement = await readSupplement(candidatePath);
  validateCandidate(existingSupplement, candidateSupplement, fromDate, throughDate);
  await replaceFile(candidatePath, outputPath);

  const dates = Object.keys(candidateSupplement.days).sort();
  console.log(`Fluvius supplement refreshed: ${dates.length} complete days through ${dates.at(-1)}.`);
} catch (error) {
  console.error(redactError(error));
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {
    console.error("Failed to close the temporary browser session.");
    process.exitCode = 1;
  }
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch {
    console.error("Failed to remove temporary Fluvius download data.");
    process.exitCode = 1;
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
  const authenticated = page.waitForURL((url) => url.hostname === "mijn.fluvius.be", {
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
  await navigateToFluvius(page, detailUrl);
  if (await waitForFluviusPageState(page) === "login") {
    throw new Error("AUTH_REQUIRED: the Fluvius session was not accepted.");
  }

  await dismissCookieBanner(page);
  const historyTab = page.getByRole("tab", { name: /Gemeten historiek|Verbruikshistoriek/i });
  if (await historyTab.isVisible().catch(() => false)) await historyTab.click();

  await page.getByRole("button", { name: "Historiek downloaden", exact: true }).waitFor();
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

async function waitForFluviusPageState(page) {
  const personalAccount = page.getByRole("button", { name: "Persoonlijk account", exact: true });
  const emailInput = page.locator("#signInName");
  const historyTab = page.getByRole("tab", { name: /Gemeten historiek|Verbruikshistoriek/i });
  const downloadButton = page.getByRole("button", { name: "Historiek downloaden", exact: true });

  await personalAccount
    .or(emailInput)
    .or(historyTab)
    .or(downloadButton)
    .first()
    .waitFor({ state: "visible", timeout: DOWNLOAD_TIMEOUT_MS });

  return new URL(page.url()).hostname === LOGIN_HOST
    || await personalAccount.isVisible().catch(() => false)
    || await emailInput.isVisible().catch(() => false)
    ? "login"
    : "app";
}

async function downloadQuarterHourCsv(page, destination, startDate, endDate, expectedMeterId) {
  await page.getByRole("button", { name: "Historiek downloaden", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor();

  await chooseOption(dialog, /Aangepaste periode/i, false);
  await fillDateRange(dialog, startDate, endDate);
  await chooseOption(dialog, /Kwartiertotalen|Kwartiergegevens/i, true);

  const downloadButton = dialog.getByRole("button", {
    name: /Historiek downloaden als CSV|Downloaden als CSV/i
  });
  await downloadButton.waitFor();

  const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS });
  await downloadButton.click();
  const download = await downloadPromise;
  const failure = await download.failure();
  if (failure) throw new Error(`Fluvius CSV download failed: ${failure}`);
  validateDownloadIdentity(download.suggestedFilename(), expectedMeterId);
  await download.saveAs(destination);
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
    await dateInputs.nth(0).fill(startDate);
    await dateInputs.nth(1).fill(endDate);
    return;
  }

  const fromInput = dialog.getByLabel(/Van|Begindatum|Startdatum/i).first();
  const throughInput = dialog.getByLabel(/Tot|Einddatum/i).first();
  if (!await fromInput.isVisible().catch(() => false) || !await throughInput.isVisible().catch(() => false)) {
    throw new Error("Fluvius export dialog date fields could not be identified.");
  }

  await fillDateInput(fromInput, startDate);
  await fillDateInput(throughInput, endDate);
}

async function fillDateInput(input, isoDate) {
  const type = await input.getAttribute("type");
  await input.fill(type === "date" ? isoDate : formatBelgianDate(isoDate));
  await input.press("Tab");
}

async function dismissCookieBanner(page) {
  const acceptButton = page.getByRole("button", {
    name: /Alle cookies aanvaarden|Alles aanvaarden|Accepteren/i
  }).first();
  if (await acceptButton.isVisible().catch(() => false)) await acceptButton.click();
}

async function runSanitizer(input, output) {
  const sanitizerPath = path.join(scriptDirectory, "build-grid-supplement.mjs");
  await new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(process.execPath, [sanitizerPath, input, output], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else {
        const reason = redactText(stderr.trim()).slice(0, 1_000);
        reject(new Error(`Grid supplement sanitizer rejected the export.${reason ? ` ${reason}` : ""}`));
      }
    });
  });
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
    throw new Error("The downloaded CSV does not match the requested date range.");
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

async function replaceFile(source, destination) {
  const nextPath = `${destination}.next`;
  const backupPath = `${destination}.backup`;
  await writeFile(nextPath, await readFile(source));
  try {
    await rename(nextPath, destination);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error.code)) throw error;
    await rm(backupPath, { force: true });
    await rename(destination, backupPath);
    try {
      await rename(nextPath, destination);
    } catch (replacementError) {
      try {
        await rename(backupPath, destination);
      } catch (restoreError) {
        throw new AggregateError(
          [replacementError, restoreError],
          "Failed to replace or restore the grid supplement."
        );
      }
      throw replacementError;
    }
    await rm(backupPath, { force: true });
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

function validateIsoDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must use YYYY-MM-DD.`);
  }
}

function validateDetailUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "mijn.fluvius.be") {
    throw new Error("FLUVIUS_DETAIL_URL must be an HTTPS mijn.fluvius.be URL.");
  }
  return url.toString();
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function redactError(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  return redactText(message);
}

function redactText(value) {
  let message = value;
  for (const secret of [email, password, detailUrl, meterId]) {
    if (secret) message = message.replaceAll(secret, REDACTED);
  }
  return message.replace(/\b\d{18}\b/g, REDACTED);
}