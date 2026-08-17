const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');

(async () => {
  const stdout = execSync('git status --ignored --porcelain', { encoding: 'utf8' });
  const csvFiles = stdout.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('!!') && line.endsWith('.csv'))
    .map(line => line.slice(2).trim());

  let newestFile = null;
  let newestTime = 0;
  for (const file of csvFiles) {
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (stat.mtimeMs > newestTime) {
        newestTime = stat.mtimeMs;
        newestFile = file;
      }
    }
  }
  if (!newestFile) {
    throw new Error('No ignored CSV files found on disk');
  }
  const match = newestFile.match(/\d{18}/);
  if (!match) {
    throw new Error('No 18-digit meter ID found in the filename');
  }
  const meterId = match[0];

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const url = `https://mijn.fluvius.be/verbruik/${meterId}/detail?tab=gemeten-historiek`;
  
  const startTime = Date.now();
  await page.goto(url, {
    waitUntil: 'commit',
    timeout: 120000
  });
  const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

  const personalAccount = page.getByRole('button', { name: 'Persoonlijk account', exact: true });
  const emailInput = page.locator('#signInName');
  const historyTab = page.getByRole('tab', { name: /Gemeten historiek|Verbruikshistoriek/i });
  const downloadButton = page.getByRole('button', { name: 'Historiek downloaden', exact: true });

  const firstVisible = personalAccount
    .or(emailInput)
    .or(historyTab)
    .or(downloadButton)
    .first();

  await firstVisible.waitFor({ state: 'visible', timeout: 120000 });

  const isLogin = await personalAccount.isVisible().catch(() => false) || await emailInput.isVisible().catch(() => false);
  const resultingState = isLogin ? 'login' : 'app';
  const resultingHostname = new URL(page.url()).hostname;

  console.log(`NAVIGATION_ELAPSED_SEC: ${elapsedSeconds}`);
  console.log(`RESULTING_STATE: ${resultingState}`);
  console.log(`RESULTING_HOSTNAME: ${resultingHostname}`);

  await browser.close();
})().catch(err => {
  console.error("Error occurred:", err.message);
  process.exit(1);
});
