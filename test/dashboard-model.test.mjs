import assert from "node:assert/strict";
import test from "node:test";

import {
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