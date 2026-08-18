const VALID_INTERVAL_COUNTS = new Set([92, 96, 100]);

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