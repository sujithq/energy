import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DAILY_ARCHETYPE_MIN_REFERENCE_DAYS,
  DAILY_ARCHETYPE_ORDER,
  buildDailyArchetypes,
  buildDailyRangeDistribution,
  buildEnergyUtilizationFunnel,
  buildGoodSolarDayScorecard,
  buildGridDependencyClock,
  buildGridPeakTimingHeatmap,
  buildOvernightGridReliance,
  buildSourceCoverageTimeline,
  buildSurplusHeatmap,
  canonicalizeDaySeries,
  normalizePeriodAnchor
} from "../dashboard-model.js";

test("heatmap uses median hourly grid export from complete profiles", () => {
  const heatmap = buildSurplusHeatmap([{
    month: 7,
    rows: [
      exportRecord(hourlyValue(1), "2026-07-01"),
      exportRecord(hourlyValue(2), "2026-07-02"),
      exportRecord(hourlyValue(3), "2026-07-03")
    ]
  }]);

  assert.equal(heatmap.sampleDays, 3);
  assert.equal(heatmap.rows.length, 1);
  assert.equal(heatmap.rows[0].cells[12].value, 8);
  assert.equal(heatmap.rows[0].cells[12].samples, 3);
  assert.equal(heatmap.peak.hour, 12);
  assert.equal(heatmap.peak.value, 8);
  assert.equal(heatmap.latestIso, "2026-07-03");
});

test("heatmap preserves daylight-saving gaps and averages the repeated hour", () => {
  const springProfile = canonicalizeDaySeries(Array(92).fill(1));
  assert.equal(springProfile.length, 96);
  assert.deepEqual(springProfile.slice(8, 12), [null, null, null, null]);

  const autumnInput = [
    ...Array(8).fill(0),
    ...Array(4).fill(1),
    ...Array(4).fill(3),
    ...Array(84).fill(0)
  ];
  const autumnProfile = canonicalizeDaySeries(autumnInput);
  assert.equal(autumnProfile.length, 96);
  assert.deepEqual(autumnProfile.slice(8, 12), Array(4).fill(2));

  const heatmap = buildSurplusHeatmap([{
    month: 10,
    rows: [exportRecord(Array(92).fill(1)), exportRecord(autumnInput)]
  }]);
  assert.equal(heatmap.rows[0].cells[2].value, 8);
  assert.equal(heatmap.rows[0].cells[2].samples, 1);
});

test("heatmap contains only supplied partial-year months", () => {
  const heatmap = buildSurplusHeatmap([
    { month: 1, rows: [exportRecord(hourlyValue(1))] },
    { month: 8, rows: [exportRecord(hourlyValue(1))] }
  ]);

  assert.deepEqual(heatmap.rows.map((row) => row.month), [1, 8]);
});

