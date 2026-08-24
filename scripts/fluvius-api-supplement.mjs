const BRUSSELS_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Brussels",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
const QUARTER_HOUR_TIMES = Array.from({ length: 96 }, (_, index) => {
  const hour = String(Math.floor(index / 4)).padStart(2, "0");
  const minute = String((index % 4) * 15).padStart(2, "0");
  return `${hour}:${minute}`;
});

export function buildGridSupplementFromApi(records) {
  if (!Array.isArray(records)) throw new Error("The Fluvius API response is not an array.");

  const grouped = new Map();
  for (const record of [...records].sort(compareRecordStart)) {
    const interval = parseInterval(record);
    if (!grouped.has(interval.date)) grouped.set(interval.date, []);
    grouped.get(interval.date).push(interval);
  }

  const days = {};
  const excluded = [];
  for (const [date, intervals] of grouped) {
    const expectedSlots = expectedIntervalSlots(expectedDailyIntervalCount(date));
    const actualSlots = intervals.map(({ time }) => time);
    const problems = [];

    if (actualSlots.length !== expectedSlots.length) {
      problems.push(`${actualSlots.length} intervals; expected ${expectedSlots.length}`);
    }
    if (actualSlots.some((time, index) => time !== expectedSlots[index])) {
      problems.push("unexpected quarter-hour cadence");
    }
    if (intervals.some(({ valid }) => !valid)) problems.push("unread measurements");

    if (problems.length) {
      excluded.push({ date, reason: [...new Set(problems)].join("; ") });
      continue;
    }

    days[date] = {
      import: intervals.map((interval) => interval.imported),
      export: intervals.map((interval) => interval.exported)
    };
  }

  const dates = Object.keys(days);
  if (!dates.length) throw new Error("No complete Fluvius API days were found.");

  return {
    schemaVersion: 1,
    source: "Fluvius quarter-hour API",
    unit: "kWh",
    coverage: {
      from: dates[0],
      through: dates.at(-1),
      days: dates.length
    },
    excluded,
    days
  };
}

function parseInterval(record) {
  const start = new Date(record?.d);
  const end = new Date(record?.de);
  const values = record?.v;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
      || end.getTime() - start.getTime() !== 15 * 60 * 1_000
      || !Array.isArray(values)) {
    throw new Error("The Fluvius API returned an invalid quarter-hour record.");
  }

  const parts = Object.fromEntries(
    BRUSSELS_TIME.formatToParts(start)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value])
  );
  const totals = { 1: 0, 2: 0 };
  const directions = new Set();
  let valid = values.length > 0;

  for (const reading of values) {
    const direction = Number(reading?.t);
    const volume = Number(reading?.v);
    if (![1, 2].includes(direction) || Number(reading?.u) !== 3
        || Number(reading?.vs) !== 2 || !Number.isFinite(volume) || volume < 0) {
      valid = false;
      continue;
    }
    totals[direction] += volume;
    directions.add(direction);
  }

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    imported: totals[1],
    exported: totals[2],
    valid: valid && directions.has(1) && directions.has(2)
  };
}

function expectedDailyIntervalCount(date) {
  const [year, month, day] = date.split("-").map(Number);
  if (month === 3 && day === lastSundayOfMonth(year, 3)) return 92;
  if (month === 10 && day === lastSundayOfMonth(year, 10)) return 100;
  return 96;
}

function lastSundayOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0));
  return lastDay.getUTCDate() - lastDay.getUTCDay();
}

function expectedIntervalSlots(intervalCount) {
  if (intervalCount === 92) return QUARTER_HOUR_TIMES.filter((time) => !time.startsWith("02:"));
  if (intervalCount === 100) {
    const repeatedHour = QUARTER_HOUR_TIMES.filter((time) => time.startsWith("02:"));
    return [
      ...QUARTER_HOUR_TIMES.filter((time) => time < "02:00"),
      ...repeatedHour,
      ...repeatedHour,
      ...QUARTER_HOUR_TIMES.filter((time) => time > "02:45")
    ];
  }
  return QUARTER_HOUR_TIMES;
}

function compareRecordStart(left, right) {
  const leftTime = new Date(left?.d).getTime();
  const rightTime = new Date(right?.d).getTime();
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left?.d).localeCompare(String(right?.d));
}