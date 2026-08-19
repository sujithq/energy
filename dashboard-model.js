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
const GRID_CLOCK_BALANCE_EPSILON_KWH = 0.02;

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

export function buildGridDependencyClock(rows) {
  const profiles = rows
    .filter((record) => record.gridIntervalsComplete)
    .map((record) => ({
      iso: record.iso,
      import: canonicalizeDaySeries(record.intervals.import),
      export: canonicalizeDaySeries(record.intervals.export)
    }))
    .filter((profile) => profile.import && profile.export);
  const hours = Array.from({ length: 24 }, (_, hour) => buildGridClockHour(profiles, hour));

  return {
    sampleDays: profiles.length,
    latestIso: latestIso(profiles.map((profile) => profile.iso)),
    hours,
    peakImport: peakClockHour(hours, "import"),
    peakExport: peakClockHour(hours, "export")
  };
}

export function buildGridPeakTimingHeatmap(groups, metric) {
  const stream = metric === "export" ? "export" : "import";
  const rows = groups.map((group) => {
    const cells = Array(24).fill(0);
    let sampleDays = 0;
    let peakDays = 0;
    group.rows.filter((record) => record.gridIntervalsComplete).forEach((record) => {
      const profile = canonicalizeDaySeries(record.intervals[stream]);
      if (!profile) return;
      sampleDays += 1;
      const peaks = peakHourWeights(profile);
      if (!peaks.length) return;
      peakDays += 1;
      peaks.forEach(({ hour, weight }) => { cells[hour] += weight; });
    });
    return {
      month: group.month,
      sampleDays,
      peakDays,
      cells: cells.map((weight, hour) => ({
        hour,
        weight,
        share: peakDays ? (weight / peakDays) * 100 : 0
      }))
    };
  });
  const peak = rows.flatMap((row) => row.cells.map((cell) => ({
    month: row.month,
    ...cell
  }))).filter((cell) => cell.weight > 0)
    .sort((left, right) => right.share - left.share || left.hour - right.hour)[0] || null;

  return {
    metric: stream,
    rows,
    sampleDays: rows.reduce((total, row) => total + row.sampleDays, 0),
    peakDays: rows.reduce((total, row) => total + row.peakDays, 0),
    latestIso: latestIso(groups.flatMap((group) => group.rows
      .filter((record) => record.gridIntervalsComplete)
      .map((record) => record.iso))),
    maxShare: peak?.share || 0,
    peak
  };
}

export function buildOvernightGridReliance(groups) {
  const normalizedGroups = groups.map((group) => buildOvernightGroup(group));
  const profiles = normalizedGroups.flatMap((group) => group.profiles);
  const hourlyMedians = profiles.length
    ? Array.from({ length: 6 }, (_, hour) => median(profiles.map((profile) => profile.hours[hour])))
    : Array(6).fill(null);
  const totalOvernight = sum(profiles.map((profile) => profile.overnightImport));
  const normalizedDayImport = sum(profiles.map((profile) => profile.normalizedDayImport));

  return {
    groups: normalizedGroups.map(({ profiles, ...group }) => group),
    sampleDays: profiles.length,
    excludedProfileDays: normalizedGroups.reduce((total, group) => total + group.excludedProfileDays, 0),
    latestIso: latestIso(profiles.map((profile) => profile.iso)),
    totalOvernight,
    medianOvernight: profiles.length ? median(profiles.map((profile) => profile.overnightImport)) : null,
    overnightShare: normalizedDayImport > 0 ? (totalOvernight / normalizedDayImport) * 100 : null,
    hourlyMedians
  };
}

