import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DAILY_ARCHETYPE_MIN_REFERENCE_DAYS,
  DAILY_ARCHETYPE_ORDER,
  buildDailyArchetypes,
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

function contrastRatio(left, right) {
  const luminance = (color) => color.match(/[\da-f]{2}/gi)
    .map((part) => parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const [lighter, darker] = [luminance(left), luminance(right)].sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}