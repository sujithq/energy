# Energy Data Profile

Analysis date: 2026-08-14

Primary source: <https://raw.githubusercontent.com/sujithq/myenergy/refs/heads/main/src/myenergy/wwwroot/Data/data.json>

Grid supplement: sanitized Fluvius quarter-hour export in `data/grid-supplement.json`

## Coverage

The file contains 1,310 unique, consecutive daily records.

| Year | First date | Last date | Records | Status |
|---|---:|---:|---:|---|
| 2023 | 2023-01-13 | 2023-12-31 | 353 | Partial year; solar first becomes non-zero on 2023-05-22 |
| 2024 | 2024-01-01 | 2024-12-31 | 366 | Complete |
| 2025 | 2025-01-01 | 2025-12-31 | 365 | Complete |
| 2026 | 2026-01-01 | 2026-08-14 | 226 | Partial; source-specific cutoffs apply |

Only 2024 and 2025 are directly comparable as complete years.

Data freshness differs by source:

- Solar values exist through 2026-08-14, which is a partial current day. Solar records are finalized through 2026-08-08.
- Weather records are finalized through 2026-08-08.
- June Energy 15-minute import and export records end on 2026-02-08.
- A sanitized Fluvius export restores 186 complete grid days from 2026-02-09 through 2026-08-13. Existing complete June Energy intervals retain precedence.
- Combined grid coverage therefore runs through 2026-08-13.
- The 2026-08-14 Fluvius rows have blank volumes and status `Geen verbruik`; that unread day is excluded rather than represented as zero.
- The June Energy grid-source completion flag is true only through 2026-02-02 because recent records were deliberately left unfinalized for several days.

Every visualization should show a freshness date for each source it uses.

The Fluvius supplement contains only dates and kWh import/export arrays. Its 2026-03-29 daylight-saving day has 92 intervals; all other included days have 96. The private source CSV, including EAN, meter serial, and address description, is neither required by the browser nor included in the Pages artifact.

## Daily Record

| Field | Meaning | Unit or type |
|---|---|---|
| `D` | Ordinal day of year | Integer |
| `P` | Solar-panel production | kWh/day |
| `U` | Electricity consumed from the grid, also described as net use | kWh/day |
| `I` | Electricity injected into the grid | Wh/day; divide by 1,000 for kWh |
| `J` | June Energy/grid source finalized | Boolean |
| `S` | Sungrow/solar source finalized | Boolean |
| `MS` | Meteostat daily weather | Object |
| `M` | Weather source finalized | Boolean |
| `AS` | Generated anomaly scores for `P`, `U`, and `I` | Object |
| `Q` | 15-minute measurements | Object |
| `C` | Day overlaps a known EV charging session | Boolean |
| `SRS` | Sunrise and sunset timestamps | Object |

`U` is grid import. It is not total household consumption. `I` is grid export, not import.

## Derived Energy Metrics

First convert daily injection to kWh:

$$
E = \frac{I}{1000}
$$

With no measured battery flow, the following balances can be derived:

$$
\begin{aligned}
\text{Household consumption} &= P + U - E \\
\text{Self-used solar} &= P - E \\
\text{Self-consumption rate} &= \frac{P-E}{P} \\
\text{Self-sufficiency rate} &= \frac{P-E}{P+U-E} \\
\text{Net grid balance} &= U-E
\end{aligned}
$$

A positive net grid balance means net import; a negative value means net export.

Self-consumption and self-sufficiency answer different questions:

- Self-consumption: how much generated solar was used locally?
- Self-sufficiency: how much household demand was supplied by solar?

## 15-Minute Record

| `Q` field | Meaning | Unit/status |
|---|---|---|
| `C` | Grid import | kWh per 15-minute interval |
| `I` | Grid injection/export | kWh per 15-minute interval |
| `G` | Gas energy reported by June Energy | Provider unit; likely kWh, but requires confirmation |
| `P` | Solar production sample | kW; divide summed values by 4 to approximate daily kWh |
| `WRT` | Boiler-room temperature | Empty or null throughout this file |
| `WOT` | Boiler outdoor temperature | Empty or null throughout this file |
| `WP` | Boiler installation pressure | Empty or null throughout this file |

Normal days contain 96 intervals. Daylight-saving transitions correctly produce 92 or 100 grid intervals. Charts must use timestamps rather than assuming every day has 96 points.

## Weather Record

`MS` contains average/minimum/maximum temperature, precipitation, snow, wind direction, wind speed, gust speed, pressure, and sunshine duration.

Usable fields are temperature, precipitation, wind speed, gust speed, and pressure. The following fields are unusable in the current file:

- Sunshine duration (`tsun`) is zero for every 2024-2025 record.
- Wind direction (`wdir`) is zero for every 2024-2025 record.
- Snow is zero for every 2024-2025 record and therefore has no analytical variation.

Sunrise and sunset are complete and imply daylight lengths from about 7.99 to 16.61 hours.

## Quality Findings

Daily grid summaries and 15-minute totals usually agree, but not always. The largest cluster of missing daily values is 2025-09-24 through 2025-09-29, where daily `U` or `I` is zero while interval data contains energy. For aggregate reporting, use summed `Q.C` and `Q.I` when a complete interval day exists. Fall back to daily `U` and `I` only when `J` is true and both values are finite, nonnegative numbers.

There are 88 records carrying a generated anomaly flag. Preserve these records, but mark them in detailed views and allow users to exclude them from comparisons.

One extreme interval reports 34.801 kWh of import at 2025-12-07 22:15, equivalent to 139.2 kW. This is more than ten times the 99.9th percentile and should not determine chart scales or typical-day averages.

About 5% of same-index 15-minute household-load calculations are negative. Daily energy balances remain physically valid, but the independent solar and grid streams are not aligned accurately enough to derive household consumption at 15-minute resolution without further timestamp correction. Display the observed solar, import, and export streams separately at that resolution.

Gas is labelled as cubic metres in the application, but the source request uses `valueType=ENERGY` and annual totals are roughly 16,000 to 18,000. Those magnitudes fit kWh much better than cubic metres. Label it as `Gas energy (provider unit)` until the June Energy API contract confirms the unit.

The EV flag identifies charging-session days only. It contains no charging energy, charger power, or session details and has no marked days after 2024.

There is no actual battery state-of-charge, charge, or discharge telemetry in this file.