export function buildGoodSolarDayScorecard(rows) {
  const qualifyingRows = rows.filter((record) => (
    record.hasGrid === true
    && isPositiveFinite(record.production)
    && isNonNegativeFinite(record.selfUsedSolar)
    && isNonNegativeFinite(record.gridExport)
    && isPositiveFinite(record.householdUse)
  ));
  const productionValues = qualifyingRows.map((record) => record.production);
  const days = qualifyingRows.map((record) => {
    const selfConsumption = (record.selfUsedSolar / record.production) * 100;
    const selfSufficiency = (record.selfUsedSolar / record.householdUse) * 100;
    const productionPercentile = percentileRank(productionValues, record.production);
    const score = (productionPercentile * 0.3) + (selfSufficiency * 0.4) + (selfConsumption * 0.3);
    return {
      iso: record.iso,
      production: record.production,
      selfUsedSolar: record.selfUsedSolar,
      householdUse: record.householdUse,
      gridExport: record.gridExport,
      selfConsumption,
      selfSufficiency,
      productionPercentile,
      score
    };
  }).sort((left, right) => (
    right.score - left.score
    || right.production - left.production
    || right.selfUsedSolar - left.selfUsedSolar
    || left.iso.localeCompare(right.iso)
  ));

  return {
    qualifyingDays: days.length,
    latestIso: latestIso(days.map((day) => day.iso)),
    topDays: days.slice(0, 3),
    scoreWeights: { production: 30, selfSufficiency: 40, selfConsumption: 30 }
  };
}

export function buildDailyRangeDistribution(groups, metric) {
  const rows = groups.map((group) => {
    const values = group.rows
      .map((record) => distributionMetricValue(record, metric))
      .filter(isNonNegativeFinite);
    return {
      month: group.month,
      sampleDays: values.length,
      minimum: values.length ? quantile(values, 0) : null,
      lowerQuartile: values.length ? quantile(values, 0.25) : null,
      median: values.length ? quantile(values, 0.5) : null,
      upperQuartile: values.length ? quantile(values, 0.75) : null,
      upperDecile: values.length ? quantile(values, 0.9) : null,
      maximum: values.length ? quantile(values, 1) : null
    };
  });
  const values = rows.flatMap((row) => [row.upperDecile, row.maximum].filter(isNonNegativeFinite));

  return {
    metric,
    rows,
    sampleDays: rows.reduce((total, row) => total + row.sampleDays, 0),
    maxValue: values.length ? Math.max(...values) : 0
  };
}

export function buildWeatherAdjustedSolar(rows, metric) {
  const weatherField = metric === "temperature" ? "tavg" : "prcp";
  const points = rows.map((record) => {
    const weatherValue = weatherMetricValue(record.weather, weatherField);
    const daylightHours = daylightDurationHours(record.iso, record.sunrise, record.sunset);
    if (!record.weatherFinal || !isNonNegativeFinite(record.production) || weatherValue == null
        || daylightHours == null || daylightHours <= 0) return null;
    return {
      iso: record.iso,
      weatherValue,
      daylightHours,
      solarPerDaylightHour: record.production / daylightHours,
      production: record.production
    };
  }).filter(Boolean).sort((left, right) => left.iso.localeCompare(right.iso));

  return {
    metric: weatherField === "tavg" ? "temperature" : "precipitation",
    points,
    sampleDays: points.length,
    latestIso: latestIso(points.map((point) => point.iso)),
    correlation: pearsonCorrelation(points.map((point) => point.weatherValue), points.map((point) => point.solarPerDaylightHour))
  };
}

function weatherMetricValue(weather, field) {
  const value = weather?.[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return field === "prcp" && value < 0 ? null : value;
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

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function buildGridClockHour(profiles, hour) {
  const measurements = profiles.map((profile) => ({
    import: sumHour(profile.import, hour),
    export: sumHour(profile.export, hour)
  })).filter(({ import: imported, export: exported }) => (
    Number.isFinite(imported) && Number.isFinite(exported)
  ));
  const counts = { import: 0, export: 0, balanced: 0 };
  measurements.forEach(({ import: imported, export: exported }) => {
    const net = imported - exported;
    if (net > GRID_CLOCK_BALANCE_EPSILON_KWH) counts.import += 1;
    else if (net < -GRID_CLOCK_BALANCE_EPSILON_KWH) counts.export += 1;
    else counts.balanced += 1;
  });
  const samples = measurements.length;
  return {
    hour,
    samples,
    importDays: counts.import,
    exportDays: counts.export,
    balancedDays: counts.balanced,
    importShare: samples ? (counts.import / samples) * 100 : 0,
    exportShare: samples ? (counts.export / samples) * 100 : 0,
    balancedShare: samples ? (counts.balanced / samples) * 100 : 0,
    medianImport: samples ? median(measurements.map((measurement) => measurement.import)) : null,
    medianExport: samples ? median(measurements.map((measurement) => measurement.export)) : null,
    state: gridClockState(counts, samples)
  };
}

function sumHour(values, hour) {
  const hourlyValues = values.slice(hour * 4, hour * 4 + 4);
  return hourlyValues.length === 4 && hourlyValues.every(Number.isFinite) ? sum(hourlyValues) : null;
}

function gridClockState(counts, samples) {
  if (!samples) return "unavailable";
  if (counts.import > counts.export && counts.import > counts.balanced) return "import";
  if (counts.export > counts.import && counts.export > counts.balanced) return "export";
  return "balanced";
}

function peakClockHour(hours, direction) {
  const property = direction === "import" ? "importShare" : "exportShare";
  return [...hours]
    .filter((hour) => hour.samples)
    .sort((left, right) => right[property] - left[property] || left.hour - right.hour)[0] || null;
}

function peakHourWeights(profile) {
  const hourlyValues = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    value: sumHour(profile, hour)
  })).filter(({ value }) => Number.isFinite(value));
  const maximum = Math.max(...hourlyValues.map(({ value }) => value), 0);
  if (maximum <= 0) return [];
  const peakHours = hourlyValues.filter(({ value }) => Math.abs(value - maximum) < 1e-9);
  return peakHours.map(({ hour }) => ({ hour, weight: 1 / peakHours.length }));
}

