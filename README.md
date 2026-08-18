# Home Energy Atlas

A static, source-aware energy dashboard for the data published by `sujithq/myenergy`.

## Features

- Day, month, and year selection.
- Solar production, grid import/export, household consumption, and self-use metrics.
- Clickable monthly calendar with a daily drill-down.
- Observed 15-minute solar and grid profiles.
- A two-hour solar-use window based on measured solar and export patterns.
- Energy-flow, weather, storage-opportunity, anomaly, and source-coverage insights.
- Correct handling of 92-, 96-, and 100-interval daylight-saving days.
- Source-specific freshness and partial-period warnings.
- Sanitized Fluvius quarter-hour data to restore missing grid history.

The dashboard is browser-only. It fetches the main JSON source and loads a sanitized local grid supplement at runtime. It does not require a build step or backend.

## Run Locally

From this directory:

```powershell
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to GitHub Pages

1. Push these files to a GitHub repository.
2. Open **Settings > Pages**.
3. Under **Build and deployment**, select **GitHub Actions** as the source.
4. Push to `main` or `master`, or run **Deploy GitHub Pages** from the Actions tab.

The included workflow stages only the public application files and sanitized grid supplement. It never uploads the raw meter export. The `.nojekyll` marker prevents Jekyll processing; `index.html`, `styles.css`, and `app.js` must remain together at the publishing root.

## Automated Fluvius Refresh

The `Refresh Fluvius grid data` workflow runs every day at 05:15 UTC (06:15 CET or 07:15 CEST). It signs in to a personal Mijn Fluvius account, downloads quarter-hour data through yesterday, sanitizes the CSV, and commits only `data/grid-supplement.json` when that file changes. The successful run then starts the Pages deployment workflow.

Configure these encrypted repository secrets under **Settings > Secrets and variables > Actions > Secrets**:

- `FLUVIUS_EMAIL`: email address for an existing personal Fluvius account.
- `FLUVIUS_PASSWORD`: password for that account.
- `FLUVIUS_DETAIL_URL`: the full meter page URL ending in `/detail?tab=gemeten-historiek`.

The meter URL contains the EAN and must remain a secret. Each export starts at the first date already present in the supplement so a truncated download cannot silently remove published history.

Under **Settings > Actions > General > Workflow permissions**, allow read and write access for workflows. Branch protection must also permit `github-actions[bot]` to push the generated data commit. Run **Refresh Fluvius grid data** once from the Actions tab to verify the current Fluvius login and export interface.

The raw CSV exists only in the runner's temporary directory. It is never added to Git, uploaded as an artifact, or included in the Pages site. The workflow verifies the meter identifier from the download filename, rejects incomplete date ranges or lost historical days, and preserves the last valid supplement on any failure. CAPTCHA, MFA, a changed login flow, or rejected credentials produce an `AUTH_REQUIRED` failure; they are not bypassed.

Repository secrets are appropriate for this unattended workflow, but anyone allowed to modify workflows on the default branch could write code that reads them. Restrict write access to the repository and use a dedicated Fluvius password that is not reused elsewhere.

## Local Fluvius Refresh

Local automation requires Node.js `^20.17.0 || >=22.9.0`. Install the locked dependencies before starting the watcher or authenticated sync:

```powershell
npm ci
```

For local authenticated downloads, install Playwright's Chromium browser once:

```powershell
npx playwright install chromium
```

Place a Fluvius quarter-hour CSV in `data/`. The included VS Code task starts a background watcher when the folder opens, selects the most recently modified CSV, and regenerates `data/grid-supplement.json` only when the CSV content changes. It refuses any local export that would remove or alter already-published days, protecting newer authenticated data and guarding against a CSV from another meter. VS Code may ask you to allow automatic tasks for this folder the first time.

For an authenticated local download, use the PowerShell wrapper. It prompts with the Windows credential dialog, passes the credentials only to the child process, and clears the environment variables when it exits. The password and meter URL are not saved in the repository, shell history, or a local configuration file:

```powershell
.\scripts\sync-fluvius.ps1
```

For Scout automation, save the credentials once in a Windows-user-encrypted DPAPI file outside the repository:

```powershell
.\scripts\setup-fluvius-secrets.ps1
.\scripts\sync-fluvius.ps1
```

The secret file can only be decrypted by the same Windows user on the same machine. The automated command can then run without prompting:

```powershell
powershell.exe -NoProfile -File ".\scripts\sync-fluvius.ps1"
```

Do not paste Fluvius credentials into chat or commit the secret file. For unattended GitHub Actions runs, use the encrypted repository secrets described above.

Start the watcher manually when working outside VS Code:

```powershell
node scripts/watch-grid-supplement.mjs
```

`Ctrl+C` waits for any active local refresh to close its browser and remove its temporary CSV before exiting. An operating-system force termination cannot run that cleanup, so do not use it while a refresh is active.

For a one-time refresh with an explicit file, run:

```powershell
node scripts/publish-grid-supplement.mjs "data/your-fluvius-export.csv"
```

Raw Fluvius exports can contain an EAN, meter serial number, and address description. Keep them private. They are ignored by Git and excluded from the Pages artifact. The watcher uses a SHA-256 content hash to ignore timestamp-only file updates. The generator publishes only complete dated import/export arrays, rejects unexpected units or interval counts, and omits unread days rather than treating them as zero. After a successful authenticated local refresh, the wrapper stages, commits, and pushes only `data/grid-supplement.json` when it changed. It requires a configured Git identity and a writable `origin` remote, and refuses to commit pre-existing changes to that file.

## Data Mapping

```text
Production  = P
GridImport  = U
GridExport  = I / 1000
Consumption = P + U - (I / 1000)
```

When complete 15-minute arrays exist, their import and export totals replace discrepant daily summaries. See [docs/data-profile.md](docs/data-profile.md) for the full data contract and quality findings.

The Fluvius supplement stores import and export directly in kWh per 15-minute interval. Existing complete remote intervals remain authoritative; the supplement fills only missing grid days.

## External Runtime Dependencies

- Chart.js, loaded from jsDelivr.
- Lucide icons, loaded from unpkg.
- IBM Plex Sans and Space Grotesk, loaded from Google Fonts.

The energy JSON URL is configured near the top of `app.js`.