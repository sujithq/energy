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

## Refresh Fluvius Data

Generate the publishable supplement from a Fluvius quarter-hour CSV:

```powershell
node scripts/build-grid-supplement.mjs "data/your-fluvius-export.csv" "data/grid-supplement.json"
```

Raw Fluvius exports can contain an EAN, meter serial number, and address description. Keep them private. They are ignored by Git and excluded from the Pages artifact. The generator publishes only complete dated import/export arrays, rejects unexpected units or interval counts, and omits unread days rather than treating them as zero.

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