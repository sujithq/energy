import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const QUARTER_HOUR_TIMES = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
});
const REQUIRED_HEADERS = [
  "Van (datum)",
  "Van (tijdstip)",
  "Register",
  "Volume",
  "Eenheid",
  "Validatiestatus"
];

const [, , inputPath, outputPath = "data/grid-supplement.json"] = process.argv;

if (!inputPath) {
  throw new Error("Usage: node scripts/build-grid-supplement.mjs <fluvius.csv> [output.json]");
}

const csv = await readFile(inputPath, "utf8");
const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
if (lines.length < 2) throw new Error("The Fluvius export contains no measurements.");

const headers = parseCsvLine(lines[0]);
const column = Object.fromEntries(headers.map((header, index) => [header, index]));
const missingHeaders = REQUIRED_HEADERS.filter((header) => column[header] == null);
if (missingHeaders.length) {
  throw new Error(`Missing required CSV columns: ${missingHeaders.join(", ")}`);
}

const grouped = new Map();

for (const [offset, line] of lines.slice(1).entries()) {
  const rowNumber = offset + 2;
  const values = parseCsvLine(line);
  const date = normalizeDate(values[column["Van (datum)"]], rowNumber);
  const time = normalizeTime(values[column["Van (tijdstip)"]], rowNumber);
  const register = values[column.Register]?.trim() || "";
  const direction = register.startsWith("Afname")
    ? "import"
    : register.startsWith("Injectie") ? "export" : null;

  if (!direction) throw new Error(`Unknown register at CSV row ${rowNumber}.`);
  if (values[column.Eenheid]?.trim() !== "kWh") {
    throw new Error(`Unexpected unit at CSV row ${rowNumber}. Expected kWh.`);
  }

  const status = values[column.Validatiestatus]?.trim() || "";
  const volumeText = values[column.Volume]?.trim() || "";
  const volume = status === "Uitgelezen" && volumeText
    ? Number(volumeText.replace(",", "."))
    : null;
  if (volume != null && (!Number.isFinite(volume) || volume < 0)) {
    throw new Error(`Invalid volume at CSV row ${rowNumber}.`);
  }

  if (!grouped.has(date)) grouped.set(date, new Map());
  const day = grouped.get(date);
  if (!day.has(time)) day.set(time, { import: [], export: [], statuses: new Set() });
  const interval = day.get(time);
  interval[direction].push(volume);
  interval.statuses.add(status);
}

const days = {};
const excluded = [];

for (const [date, intervals] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const times = [...intervals.keys()].sort();
  const problems = [];
  const expectedIntervalCount = expectedDailyIntervalCount(date);
  const intervalCount = sum(times.map((time) => {
    const interval = intervals.get(time);
    return Math.max(interval.import.length, interval.export.length);
  }));

  if (intervalCount !== expectedIntervalCount) {
    problems.push(`${intervalCount} intervals; expected ${expectedIntervalCount}`);
  }
  const cadenceMismatches = QUARTER_HOUR_TIMES.filter((time) => {
    const interval = intervals.get(time);
    const actual = interval ? Math.max(interval.import.length, interval.export.length) : 0;
    const expected = expectedOccurrences(time, expectedIntervalCount);
    return actual !== expected;
  });
  if (cadenceMismatches.length) {
    problems.push(`unexpected quarter-hour cadence at ${cadenceMismatches.slice(0, 4).join(", ")}`);
  }

  const imported = [];
  const exported = [];
  for (const time of QUARTER_HOUR_TIMES) {
    const expected = expectedOccurrences(time, expectedIntervalCount);
    const interval = intervals.get(time);
    if ((interval?.import.length || 0) !== expected || (interval?.export.length || 0) !== expected) {
      problems.push(`duplicate or missing direction at ${time}`);
    }
  }

  if (!problems.length) {
    for (const { time, occurrence } of expectedIntervalSlots(expectedIntervalCount)) {
      const interval = intervals.get(time);
      if (interval.import[occurrence] == null || interval.export[occurrence] == null) {
        problems.push("unread measurements");
        continue;
      }
      imported.push(interval.import[occurrence]);
      exported.push(interval.export[occurrence]);
    }
  }

  if (problems.length) {
    excluded.push({ date, reason: [...new Set(problems)].join("; ") });
    continue;
  }

  days[date] = { import: imported, export: exported };
}

const dates = Object.keys(days);
if (!dates.length) throw new Error("No complete Fluvius days were found.");

const supplement = {
  schemaVersion: 1,
  source: "Fluvius quarter-hour export",
  unit: "kWh",
  coverage: {
    from: dates[0],
    through: dates.at(-1),
    days: dates.length
  },
  excluded,
  days
};

const json = `${JSON.stringify(supplement, null, 2)}\n`;
if (/\d{18}/.test(json)) {
  throw new Error("The sanitized output unexpectedly contains a possible EAN identifier.");
}

await writeFile(outputPath, json, "utf8");
console.log(
  `Wrote ${dates.length} complete days (${dates[0]} through ${dates.at(-1)}) to ${path.normalize(outputPath)}.`,
  excluded.length ? `Excluded: ${excluded.map((item) => item.date).join(", ")}.` : ""
);

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function normalizeDate(value, rowNumber) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value || "");
  if (!match) throw new Error(`Invalid date at CSV row ${rowNumber}.`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function normalizeTime(value, rowNumber) {
  const match = /^(\d{2}):(\d{2}):00$/.exec(value || "");
  if (!match) throw new Error(`Invalid time at CSV row ${rowNumber}.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || ![0, 15, 30, 45].includes(minute)) {
    throw new Error(`Non-quarter-hour timestamp at CSV row ${rowNumber}.`);
  }
  return `${match[1]}:${match[2]}`;
}

function expectedOccurrences(time, intervalCount) {
  const repeatedHour = time.startsWith("02:");
  if (intervalCount === 92) return repeatedHour ? 0 : 1;
  if (intervalCount === 100) return repeatedHour ? 2 : 1;
  return 1;
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
  if (intervalCount === 100) {
    const beforeRepeatedHour = QUARTER_HOUR_TIMES
      .filter((time) => time < "02:00")
      .map((time) => ({ time, occurrence: 0 }));
    const repeatedHour = QUARTER_HOUR_TIMES.filter((time) => time.startsWith("02:"));
    const afterRepeatedHour = QUARTER_HOUR_TIMES
      .filter((time) => time > "02:45")
      .map((time) => ({ time, occurrence: 0 }));
    return [
      ...beforeRepeatedHour,
      ...repeatedHour.map((time) => ({ time, occurrence: 0 })),
      ...repeatedHour.map((time) => ({ time, occurrence: 1 })),
      ...afterRepeatedHour
    ];
  }

  return QUARTER_HOUR_TIMES
    .filter((time) => expectedOccurrences(time, intervalCount) === 1)
    .map((time) => ({ time, occurrence: 0 }));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}