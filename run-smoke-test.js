const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const startTime = Date.now();
  
  function getNewestCsv(dir) {
    let newestFile = null;
    let newestMtime = 0;
    
    function traverse(currentDir) {
      const files = fs.readdirSync(currentDir);
      for (const file of files) {
        const fullPath = path.join(currentDir, file);
        if (file === 'node_modules' || file === '.git') continue;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          traverse(fullPath);
        } else if (file.endsWith('.csv')) {
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newestFile = file;
          }
        }
      }
    }
    
    traverse(dir);
    return newestFile;
  }
  
  const newestCsv = getNewestCsv('.');
  if (!newestCsv) {
    console.error("No CSV found");
    process.exit(1);
  }
  
  const match = newestCsv.match(/\d{18}/);
  if (!match) {
    console.error("No 18-digit identifier found in CSV");
    process.exit(1);
  }
  const meterId = match[0];
  const url = `https://mijn.fluvius.be/verbruik/${meterId}/detail`;
  
  const browser = await chromium.launch({
    executablePath: 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
    headless: true
  });
  
  try {
    const page = await browser.newPage();
    
    await page.goto(url, {
      waitUntil: 'commit',
      timeout: 120000
    });
    
    const personalAccountLocator = page.getByRole('button', { name: 'Persoonlijk account', exact: true });
    const signInNameLocator = page.locator('#signInName');
    
    await Promise.race([
      personalAccountLocator.waitFor({ state: 'visible', timeout: 120000 }),
      signInNameLocator.waitFor({ state: 'visible', timeout: 120000 })
    ]).catch(() => {});
    
    if (await personalAccountLocator.isVisible()) {
      await personalAccountLocator.click();
    }
    
    await signInNameLocator.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    const passwordLocator = page.locator('#password');
    await passwordLocator.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    const nextLocator = page.locator('#next');
    await nextLocator.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    
    const signInVisible = await signInNameLocator.isVisible();
    const passwordVisible = await passwordLocator.isVisible();
    const nextVisible = await nextLocator.isVisible();
    
    const allThreeVisible = signInVisible && passwordVisible && nextVisible;
    const finalUrl = page.url();
    const hostname = new URL(finalUrl).hostname;
    
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(JSON.stringify({
      hostname,
      allThreeVisible,
      elapsedSeconds,
      exitCode: 0
    }));
  } catch (error) {
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(JSON.stringify({
      error: error.message,
      elapsedSeconds,
      exitCode: 1
    }));
  } finally {
    await browser.close();
  }
})();
