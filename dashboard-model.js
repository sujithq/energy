const VALID_INTERVAL_COUNTS = new Set([92, 96, 100]);
export const DAILY_ARCHETYPE_MIN_REFERENCE_DAYS = 8;
const DAILY_ARCHETYPE_MIN_DIRECTIONAL_DAYS = 4;
export const DAILY_ARCHETYPE_ORDER = Object.freeze([
  "anomaly",
  "highUse",
  "solarSurplus",
  "gridHeavy",
  "typical",
  "incomplete"
]);
export const SOURCE_TIMELINE_SOURCE_ORDER = Object.freeze(["solar", "grid", "weather"]);

export function buildSurplusHeatmap(groups) {
  const rows = groups.map((group) => {
    const profileRows = group.rows
      .filter((record) => record.gridIntervalsComplete)
      .map((record) => ({ record, profile: hourlyExportProfile(record) }))
      .filter(({ profile }) => profile);
    const profiles = profileRows.map(({ profile }) => profile);
    const cells = Array.from({ length: 24 }, (_, hour) => {
      const values = profiles.map((profile) => profile[hour]).filter(Number.isFinite);
      return {
        value: values.length ? median(values) : null,
        samples: values.length
      };
    });
    return {
      month: group.month,
      sampleDays: profiles.length,
      latestIso: latestIso(profileRows.map(({ record }) => record.iso)),
      cells
    };
  });
  const values = rows.flatMap((row) => row.cells.map((cell) => cell.value).filter(Number.isFinite));
  const peak = rows.flatMap((row) => row.cells.map((cell, hour) => ({
    month: row.month,
    hour,
    value: cell.value
  }))).filter((cell) => Number.isFinite(cell.value)).sort((left, right) => right.value - left.value)[0] || null;

  return {
    rows,
    sampleDays: rows.reduce((total, row) => total + row.sampleDays, 0),
    latestIso: latestIso(rows.map((row) => row.latestIso)),
    maxValue: values.length ? Math.max(...values) : 0,
    peak
  };
}

export function buildDailyArchetypes(rows) {
  const completeRows = rows.filter(hasCompleteDailyBalance);
  const referenceRows = completeRows.filter((record) => !record.anomaly);
  const hasSufficientReferenceDays = referenceRows.length >= DAILY_ARCHETYPE_MIN_REFERENCE_DAYS;
  const ranks = hasSufficientReferenceDays
    ? {
      highUse: upperQuartileIsoSet(referenceRows, "householdUse", DAILY_ARCHETYPE_MIN_REFERENCE_DAYS),
      solarSurplus: upperQuartileIsoSet(
        referenceRows.filter((record) => record.gridExport > record.gridImport),
        "gridExport",
        DAILY_ARCHETYPE_MIN_DIRECTIONAL_DAYS
      ),
      gridHeavy: upperQuartileIsoSet(
        referenceRows.filter((record) => record.gridImport > record.gridExport),
        "gridImport",
        DAILY_ARCHETYPE_MIN_DIRECTIONAL_DAYS
      )
    }
    : emptyArchetypeRanks();
  const days = rows.map((record) => {
    const gridIncomplete = !hasCompleteDailyBalance(record);
    return {
      iso: record.iso,
      month: record.month,
      day: record.day,
      gridIncomplete,
      category: classifyDailyArchetype(record, ranks)
    };
  });
  const counts = Object.fromEntries(DAILY_ARCHETYPE_ORDER.map((category) => [category, 0]));
  days.forEach((day) => { counts[day.category] += 1; });

  return {
    days,
    counts,
    completeDays: completeRows.length,
    referenceDays: referenceRows.length,
    hasSufficientReferenceDays,
    incompleteDays: days.filter((day) => day.gridIncomplete).length,
    latestGridIso: latestIso(completeRows.map((record) => record.iso)),
    thresholds: null
  };
}

export function buildEnergyUtilizationFunnel({
  selfUsedSolar,
  commonGridExport,
  commonGridImport
} = {}) {
  const values = [selfUsedSolar, commonGridExport, commonGridImport];
  if (!values.every(isNonNegativeFinite)) return null;

  const solarTotal = selfUsedSolar + commonGridExport;
  const householdDemand = selfUsedSolar + commonGridImport;
  return {
    solar: splitEnergy(solarTotal, selfUsedSolar, commonGridExport),
    household: splitEnergy(householdDemand, selfUsedSolar, commonGridImport)
  };
}

export function buildSourceCoverageTimeline(rows, bounds = {}) {
  const allRows = [...rows].sort((left, right) => left.iso.localeCompare(right.iso));
  const { periodStartIso, periodEndIso } = resolveTimelineBounds(allRows, bounds);
  const orderedRows = allRows.filter((record) => (
    (!periodStartIso || record.iso >= periodStartIso)
    && (!periodEndIso || record.iso <= periodEndIso)
  ));
  const firstIso = orderedRows[0]?.iso || null;
  const lastIso = orderedRows.at(-1)?.iso || null;
  const sources = [
    { id: "solar", label: "Solar", resolve: sourceSolarState },
    { id: "grid", label: "Grid", resolve: sourceGridState },
    { id: "weather", label: "Weather", resolve: sourceWeatherState }
  ].map((source) => ({
    id: source.id,
    label: source.label,
    segments: mergeSourceSegments(orderedRows, source.resolve, periodStartIso)
  }));

  return {
    days: orderedRows.length,
    daySpan: periodStartIso && periodEndIso ? dateOffset(periodStartIso, periodEndIso) + 1 : 0,
    periodStartIso,
    periodEndIso,
    firstIso,
    lastIso,
    sources
  };
}

