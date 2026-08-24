import assert from "node:assert/strict";
import test from "node:test";

import { buildGridSupplementFromApi } from "../scripts/fluvius-api-supplement.mjs";

test("API quarter-hour records produce the existing sanitized schema", () => {
  const records = apiDay("2026-02-09T00:00:00+01:00", 96).reverse();
  const supplement = buildGridSupplementFromApi(records);

  assert.deepEqual(supplement.coverage, {
    from: "2026-02-09",
    through: "2026-02-09",
    days: 1
  });
  assert.equal(supplement.days["2026-02-09"].import.length, 96);
  assert.equal(supplement.days["2026-02-09"].export.length, 96);
  assert.equal(supplement.days["2026-02-09"].import[0], 0.03);
  assert.equal(supplement.days["2026-02-09"].export[0], 0.01);
  assert.doesNotMatch(JSON.stringify(supplement), /\b\d{18}\b/);
});

test("API conversion preserves Brussels daylight-saving day lengths", () => {
  const spring = buildGridSupplementFromApi(apiDay("2026-03-29T00:00:00+01:00", 92));
  const autumn = buildGridSupplementFromApi(apiDay("2026-10-25T00:00:00+02:00", 100));

  assert.equal(spring.days["2026-03-29"].import.length, 92);
  assert.equal(autumn.days["2026-10-25"].import.length, 100);
});

test("API conversion excludes incomplete days without publishing zeros", () => {
  const complete = apiDay("2026-02-09T00:00:00+01:00", 96);
  const incomplete = apiDay("2026-02-10T00:00:00+01:00", 96).slice(1);
  const supplement = buildGridSupplementFromApi([...incomplete, ...complete]);

  assert.deepEqual(Object.keys(supplement.days), ["2026-02-09"]);
  assert.equal(supplement.excluded.length, 1);
  assert.equal(supplement.excluded[0].date, "2026-02-10");
  assert.match(supplement.excluded[0].reason, /95 intervals; expected 96/);
  assert.equal(supplement.days["2026-02-10"], undefined);
});

function apiDay(start, intervals) {
  const startMs = new Date(start).getTime();
  return Array.from({ length: intervals }, (_, index) => {
    const intervalStart = new Date(startMs + index * 15 * 60 * 1_000);
    const intervalEnd = new Date(intervalStart.getTime() + 15 * 60 * 1_000);
    return {
      d: intervalStart.toISOString(),
      de: intervalEnd.toISOString(),
      v: [
        { dc: 1, t: 1, st: 0, v: 0.03, vs: 2, u: 3 },
        { dc: 1, t: 2, st: 0, v: 0.01, vs: 2, u: 3 }
      ]
    };
  });
}