test("daily archetypes apply ranked, mutually exclusive patterns with anomaly precedence", () => {
  const archetypes = buildDailyArchetypes([
    archetypeRecord("2026-01-01", { householdUse: 10, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-01-02", { householdUse: 11, gridImport: 6, gridExport: 6 }),
    archetypeRecord("2026-01-03", { householdUse: 12, gridImport: 7, gridExport: 7 }),
    archetypeRecord("2026-01-04", { householdUse: 13, gridImport: 8, gridExport: 8 }),
    archetypeRecord("2026-01-05", { householdUse: 14, gridImport: 100, gridExport: 1 }),
    archetypeRecord("2026-01-06", { householdUse: 15, gridImport: 50, gridExport: 1 }),
    archetypeRecord("2026-01-07", { householdUse: 16, gridImport: 40, gridExport: 1 }),
    archetypeRecord("2026-01-08", { householdUse: 17, gridImport: 30, gridExport: 1 }),
    archetypeRecord("2026-01-09", { householdUse: 18, gridImport: 1, gridExport: 100 }),
    archetypeRecord("2026-01-10", { householdUse: 19, gridImport: 1, gridExport: 50 }),
    archetypeRecord("2026-01-11", { householdUse: 20, gridImport: 1, gridExport: 40 }),
    archetypeRecord("2026-01-12", { householdUse: 21, gridImport: 1, gridExport: 30 }),
    archetypeRecord("2026-01-13", { householdUse: 80, gridImport: 100, gridExport: 0, anomaly: true }),
    archetypeRecord("2026-01-14", { hasGrid: false }),
    archetypeRecord("2026-01-15", { hasGrid: false, anomaly: true })
  ]);

  assert.deepEqual(archetypes.days.map((day) => day.category), [
    "typical", "typical", "typical", "typical", "gridHeavy", "typical", "typical",
    "typical", "solarSurplus", "highUse", "highUse", "highUse", "anomaly", "incomplete",
    "anomaly"
  ]);
  assert.deepEqual(archetypes.counts, {
    anomaly: 2,
    highUse: 3,
    solarSurplus: 1,
    gridHeavy: 1,
    typical: 7,
    incomplete: 1
  });
  assert.equal(archetypes.completeDays, 13);
  assert.equal(archetypes.referenceDays, 12);
  assert.equal(archetypes.hasSufficientReferenceDays, true);
  assert.equal(archetypes.incompleteDays, 2);
  assert.equal(archetypes.days.at(-1).gridIncomplete, true);
  assert.equal(archetypes.latestGridIso, "2026-01-13");
  assert.equal(DAILY_ARCHETYPE_MIN_REFERENCE_DAYS, 8);
  assert.deepEqual(DAILY_ARCHETYPE_ORDER, [
    "anomaly", "highUse", "solarSurplus", "gridHeavy", "typical", "incomplete"
  ]);
});

test("daily archetypes leave sparse complete selections unlabelled", () => {
  const archetypes = buildDailyArchetypes([
    archetypeRecord("2026-02-01", { householdUse: 10, gridImport: 1, gridExport: 50 }),
    archetypeRecord("2026-02-02", { householdUse: 20, gridImport: 2, gridExport: 40 }),
    archetypeRecord("2026-02-03", { householdUse: 30, gridImport: 40, gridExport: 1 }),
    archetypeRecord("2026-02-04", { householdUse: 40, gridImport: 50, gridExport: 1 })
  ]);

  assert.equal(archetypes.hasSufficientReferenceDays, false);
  assert.deepEqual(archetypes.days.map((day) => day.category), Array(4).fill("typical"));
  assert.equal(archetypes.counts.highUse, 0);
  assert.equal(archetypes.counts.solarSurplus, 0);
  assert.equal(archetypes.counts.gridHeavy, 0);
});

test("daily archetypes use deterministic ranks at exact reference boundaries and ties", () => {
  const exactReference = buildDailyArchetypes([
    archetypeRecord("2026-03-03", { householdUse: 100, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-03-01", { householdUse: 100, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-03-02", { householdUse: 100, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-03-04", { householdUse: 20, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-03-05", { householdUse: 19, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-03-06", { householdUse: 18, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-03-07", { householdUse: 17, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-03-08", { householdUse: 16, gridImport: 5, gridExport: 5 })
  ]);

  assert.equal(exactReference.hasSufficientReferenceDays, true);
  assert.deepEqual(
    exactReference.days.filter((day) => day.category === "highUse").map((day) => day.iso),
    ["2026-03-01", "2026-03-02"]
  );

  const exactDirectional = buildDailyArchetypes([
    archetypeRecord("2026-04-03", { householdUse: 10, gridImport: 1, gridExport: 50 }),
    archetypeRecord("2026-04-01", { householdUse: 10, gridImport: 1, gridExport: 50 }),
    archetypeRecord("2026-04-02", { householdUse: 10, gridImport: 1, gridExport: 50 }),
    archetypeRecord("2026-04-04", { householdUse: 10, gridImport: 1, gridExport: 50 }),
    archetypeRecord("2026-04-05", { householdUse: 20, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-04-06", { householdUse: 19, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-04-07", { householdUse: 18, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-04-08", { householdUse: 17, gridImport: 5, gridExport: 5 })
  ]);

  assert.deepEqual(
    exactDirectional.days.filter((day) => day.category === "solarSurplus").map((day) => day.iso),
    ["2026-04-01"]
  );

  const exactImportDirectional = buildDailyArchetypes([
    archetypeRecord("2026-05-03", { householdUse: 10, gridImport: 50, gridExport: 1 }),
    archetypeRecord("2026-05-01", { householdUse: 10, gridImport: 50, gridExport: 1 }),
    archetypeRecord("2026-05-04", { householdUse: 10, gridImport: 50, gridExport: 1 }),
    archetypeRecord("2026-05-02", { householdUse: 10, gridImport: 50, gridExport: 1 }),
    archetypeRecord("2026-05-05", { householdUse: 20, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-05-06", { householdUse: 19, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-05-07", { householdUse: 18, gridImport: 5, gridExport: 5 }),
    archetypeRecord("2026-05-08", { householdUse: 17, gridImport: 5, gridExport: 5 })
  ]);

  assert.deepEqual(
    exactImportDirectional.days.filter((day) => day.category === "gridHeavy").map((day) => day.iso),
    ["2026-05-01"]
  );
});

test("daily archetype marker visual contract keeps markers contrast-safe", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const markerColor = /--tile-marker:\s*(#[\da-f]{6})/i.exec(styles)?.[1];
  assert.equal(markerColor, "#102f25");
  assert.match(styles, /\.daily-archetype-marker\s*\{[\s\S]*?color:\s*var\(--tile-marker\)/);
  assert.match(styles, /\.daily-archetype-coverage-marker\s*\{[\s\S]*?background:\s*var\(--tile-marker\)/);
  assert.match(styles, /\.daily-archetype-tile\.is-grid-incomplete:not\(\.is-incomplete\)\s*\{[\s\S]*?outline:\s*2px dashed var\(--tile-marker\)/);

  for (const background of ["#e6b34c", "#6e9dc1", "#5fa87f", "#d98776", "#aebbb4", "#f5f6f4"]) {
    assert.ok(contrastRatio(markerColor, background) >= 4.5, `${markerColor} must contrast with ${background}`);
  }
});

test("solar utilisation funnel conserves solar production and household demand", () => {
  const funnel = buildEnergyUtilizationFunnel({
    selfUsedSolar: 30,
    commonGridExport: 70,
    commonGridImport: 50
  });

  assert.deepEqual(funnel, {
    solar: { total: 100, first: 30, second: 70, firstShare: 30, secondShare: 70 },
    household: { total: 80, first: 30, second: 50, firstShare: 37.5, secondShare: 62.5 }
  });
});

test("solar utilisation funnel rejects incomplete or negative values", () => {
  assert.equal(buildEnergyUtilizationFunnel({ selfUsedSolar: 1, commonGridExport: null, commonGridImport: 2 }), null);
  assert.equal(buildEnergyUtilizationFunnel({ selfUsedSolar: 1, commonGridExport: -1, commonGridImport: 2 }), null);
});

test("solar utilisation funnel reports zero-energy branches as zero percent", () => {
  const funnel = buildEnergyUtilizationFunnel({ selfUsedSolar: 0, commonGridExport: 0, commonGridImport: 0 });

  assert.deepEqual(funnel.solar, { total: 0, first: 0, second: 0, firstShare: 0, secondShare: 0 });
  assert.deepEqual(funnel.household, { total: 0, first: 0, second: 0, firstShare: 0, secondShare: 0 });
});

test("source coverage timeline merges contiguous states without crossing date gaps", () => {
  const timeline = buildSourceCoverageTimeline([
    coverageRecord("2026-01-01", { solarFinal: true, gridIntervalsComplete: true, weatherFinal: true }),
    coverageRecord("2026-01-02", { supplementedGrid: true, weather: { tavg: 2 } }),
    coverageRecord("2026-01-03", { supplementedGrid: true, weather: { tavg: 3 } }),
    coverageRecord("2026-01-05", { hasGrid: false, weather: {} }),
    coverageRecord("2026-01-06", { gridFinal: true, weatherFinal: true })
  ]);

  assert.equal(timeline.days, 5);
  assert.equal(timeline.daySpan, 6);
  assert.equal(timeline.firstIso, "2026-01-01");
  assert.equal(timeline.lastIso, "2026-01-06");
  assert.deepEqual(timeline.sources.map((source) => source.id), ["solar", "grid", "weather"]);
  assert.deepEqual(timeline.sources[0].segments.map(segmentSummary), [
    ["final", "2026-01-01", "2026-01-01", 1],
    ["provisional", "2026-01-02", "2026-01-03", 2],
    ["provisional", "2026-01-05", "2026-01-06", 2]
  ]);
  assert.deepEqual(timeline.sources[1].segments.map(segmentSummary), [
    ["intervals", "2026-01-01", "2026-01-01", 1],
    ["fluvius", "2026-01-02", "2026-01-03", 2],
    ["unavailable", "2026-01-05", "2026-01-05", 1],
    ["daily", "2026-01-06", "2026-01-06", 1]
  ]);
  assert.deepEqual(timeline.sources[2].segments.map(segmentSummary), [
    ["final", "2026-01-01", "2026-01-01", 1],
    ["provisional", "2026-01-02", "2026-01-03", 2],
    ["unavailable", "2026-01-05", "2026-01-05", 1],
    ["final", "2026-01-06", "2026-01-06", 1]
  ]);
  assert.equal(timeline.sources[0].segments[2].startOffset, 4);
});

test("source coverage timeline preserves selected bounds and source-state precedence", () => {
  const timeline = buildSourceCoverageTimeline([
    coverageRecord("2026-02-03", {
      supplementedGrid: true,
      gridIntervalsComplete: true,
      gridFinal: true,
      weather: { tavg: 2 }
    }),
    coverageRecord("2026-02-08", {
      hasGrid: false,
      supplementedGrid: true,
      gridIntervalsComplete: true,
      gridFinal: true,
      weatherFinal: true
    })
  ], { startIso: "2026-02-01", endIso: "2026-02-10" });

  assert.equal(timeline.days, 2);
  assert.equal(timeline.daySpan, 10);
  assert.equal(timeline.periodStartIso, "2026-02-01");
  assert.equal(timeline.periodEndIso, "2026-02-10");
  assert.equal(timeline.sources[1].segments[0].state, "fluvius");
  assert.equal(timeline.sources[1].segments[0].startOffset, 2);
  assert.equal(timeline.sources[1].segments[1].state, "unavailable");
  assert.equal(timeline.sources[1].segments[1].startOffset, 7);
  assert.equal(timeline.sources[2].segments[1].state, "final");
});

test("grid dependency clock classifies hourly import, export, balanced, and missing profiles", () => {
  const clock = buildGridDependencyClock([
    gridClockRecord("2026-06-01", gridClockIntervals({ importHours: [18], exportHours: [12] })),
    gridClockRecord("2026-06-02", gridClockIntervals({ importHours: [18], exportHours: [12] })),
    gridClockRecord("2026-06-03", gridClockIntervals({ exportHours: [12] })),
    gridClockRecord("2026-06-04", gridClockIntervals({ balancedHours: [6] })),
    gridClockRecord("2026-06-05", { import: Array(92).fill(1), export: Array(92).fill(0) })
  ]);

  assert.equal(clock.sampleDays, 5);
  assert.equal(clock.latestIso, "2026-06-05");
  assert.equal(clock.hours[18].state, "import");
  assert.equal(clock.hours[18].importDays, 3);
  assert.equal(clock.hours[18].importShare, 60);
  assert.equal(clock.hours[12].state, "export");
  assert.equal(clock.hours[12].exportDays, 3);
  assert.equal(clock.hours[6].state, "balanced");
  assert.equal(clock.hours[2].samples, 4);
  assert.equal(clock.peakImport.hour, 18);
  assert.equal(clock.peakExport.hour, 12);
});

test("grid dependency clock exposes unavailable hours when no complete profiles exist", () => {
  const clock = buildGridDependencyClock([
    { iso: "2026-07-01", gridIntervalsComplete: false, intervals: { import: [], export: [] } }
  ]);

  assert.equal(clock.sampleDays, 0);
  assert.equal(clock.latestIso, null);
  assert.equal(clock.peakImport, null);
  assert.equal(clock.peakExport, null);
  assert.equal(clock.hours.every((hour) => hour.state === "unavailable" && hour.samples === 0), true);
});

test("overnight grid reliance uses complete DST-normalized 00-06 windows", () => {
  const overnight = buildOvernightGridReliance([{
    month: 6,
    rows: [
      gridClockRecord("2026-06-01", gridClockIntervals({ importHours: [0, 1, 2, 3, 4, 5] })),
      gridClockRecord("2026-06-02", gridClockIntervals({ importHours: [0, 1] })),
      gridClockRecord("2026-06-03", { import: Array(92).fill(1), export: Array(92).fill(0) }),
      gridClockRecord("2026-06-04", autumnOvernightProfile())
    ]
  }]);

  assert.equal(overnight.sampleDays, 3);
  assert.equal(overnight.excludedProfileDays, 1);
  assert.equal(overnight.latestIso, "2026-06-04");
  assert.equal(overnight.groups[0].sampleDays, 3);
  assert.equal(overnight.groups[0].excludedProfileDays, 1);
  assert.equal(overnight.hourlyMedians[0], 4);
  assert.equal(overnight.hourlyMedians[2], 4);
  assert.equal(overnight.medianOvernight, 20);
  assert.ok(overnight.overnightShare > 0);
});

test("overnight grid reliance returns null hourly medians without complete overnight windows", () => {
  const overnight = buildOvernightGridReliance([{
    month: 3,
    rows: [gridClockRecord("2026-03-01", { import: Array(92).fill(1), export: Array(92).fill(0) })]
  }]);

  assert.equal(overnight.sampleDays, 0);
  assert.deepEqual(overnight.hourlyMedians, Array(6).fill(null));
  assert.deepEqual(overnight.groups[0].hourlyMedians, Array(6).fill(null));
});

test("good solar day scorecard rewards output and local solar use while excluding incomplete days", () => {
  const scorecard = buildGoodSolarDayScorecard([
    solarScoreRecord("2026-07-01", { production: 20, selfUsedSolar: 18, householdUse: 20, gridExport: 2 }),
    solarScoreRecord("2026-07-02", { production: 40, selfUsedSolar: 4, householdUse: 18, gridExport: 36 }),
    solarScoreRecord("2026-07-03", { production: 30, selfUsedSolar: 15, householdUse: 20, gridExport: 15 }),
    solarScoreRecord("2026-07-04", { hasGrid: false, production: 50, selfUsedSolar: 45, householdUse: 50, gridExport: 5 })
  ]);

  assert.equal(scorecard.qualifyingDays, 3);
  assert.equal(scorecard.latestIso, "2026-07-03");
  assert.equal(scorecard.topDays[0].iso, "2026-07-01");
  assert.equal(scorecard.topDays[0].selfSufficiency, 90);
  assert.deepEqual(scorecard.scoreWeights, { production: 30, selfSufficiency: 40, selfConsumption: 30 });
});

test("good solar day scorecard breaks equal scores by production then date", () => {
  const scorecard = buildGoodSolarDayScorecard([
    solarScoreRecord("2026-08-02", { production: 20, selfUsedSolar: 20, householdUse: 20, gridExport: 0 }),
    solarScoreRecord("2026-08-01", { production: 20, selfUsedSolar: 20, householdUse: 20, gridExport: 0 })
  ]);

  assert.deepEqual(scorecard.topDays.map((day) => day.iso), ["2026-08-01", "2026-08-02"]);
});

test("daily range distribution reports interpolated quartiles and omits unavailable grid values", () => {
  const distribution = buildDailyRangeDistribution([{
    month: 7,
    rows: [
      distributionRecord({ production: 1, householdUse: 10, gridImport: 5, gridExport: 1 }),
      distributionRecord({ production: 2, householdUse: 20, gridImport: 6, gridExport: 2 }),
      distributionRecord({ production: 3, householdUse: 30, gridImport: 7, gridExport: 3 }),
      distributionRecord({ production: 4, householdUse: 40, gridImport: 8, gridExport: 4 })
    ]
  }, {
    month: 8,
    rows: [distributionRecord({ production: 5, hasGrid: false })]
  }], "production");

  assert.equal(distribution.sampleDays, 5);
  assert.equal(distribution.rows[0].lowerQuartile, 1.75);
  assert.equal(distribution.rows[0].median, 2.5);
  assert.equal(distribution.rows[0].upperQuartile, 3.25);
  assert.equal(distribution.rows[0].upperDecile, 3.7);
  assert.equal(distribution.maxValue, 5);

  const grid = buildDailyRangeDistribution([{
    month: 8,
    rows: [distributionRecord({ gridImport: 4 }), distributionRecord({ hasGrid: false, gridImport: 99 })]
  }], "gridImport");
  assert.equal(grid.rows[0].sampleDays, 1);
  assert.equal(grid.rows[0].median, 4);
});

test("grid peak timing heatmap distributes tied hourly maxima and omits zero profiles", () => {
  const heatmap = buildGridPeakTimingHeatmap([{
    month: 6,
    rows: [
      gridClockRecord("2026-06-01", gridClockIntervals({ importHours: [18], exportHours: [12] })),
      gridClockRecord("2026-06-02", gridClockIntervals({ importHours: [17, 18], exportHours: [12] })),
      gridClockRecord("2026-06-03", gridClockIntervals()),
      gridClockRecord("2026-06-04", autumnPeakProfile())
    ]
  }], "import");

  const row = heatmap.rows[0];
  assert.equal(row.sampleDays, 4);
  assert.equal(row.peakDays, 3);
  assert.equal(row.cells[18].weight, 1.5);
  assert.equal(row.cells[18].share, 50);
  assert.equal(row.cells[17].weight, 0.5);
  assert.equal(row.cells[2].weight, 1);
  assert.equal(heatmap.peak.hour, 18);
  assert.equal(heatmap.latestIso, "2026-06-04");

  const exportHeatmap = buildGridPeakTimingHeatmap([{
    month: 6,
    rows: [
      gridClockRecord("2026-06-01", gridClockIntervals({ exportHours: [12] })),
      gridClockRecord("2026-06-02", gridClockIntervals({ exportHours: [12] }))
    ]
  }], "export");
  assert.equal(exportHeatmap.peak.hour, 12);
  assert.equal(exportHeatmap.rows[0].cells[12].share, 100);

  const lowPositiveHeatmap = buildGridPeakTimingHeatmap([{
    month: 6,
    rows: [gridClockRecord("2026-06-05", lowPositivePeakProfile())]
  }], "import");
  assert.equal(lowPositiveHeatmap.peak.hour, 4);
  assert.equal(lowPositiveHeatmap.rows[0].cells[4].share, 100);
});

test("Pages artifact source and grid-clock selectors remain radio groups and stage their module", async () => {
  const [app, workflow] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8")
  ]);

  assert.match(app, /role="radiogroup"/);
  assert.match(app, /role="radio"[\s\S]*?aria-checked/);
  assert.match(app, /ArrowLeft[\s\S]*?ArrowRight[\s\S]*?ArrowDown/);
  assert.equal(app.includes('class="grid-clock-face" role="radiogroup"'), true);
  assert.equal(app.includes('role="radio" class="grid-clock-hour'), true);
  assert.equal(app.includes('data-grid-clock-hour="${hour.hour}"'), true);
  assert.equal(app.includes('role="radio" data-peak-timing-metric="${metric.id}"'), true);
  assert.match(workflow, /cp\s+index\.html\s+styles\.css\s+app\.js\s+dashboard-model\.js\s+\.nojekyll/);
});

test("solar utilisation funnel ignores all-grid totals outside common solar coverage", () => {
  const funnel = buildEnergyUtilizationFunnel({
    selfUsedSolar: 30,
    commonGridExport: 70,
    commonGridImport: 50,
    gridExport: 900,
    gridImport: 800
  });

  assert.equal(funnel.solar.total, 100);
  assert.equal(funnel.household.total, 80);
  assert.equal(funnel.solar.second, 70);
  assert.equal(funnel.household.second, 50);
});

test("period anchors clamp to an observed record within the selected year or month", () => {
  const records = [
    record("2025-12-31"),
    record("2026-01-01"),
    record("2026-08-14")
  ];

  assert.equal(normalizePeriodAnchor(records, "2026-12-31", "year"), "2026-08-14");
  assert.equal(normalizePeriodAnchor(records, "2026-08-31", "month"), "2026-08-14");
  assert.equal(normalizePeriodAnchor(records, "2026-08-31", "day"), "2026-08-14");
  assert.equal(normalizePeriodAnchor(records, "2026-01-01", "day"), "2026-01-01");
  assert.equal(normalizePeriodAnchor(records, "2026-02-30", "month"), "2026-08-14");
});

function exportRecord(exportValues, iso) {
  return {
    gridIntervalsComplete: true,
    iso,
    intervals: { export: exportValues }
  };
}

function hourlyValue(value) {
  return Array.from({ length: 96 }, (_, index) => (
    index >= 48 && index < 52 ? value : 0
  ));
}

function record(iso) {
  return {
    iso,
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7))
  };
}

function archetypeRecord(iso, values) {
  return {
    iso,
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
    hasGrid: true,
    anomaly: false,
    householdUse: 0,
    gridImport: 0,
    gridExport: 0,
    ...values
  };
}

function coverageRecord(iso, values = {}) {
  return {
    iso,
    solarFinal: false,
    hasGrid: true,
    gridIntervalsComplete: false,
    supplementedGrid: false,
    gridFinal: false,
    weatherFinal: false,
    weather: {},
    ...values
  };
}

function gridClockRecord(iso, intervals) {
  return {
    iso,
    gridIntervalsComplete: true,
    intervals
  };
}

function gridClockIntervals({ importHours = [], exportHours = [], balancedHours = [] } = {}) {
  const importValues = Array(96).fill(0);
  const exportValues = Array(96).fill(0);
  importHours.forEach((hour) => importValues.splice(hour * 4, 4, ...Array(4).fill(1)));
  exportHours.forEach((hour) => exportValues.splice(hour * 4, 4, ...Array(4).fill(1)));
  balancedHours.forEach((hour) => {
    importValues.splice(hour * 4, 4, ...Array(4).fill(1));
    exportValues.splice(hour * 4, 4, ...Array(4).fill(1));
  });
  return { import: importValues, export: exportValues };
}

function autumnPeakProfile() {
  return {
    import: [...Array(8).fill(0), ...Array(4).fill(1), ...Array(4).fill(3), ...Array(84).fill(0)],
    export: Array(100).fill(0)
  };
}

function lowPositivePeakProfile() {
  const importValues = Array(96).fill(0);
  importValues.splice(4 * 4, 4, ...Array(4).fill(0.0025));
  return { import: importValues, export: Array(96).fill(0) };
}

function solarScoreRecord(iso, values) {
  return {
    iso,
    hasGrid: true,
    production: 0,
    selfUsedSolar: 0,
    householdUse: 0,
    gridExport: 0,
    ...values
  };
}

function distributionRecord(values = {}) {
  return {
    hasGrid: true,
    production: 0,
    householdUse: 0,
    gridImport: 0,
    gridExport: 0,
    ...values
  };
}

function autumnOvernightProfile() {
  return {
    import: [...Array(8).fill(1), ...Array(4).fill(2), ...Array(4).fill(4), ...Array(84).fill(0)],
    export: Array(100).fill(0)
  };
}

function segmentSummary(segment) {
  return [segment.state, segment.startIso, segment.endIso, segment.length];
}

function contrastRatio(left, right) {
  const luminance = (color) => color.match(/[\da-f]{2}/gi)
    .map((part) => parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const [lighter, darker] = [luminance(left), luminance(right)].sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}