export function normalizePeriodAnchor(records, anchor, view) {
  if (!records.length) return anchor;
  if (records.some((record) => record.iso === anchor)) return anchor;
  const target = parseIsoDate(anchor);
  if (!target) return records.at(-1).iso;

  const year = target.getUTCFullYear();
  const month = target.getUTCMonth() + 1;
  const scopedRecords = view === "year"
    ? records.filter((record) => record.year === year)
    : view === "month"
      ? records.filter((record) => record.year === year && record.month === month)
      : records;
  return closestRecord(scopedRecords.length ? scopedRecords : records, target).iso;
}

export function canonicalizeDaySeries(values) {
  if (!VALID_INTERVAL_COUNTS.has(values.length)) return null;
  if (values.length === 92) return alignIntervalSeries(values, 96);
  if (values.length === 100) {
    const repeatedHour = Array.from({ length: 4 }, (_, index) => (
      (values[8 + index] + values[12 + index]) / 2
    ));
    return [...values.slice(0, 8), ...repeatedHour, ...values.slice(16)];
  }
  return [...values];
}

export function formatHourRange(hour) {
  return `${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00`;
}

function hourlyExportProfile(record) {
  const canonicalProfile = canonicalizeDaySeries(record.intervals.export);
  if (!canonicalProfile) return null;

  return Array.from({ length: 24 }, (_, hour) => {
    const hourlyIntervals = canonicalProfile.slice(hour * 4, hour * 4 + 4);
    return hourlyIntervals.every(Number.isFinite) ? sum(hourlyIntervals) : null;
  });
}

function alignIntervalSeries(values, targetCount) {
  if (values.length === targetCount) return [...values];
  if (values.length === 92 && targetCount === 96) {
    return [...values.slice(0, 8), ...Array(4).fill(null), ...values.slice(8)];
  }
  return Array.from({ length: targetCount }, (_, index) => values[index] ?? null);
}

function closestRecord(records, target) {
  const targetTime = target.getTime();
  return records.reduce((closest, record) => {
    const distance = Math.abs(isoToTime(record.iso) - targetTime);
    const closestDistance = Math.abs(isoToTime(closest.iso) - targetTime);
    if (distance < closestDistance || (distance === closestDistance && record.iso < closest.iso)) {
      return record;
    }
    return closest;
  });
}

function parseIsoDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? date
    : null;
}

function latestIso(dates) {
  return dates.filter((iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso || "")).sort().at(-1) || null;
}

function isoToTime(iso) {
  return Date.parse(`${iso}T12:00:00Z`);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function hasCompleteDailyBalance(record) {
  return record.hasGrid === true
    && [record.householdUse, record.gridImport, record.gridExport].every(Number.isFinite);
}

function classifyDailyArchetype(record, ranks) {
  if (record.anomaly) return "anomaly";
  if (!hasCompleteDailyBalance(record)) return "incomplete";
  if (ranks.highUse.has(record.iso)) return "highUse";
  if (ranks.solarSurplus.has(record.iso)) return "solarSurplus";
  if (ranks.gridHeavy.has(record.iso)) return "gridHeavy";
  return "typical";
}

function emptyArchetypeRanks() {
  return {
    highUse: new Set(),
    solarSurplus: new Set(),
    gridHeavy: new Set()
  };
}

function upperQuartileIsoSet(records, valueName, minimumDays) {
  if (records.length < minimumDays) return new Set();
  const topCount = Math.ceil(records.length / 4);
  return new Set([...records]
    .sort((left, right) => right[valueName] - left[valueName] || left.iso.localeCompare(right.iso))
    .slice(0, topCount)
    .map((record) => record.iso));
}

function splitEnergy(total, first, second) {
  return {
    total,
    first,
    second,
    firstShare: total > 0 ? (first / total) * 100 : 0,
    secondShare: total > 0 ? (second / total) * 100 : 0
  };
}

function mergeSourceSegments(rows, resolveState, firstIso) {
  const segments = [];
  rows.forEach((record, index) => {
    const state = resolveState(record);
    const previous = segments.at(-1);
    if (previous && previous.state === state && datesAreAdjacent(previous.endIso, record.iso)) {
      previous.endIso = record.iso;
      previous.length += 1;
      return;
    }
    segments.push({
      state,
      startIndex: index,
      startOffset: dateOffset(firstIso, record.iso),
      length: 1,
      startIso: record.iso,
      endIso: record.iso
    });
  });
  return segments;
}

function resolveTimelineBounds(rows, bounds) {
  const requestedStart = parseIsoDate(bounds.startIso) ? bounds.startIso : null;
  const requestedEnd = parseIsoDate(bounds.endIso) ? bounds.endIso : null;
  if (requestedStart && requestedEnd && requestedStart <= requestedEnd) {
    return { periodStartIso: requestedStart, periodEndIso: requestedEnd };
  }
  return {
    periodStartIso: rows[0]?.iso || null,
    periodEndIso: rows.at(-1)?.iso || null
  };
}

function sourceSolarState(record) {
  return record.solarFinal ? "final" : "provisional";
}

function sourceGridState(record) {
  if (!record.hasGrid) return "unavailable";
  if (record.supplementedGrid) return "fluvius";
  if (record.gridIntervalsComplete) return "intervals";
  if (record.gridFinal) return "daily";
  return "unavailable";
}

function sourceWeatherState(record) {
  if (record.weatherFinal) return "final";
  return record.weather && Object.keys(record.weather).length ? "provisional" : "unavailable";
}

function datesAreAdjacent(previousIso, currentIso) {
  return dateOffset(previousIso, currentIso) === 1;
}

function dateOffset(startIso, endIso) {
  const start = Date.parse(`${startIso}T12:00:00Z`);
  const end = Date.parse(`${endIso}T12:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86_400_000) : 0;
}

function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}