function percentileRank(values, value) {
  if (values.length <= 1) return 100;
  const less = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return ((less + ((equal - 1) / 2)) / (values.length - 1)) * 100;
}

function buildOvernightGroup(group) {
  const completeRows = group.rows.filter((record) => record.gridIntervalsComplete);
  const profiles = completeRows.map((record) => {
    const importProfile = canonicalizeDaySeries(record.intervals.import);
    if (!importProfile) return null;
    const hours = Array.from({ length: 6 }, (_, hour) => sumHour(importProfile, hour));
    if (hours.some((value) => !Number.isFinite(value))) return null;
    return {
      iso: record.iso,
      hours,
      overnightImport: sum(hours),
      normalizedDayImport: sum(importProfile)
    };
  }).filter(Boolean);
  const totalOvernight = sum(profiles.map((profile) => profile.overnightImport));
  const normalizedDayImport = sum(profiles.map((profile) => profile.normalizedDayImport));

  return {
    month: group.month,
    sampleDays: profiles.length,
    excludedProfileDays: completeRows.length - profiles.length,
    totalOvernight,
    medianOvernight: profiles.length ? median(profiles.map((profile) => profile.overnightImport)) : null,
    overnightShare: normalizedDayImport > 0 ? (totalOvernight / normalizedDayImport) * 100 : null,
    hourlyMedians: profiles.length
      ? Array.from({ length: 6 }, (_, hour) => median(profiles.map((profile) => profile.hours[hour])))
      : Array(6).fill(null),
    profiles
  };
}

function distributionMetricValue(record, metric) {
  if (metric === "production") return record.production;
  if (metric === "householdUse") return record.hasGrid ? record.householdUse : null;
  if (metric === "gridImport") return record.hasGrid ? record.gridImport : null;
  if (metric === "gridExport") return record.hasGrid ? record.gridExport : null;
  return null;
}

function quantile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function daylightDurationHours(iso, sunrise, sunset) {
  if (!isSameDateIsoTimestamp(sunrise, iso) || !isSameDateIsoTimestamp(sunset, iso)) return null;
  const start = Date.parse(sunrise);
  const end = Date.parse(sunset);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? (end - start) / 3_600_000
    : null;
}

function isSameDateIsoTimestamp(value, iso) {
  if (!parseIsoDate(iso) || typeof value !== "string") return false;
  const escapedIso = iso.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedIso}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$`);
  return pattern.test(value) && Number.isFinite(Date.parse(value));
}

function pearsonCorrelation(left, right) {
  if (left.length < 3 || left.length !== right.length) return null;
  const leftMean = sum(left) / left.length;
  const rightMean = sum(right) / right.length;
  const numerator = left.reduce((total, value, index) => total + ((value - leftMean) * (right[index] - rightMean)), 0);
  const leftVariance = sum(left.map((value) => (value - leftMean) ** 2));
  const rightVariance = sum(right.map((value) => (value - rightMean) ** 2));
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? numerator / denominator : null;
}