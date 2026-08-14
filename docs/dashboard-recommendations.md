# Dashboard Recommendations

## Primary Screen

The first screen should answer four questions immediately:

1. How much energy did the home use?
2. How much solar was produced and used locally?
3. How much energy crossed the grid boundary?
4. Is the selected period better or worse than its comparison period?

Use a period selector for day, week, month, year, and custom range. Every value must carry the latest common data date or a source-specific freshness indicator.

## KPI Strip

Display these observed and derived values:

| KPI | Formula | Label |
|---|---|---|
| Solar production | `sum(P)` | Observed |
| Grid import | `sum(U)` or complete `sum(Q.C)` | Observed |
| Grid export | `sum(I) / 1000` or complete `sum(Q.I)` | Observed |
| Household consumption | `production + import - export` | Derived |
| Self-used solar | `production - export` | Derived |
| Self-consumption | `self-used solar / production` | Derived |
| Self-sufficiency | `self-used solar / household consumption` | Derived |
| Net grid balance | `import - export` | Derived |

Show absolute and percentage changes against the preceding equivalent period. Never compare incomplete periods without aligning their end dates.

## Energy Flow

Use an aggregate flow diagram with these links:

- Solar to household: self-used solar.
- Solar to grid: export.
- Grid to household: import.

The household node total is self-used solar plus grid import. The solar node total is self-used solar plus export.

Do not derive export as `max(P - U, 0)`. The file contains measured export in `I`.

## Time-Series Views

### Monthly balance

Use two aligned stacked columns:

- Household demand: self-used solar plus grid import.
- Solar disposition: self-used solar plus grid export.

Add a diverging net-grid line or bar where positive means import and negative means export. This makes the 2024-to-2025 shift from net importer to net exporter visible without hiding continued grid dependency.

### Daily calendar

Provide a calendar heatmap selectable among:

- Solar production.
- Household consumption.
- Grid export.
- Self-sufficiency.
- Net grid balance.

Overlay compact markers for anomaly flags, EV charging days, and incomplete source data.

### Typical day

Show observed 15-minute solar power, grid import, and grid export. Allow filtering by month, season, weekday/weekend, and year. Use a median profile by default and offer a trimmed mean as an alternative.

Do not display derived 15-minute household consumption until timestamp alignment has been corrected and validated. Daily and longer-period household consumption is reliable.

### Day detail

Show the raw 15-minute streams with sunrise and sunset. Handle 92-, 96-, and 100-interval days by timestamp. Use percentile-based axis defaults and provide an explicit `include anomalies` toggle.

## Comparisons and Rankings

Useful secondary views are:

- Year-over-year monthly production, import, export, and household use.
- Best production days with anomaly status.
- Highest household-demand days.
- Net-export and net-import day rankings.
- Weekday versus weekend distributions.
- Seasonal self-consumption versus self-sufficiency.

Prefer distributions, medians, and percentiles over a single average because the daily data is strongly skewed.

## Weather and Heating

Display:

- Solar production with daylight duration and precipitation.
- A month-filtered production-versus-precipitation scatter plot.
- Gas energy versus average outdoor temperature.
- Heating-degree-style summaries only after choosing and documenting a base temperature.

Do not show sunshine-duration analysis while `tsun` remains empty. Do not label gas as `m3` or `kWh` until its provider unit is verified.

## EV Charging

Use `C` as a day annotation and a filter. A comparison can show household consumption on marked versus unmarked days, but it must be labelled as association rather than EV energy consumption. Do not estimate EV kWh from this flag.

## Battery Scenarios

The file has no actual battery telemetry. A battery section can only be a simulation based on observed export and later import.

Expose capacity, charge power, discharge power, efficiency, minimum state of charge, and tariff assumptions. Report grid-import reduction, export reduction, cycles, losses, and cost effect separately. Do not present the unconstrained same-day upper bound as achievable savings.

## Data Quality UX

Include a compact data-health panel with:

- Latest date by solar, grid, and weather source.
- Number of missing or incomplete days in the selected period.
- Number of anomaly-flagged days.
- Whether daily values were replaced by complete interval sums.
- A warning when the selected range includes partial 2023 or post-2026-02-08 grid data.

Specific cleanup rules:

1. Prefer complete `Q.C` and `Q.I` sums over discrepant daily `U` and `I` values.
2. Fall back to daily values only when interval arrays are absent or incomplete.
3. Preserve DST days with their actual timestamps.
4. Exclude extreme intervals from automatic chart scaling, but retain them for inspection.
5. Do not silently clamp negative derived 15-minute consumption to zero; omit that derived series until alignment is solved.

## Unsupported Claims

The JSON alone cannot support reliable displays for:

- Electricity cost or revenue without import/export tariffs and fixed charges.
- Carbon savings without a documented marginal or average emissions factor.
- Investment return without installation costs and tariff history.
- Actual battery performance without battery telemetry.
- Exact EV charging energy without session-level measurements.

These can be added only when the missing inputs and assumptions are visible to the user.

## Required Mapping Correction

The application service currently treats `I` as import and derives export from `P - U`. Based on the source ingestion and the confirmed field meanings, the mapping must be:

```text
Production  = P
GridImport  = U
GridExport  = I / 1000
Consumption = P + U - (I / 1000)
```

This correction should precede any dashboard work because it changes consumption, import, export, self-consumption, and self-sufficiency throughout the application.