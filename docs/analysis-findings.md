# Energy Analysis Findings

Analysis date: 2026-08-14

## Method

The complete years 2024 and 2025 provide the soundest comparison. Solar production uses daily `P`. Grid import and export use summed 15-minute `Q.C` and `Q.I` where complete because these arrays repair several faulty daily summaries.

All energy values below are kWh unless stated otherwise.

## Complete-Year Comparison

| Metric | 2024 | 2025 | Change |
|---|---:|---:|---:|
| Solar production | 6,704.9 | 7,659.2 | +14.2% |
| Grid import | 5,412.7 | 5,086.4 | -6.0% |
| Grid export | 4,901.9 | 5,565.4 | +13.5% |
| Household consumption | 7,215.6 | 7,180.2 | -0.5% |
| Self-used solar | 1,803.0 | 2,093.8 | +16.1% |
| Self-consumption rate | 26.9% | 27.3% | +0.4 percentage points |
| Self-sufficiency rate | 25.0% | 29.2% | +4.2 percentage points |
| Net grid balance | 510.7 imported | 479.0 exported | Improved by 989.8 |

The main finding is that 2025 generated substantially more solar while household demand remained almost unchanged. This reduced grid import and made the property a net exporter over the year.

Annual net export does not mean grid independence. In 2025 the property still imported 5.09 MWh and exported 5.57 MWh at different times. This timing mismatch is the strongest evidence for load-shifting and battery-scenario displays.

## Monthly Pattern

The table below averages each calendar month across 2024 and 2025.

| Month | Production | Import | Export | Household use | Self-consumption | Self-sufficiency |
|---|---:|---:|---:|---:|---:|---:|
| Jan | 200.2 | 663.2 | 120.2 | 743.2 | 42.1% | 10.8% |
| Feb | 297.8 | 525.3 | 201.1 | 621.9 | 32.7% | 15.7% |
| Mar | 650.5 | 440.3 | 475.0 | 615.8 | 27.6% | 28.7% |
| Apr | 854.6 | 333.2 | 678.6 | 509.1 | 20.5% | 34.4% |
| May | 919.8 | 353.4 | 677.9 | 595.3 | 26.4% | 40.6% |
| Jun | 980.7 | 266.6 | 715.8 | 531.5 | 26.9% | 49.6% |
| Jul | 943.3 | 207.5 | 743.2 | 407.6 | 21.2% | 51.5% |
| Aug | 951.6 | 306.4 | 707.5 | 550.4 | 25.6% | 44.4% |
| Sep | 640.7 | 383.7 | 450.7 | 573.7 | 29.6% | 33.3% |
| Oct | 383.6 | 446.4 | 258.8 | 571.2 | 33.1% | 22.2% |
| Nov | 207.0 | 578.6 | 127.2 | 658.3 | 38.9% | 12.2% |
| Dec | 152.5 | 745.2 | 77.7 | 820.0 | 49.7% | 9.3% |

The contrast between the two percentages matters. Winter self-consumption is high because little solar is available to export, but winter self-sufficiency is low. Summer supplies far more household demand while exporting most production.

Across both complete years:

- Summer self-sufficiency was 47.6%; winter self-sufficiency was 11.5%.
- Summer self-consumption was 24.7%; winter self-consumption was 38.7%.
- 390 of 731 days, or 53.4%, exported more electricity than they imported.
- The largest monthly net export was 649.5 kWh in July 2025.
- The largest monthly net import was 763.6 kWh in December 2024.

## Daily Distribution

| Daily metric | Mean | Median | 95th percentile | Maximum |
|---|---:|---:|---:|---:|
| Solar production | 19.65 | 18.60 | 42.60 | 48.10 |
| Grid import | 14.36 | 7.34 | 46.28 | 78.05 |
| Grid export | 14.32 | 12.77 | 35.54 | 44.70 |
| Household consumption | 19.69 | 12.96 | 52.42 | 81.56 |
| Self-used solar | 5.33 | 3.93 | 15.03 | 31.90 |

The maximum production day was 2024-06-09 at 48.1 kWh, but the existing detector flags it as anomalous. The highest unflagged production day was 2025-07-03 at 47.5 kWh. Top-day lists should display anomaly status rather than silently removing a potentially valid record.

Average daily household use was 17.94 kWh on weekdays and 24.11 kWh on weekends. The difference is descriptive, not proof that the weekend caused the increase.

## Typical Intraday Pattern

Robust median or 1%-trimmed profiles avoid the extreme interval outliers.

| Observed stream | Median peak | Median peak value | Trimmed-mean peak |
|---|---:|---:|---:|
| Solar power | 12:30 | 2.137 kW | 13:15 |
| Grid import power | 22:30 | 0.376 kW | 22:30 |
| Grid export power | 12:00 | 1.676 kW | 13:00 |

These profiles support a clear timing story: surplus is concentrated around midday while grid demand peaks much later. Do not currently add a derived 15-minute household-load line because the independent source streams are not sufficiently aligned.

## Weather and Gas

Daily solar production correlates with daylight length at $r=0.768$ and maximum temperature at $r=0.722$, although both are strongly affected by season. After removing monthly averages, the correlation with average temperature is only $r=0.115$ while precipitation retains a negative relationship of $r=-0.353$.

The most defensible weather displays are therefore:

- Solar production versus precipitation within a selected month or season.
- Production alongside sunrise, sunset, and daylight duration.
- Gas energy versus outdoor temperature.

Gas has a strong negative correlation with average temperature, $r=-0.858$. Its totals are 16,093.9 provider units in 2024 and 17,748.8 in 2025. The unit must be confirmed before displaying `kWh` or `m3`.

Sunshine duration cannot currently be analyzed because it is zero throughout the complete years.

## EV Charging Flag

The data marks 110 charging-session days in 2023 and 29 in 2024, with none in 2025 or 2026. During 2024, marked days averaged 36.16 kWh of household use versus 19.01 kWh on unmarked days. This supports a charging-day annotation and comparison, but the flag alone cannot attribute the difference to the EV.

## Storage and Load-Shifting Opportunity

An unconstrained same-day calculation gives an upper bound on export that could theoretically offset import:

| Year | Grid import | Grid export | Same-day shift upper bound | Share of import |
|---|---:|---:|---:|---:|
| 2024 | 5,412.7 | 4,901.9 | 2,100.3 | 38.8% |
| 2025 | 5,086.4 | 5,565.4 | 2,015.8 | 39.6% |

This is not an achievable battery saving. It ignores event order, capacity, charge/discharge power, efficiency, reserve state, degradation, and tariffs. It shows that a scenario simulator is worthwhile, not what battery should be purchased.

## Current Year

Finalized solar production through 2026-08-08 was 5,418.6 kWh. At the same date this was:

- 2.4% below 2025.
- 17.4% above 2024.

With the Fluvius supplement, grid-dependent metrics cover 225 days from 2026-01-01 through 2026-08-13: 39 days from June Energy and 186 restored days from Fluvius. Reconciled values for that period are:

- 5,605.1 kWh solar production.
- 1,362.8 kWh grid import.
- 4,563.3 kWh grid export.
- 2,404.7 kWh derived household consumption.
- 1,041.8 kWh self-used solar.
- 18.6% solar self-consumption and 43.3% solar self-sufficiency.
- 3,200.4 kWh net grid export.

Grid data remains unavailable for 2026-08-14. Its Fluvius rows are unread and must not be interpreted as zero consumption or injection.