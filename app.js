import {
  DAILY_ARCHETYPE_MIN_REFERENCE_DAYS,
  DAILY_ARCHETYPE_ORDER,
  SOURCE_TIMELINE_SOURCE_ORDER,
  buildDailyArchetypes,
  buildEnergyUtilizationFunnel,
  buildGridDependencyClock,
  buildGridPeakTimingHeatmap,
  buildOvernightGridReliance,
  buildSourceCoverageTimeline,
  buildSurplusHeatmap,
  formatHourRange,
  normalizePeriodAnchor
} from "./dashboard-model.js";

const DATA_URL = "https://raw.githubusercontent.com/sujithq/myenergy/refs/heads/main/src/myenergy/wwwroot/Data/data.json";
const GRID_SUPPLEMENT_URL = "data/grid-supplement.json";
const VALID_INTERVAL_COUNTS = new Set([92, 96, 100]);
const VIEW_TYPES = new Set(["day", "month", "year"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const DAILY_ARCHETYPES = Object.freeze({
  anomaly: {
    label: "Flagged anomaly",
    description: "The source marked this day as unusual, so it overrides the other pattern labels.",
    icon: "triangle-alert",
    marker: "!",
    tone: "anomaly"
  },
  highUse: {
    label: "High household use",
    description: "Household use was in the upper quarter of complete days in this selection.",
    icon: "house-plug",
    marker: "H",
    tone: "high-use"
  },
  solarSurplus: {
    label: "Solar surplus",
    description: "Grid export was in the upper quarter and exceeded grid import.",
    icon: "sun",
    marker: "S",
    tone: "solar-surplus"
  },
  gridHeavy: {
    label: "Grid-heavy",
    description: "Grid import was in the upper quarter and exceeded grid export.",
    icon: "arrow-down-to-line",
    marker: "G",
    tone: "grid-heavy"
  },
  typical: {
    label: "Typical mix",
    description: "No high or flagged grid pattern was observed relative to this selection.",
    icon: "activity",
    marker: "T",
    tone: "typical"
  },
  incomplete: {
    label: "Grid incomplete",
    description: "Grid data was not complete enough to classify this day. This coverage marker can overlap an anomaly flag.",
    icon: "cloud-off",
    marker: "?",
    tone: "incomplete"
  }
});
const SOURCE_TIMELINE_SOURCES = Object.freeze({
  solar: { icon: "sun" },
  grid: { icon: "utility-pole" },
  weather: { icon: "cloud-sun" }
});
const SOURCE_TIMELINE_STATES = Object.freeze({
  solar: {
    final: { label: "Solar final", tone: "solar-final" },
    provisional: { label: "Solar provisional", tone: "solar-provisional" }
  },
  grid: {
    intervals: { label: "Interval grid", tone: "grid-intervals" },
    fluvius: { label: "Fluvius intervals", tone: "grid-fluvius" },
    daily: { label: "Daily grid", tone: "grid-daily" },
    unavailable: { label: "Grid unavailable", tone: "grid-unavailable" }
  },
  weather: {
    final: { label: "Weather final", tone: "weather-final" },
    provisional: { label: "Weather provisional", tone: "weather-provisional" },
    unavailable: { label: "Weather unavailable", tone: "weather-unavailable" }
  }
});
const GRID_CLOCK_STATES = Object.freeze({
  import: { label: "Import-dominant", marker: "I", tone: "import" },
  export: { label: "Export-dominant", marker: "E", tone: "export" },
  balanced: { label: "Mixed / balanced", marker: "=", tone: "balanced" },
  unavailable: { label: "No complete profile", marker: "-", tone: "unavailable" }
});

const state = {
  records: [],
  byDate: new Map(),
  view: "year",
  anchor: "",
  energyChart: null,
  archetypeFilter: "all",
  sourceTimelineSource: "grid",
  gridClockHour: null,
  peakTimingMetric: "import",
  peakTimingCell: null,
  overnightHour: 0,
  loadError: null,
  loadedAt: null
};

const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  setLoading(true);

  try {
    ensureDependencies();
    const [raw, gridSupplement] = await Promise.all([
      fetchEnergyData(),
      fetchGridSupplement()
    ]);
    state.records = normalizeData(raw, gridSupplement.days);
    state.byDate = new Map(state.records.map((record) => [record.iso, record]));
    state.loadedAt = new Date();
    initializeSelection();
    configureControls();
    configureCharts();
    render();
  } catch (error) {
    console.error(error);
    state.loadError = error;
    showLoadError(error);
  } finally {
    setLoading(false);
  }
}

function cacheElements() {
  const ids = [
    "app", "loadingState", "errorState", "errorMessage", "retryButton",
    "dataStatus", "freshnessStatus", "viewSwitch", "dateControl", "monthControl",
    "yearControl", "dateInput", "monthInput", "yearSelect", "previousPeriod",
    "nextPeriod", "latestPeriod", "periodEyebrow", "periodTitle", "periodSubtitle",
    "coverageNotice", "coverageText", "solarWindowTitle", "solarWindowTime",
    "solarWindowCopy", "solarTrack", "daylightBand", "bestWindowBand", "sunriseLabel",
    "sunsetLabel", "kpiGrid", "energyChart", "chartTitle", "chartSubtitle",
    "flowTitle", "flowSubtitle", "flowDiagram", "insightGrid", "calendarSection",
    "calendarTitle", "calendarMetric", "calendarGrid", "rankingSection", "rankingList",
    "sourceTimelineTitle", "sourceTimelineSubtitle", "sourceTimelineLegend", "sourceTimelineSelection",
    "sourceTimeline",
    "gridClockTitle", "gridClockSubtitle", "gridClockLegend", "gridClock",
    "peakTimingSection", "peakTimingTitle", "peakTimingSubtitle", "peakTimingControls",
    "peakTimingLegend", "peakTimingReadout", "peakTiming",
    "overnightTitle", "overnightSubtitle", "overnightSummary", "overnightProfile",
    "overnightReadout", "overnightMonths",
    "dailyArchetypeSection", "dailyArchetypeTitle", "dailyArchetypeSubtitle",
    "dailyArchetypeSummary", "dailyArchetypeFilters", "dailyArchetypeTimeline",
    "surplusHeatmapSection", "surplusHeatmapTitle", "surplusHeatmapSubtitle",
    "surplusHeatmapLegend", "surplusHeatmapMax", "surplusHeatmapSelection", "surplusHeatmap",
    "dayDetailSection", "dayDetailTitle", "dayDetailMeta", "dayFacts", "dayQuality",
    "healthSummary", "healthList", "sourceLink", "lastUpdated"
  ];

  ids.forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function bindEvents() {
  elements.viewSwitch.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || !VIEW_TYPES.has(button.dataset.view)) return;
    state.view = button.dataset.view;
    render();
  });

  elements.dateInput.addEventListener("change", () => {
    if (elements.dateInput.value) {
      state.anchor = elements.dateInput.value;
      render();
    }
  });

  elements.monthInput.addEventListener("change", () => {
    if (elements.monthInput.value) {
      state.anchor = `${elements.monthInput.value}-01`;
      render();
    }
  });

  elements.yearSelect.addEventListener("change", () => {
    const year = Number(elements.yearSelect.value);
    if (Number.isFinite(year)) {
      state.anchor = latestRecordForYear(year)?.iso || `${year}-01-01`;
      render();
    }
  });

  elements.previousPeriod.addEventListener("click", () => shiftPeriod(-1));
  elements.nextPeriod.addEventListener("click", () => shiftPeriod(1));
  elements.latestPeriod.addEventListener("click", goToLatest);
  elements.retryButton.addEventListener("click", () => window.location.reload());
  elements.calendarMetric.addEventListener("change", () => renderCalendar(getPeriodRows()));

  elements.calendarGrid.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-date]");
    if (button) openDay(button.dataset.date);
  });

  elements.rankingList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-date]");
    if (button) openDay(button.dataset.date);
  });

  elements.dailyArchetypeFilters.addEventListener("click", (event) => {
    const filter = event.target.closest("button[data-archetype-filter]");
    if (!filter) return;
    state.archetypeFilter = filter.dataset.archetypeFilter;
    renderDailyArchetypes(getPeriodRows(), state.archetypeFilter);
    if (window.lucide) window.lucide.createIcons();
  });

  elements.dailyArchetypeTimeline.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-date]");
    if (button) openDay(button.dataset.date, { focusDayDetail: true });
  });

  elements.sourceTimeline.addEventListener("click", (event) => {
    const source = event.target.closest("button[data-source-timeline-source]");
    if (!source) return;
    selectSourceTimelineSource(source.dataset.sourceTimelineSource);
  });

  elements.sourceTimeline.addEventListener("keydown", (event) => {
    const source = event.target.closest("button[data-source-timeline-source]");
    if (!source) return;
    const sourceIds = SOURCE_TIMELINE_SOURCE_ORDER.filter((id) => (
      elements.sourceTimeline.querySelector(`[data-source-timeline-source="${id}"]`)
    ));
    const currentIndex = sourceIds.indexOf(source.dataset.sourceTimelineSource);
    const keyOffsets = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    let nextIndex;
    if (event.key in keyOffsets) {
      nextIndex = (currentIndex + keyOffsets[event.key] + sourceIds.length) % sourceIds.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = sourceIds.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    selectSourceTimelineSource(sourceIds[nextIndex]);
  });

  elements.gridClock.addEventListener("click", (event) => {
    const hour = event.target.closest("button[data-grid-clock-hour]");
    if (hour) selectGridClockHour(Number(hour.dataset.gridClockHour), hour);
  });

  elements.gridClock.addEventListener("focusin", (event) => {
    const hour = event.target.closest("button[data-grid-clock-hour]");
    if (hour) selectGridClockHour(Number(hour.dataset.gridClockHour), hour);
  });

  elements.gridClock.addEventListener("keydown", (event) => {
    const hour = event.target.closest("button[data-grid-clock-hour]");
    if (!hour) return;
    const availableHours = [...elements.gridClock.querySelectorAll("button[data-grid-clock-hour]:not(:disabled)")]
      .map((button) => Number(button.dataset.gridClockHour));
    const currentHour = Number(hour.dataset.gridClockHour);
    const keyOffsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -6, ArrowDown: 6 };
    let nextHour;
    if (event.key in keyOffsets) {
      nextHour = nextAvailableGridClockHour(currentHour, keyOffsets[event.key], availableHours);
    } else if (event.key === "Home") {
      nextHour = availableHours.at(0);
    } else if (event.key === "End") {
      nextHour = availableHours.at(-1);
    } else {
      return;
    }
    event.preventDefault();
    const nextButton = elements.gridClock.querySelector(`[data-grid-clock-hour="${nextHour}"]`);
    selectGridClockHour(nextHour, nextButton);
    nextButton?.focus();
  });

  elements.peakTimingControls.addEventListener("click", (event) => {
    const metric = event.target.closest("button[data-peak-timing-metric]");
    if (metric) selectPeakTimingMetric(metric.dataset.peakTimingMetric);
  });

  elements.peakTimingControls.addEventListener("keydown", (event) => {
    const metric = event.target.closest("button[data-peak-timing-metric]");
    if (!metric) return;
    const metrics = ["import", "export"];
    const currentIndex = metrics.indexOf(metric.dataset.peakTimingMetric);
    let nextIndex;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + metrics.length) % metrics.length;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % metrics.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = metrics.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    selectPeakTimingMetric(metrics[nextIndex]);
  });

  elements.peakTiming.addEventListener("click", (event) => {
    const cell = event.target.closest("button[data-peak-timing-month]");
    if (cell) selectPeakTimingCell(cell);
  });

  elements.peakTiming.addEventListener("focusin", (event) => {
    const cell = event.target.closest("button[data-peak-timing-month]");
    if (cell) selectPeakTimingCell(cell);
  });

  elements.overnightProfile.addEventListener("click", (event) => {
    const hour = event.target.closest("button[data-overnight-hour]");
    if (hour) selectOvernightHour(hour);
  });

  elements.overnightProfile.addEventListener("focusin", (event) => {
    const hour = event.target.closest("button[data-overnight-hour]");
    if (hour) selectOvernightHour(hour);
  });

  elements.overnightProfile.addEventListener("keydown", (event) => {
    const hour = event.target.closest("button[data-overnight-hour]");
    if (!hour) return;
    const hours = [...elements.overnightProfile.querySelectorAll("button[data-overnight-hour]:not(:disabled)")]
      .map((button) => Number(button.dataset.overnightHour));
    const currentIndex = hours.indexOf(Number(hour.dataset.overnightHour));
    let nextIndex;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + hours.length) % hours.length;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % hours.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = hours.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = elements.overnightProfile.querySelector(`[data-overnight-hour="${hours[nextIndex]}"]`);
    selectOvernightHour(next);
    next?.focus();
  });

  elements.surplusHeatmap.addEventListener("click", (event) => {
    const cell = event.target.closest("button[data-surplus-month]");
    if (cell) selectSurplusHeatmapCell(cell);
  });

  elements.surplusHeatmap.addEventListener("focusin", (event) => {
    const cell = event.target.closest("button[data-surplus-month]");
    if (cell) selectSurplusHeatmapCell(cell);
  });
}

function ensureDependencies() {
  if (typeof Chart === "undefined") {
    throw new Error("The chart library did not load. Check the network connection and try again.");
  }
}

async function fetchEnergyData() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Energy data could not be loaded (HTTP ${response.status}).`);
  }

  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The energy source returned an unexpected data format.");
  }
  return data;
}

async function fetchGridSupplement() {
  const response = await fetch(GRID_SUPPLEMENT_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`The local Fluvius grid supplement could not be loaded (HTTP ${response.status}).`);
  }

  const data = await response.json();
  if (data?.schemaVersion !== 1 || data?.unit !== "kWh" || !data?.days) {
    throw new Error("The Fluvius grid supplement has an unexpected format.");
  }
  return data;
}

function normalizeData(root, gridSupplementDays = {}) {
  const records = [];

  Object.entries(root).forEach(([yearText, rawRecords]) => {
    const year = Number(yearText);
    if (!Number.isInteger(year) || !Array.isArray(rawRecords)) return;

    rawRecords.forEach((raw) => {
      const dayOfYear = Number(raw.D);
      if (!Number.isFinite(dayOfYear)) return;

      const date = new Date(Date.UTC(year, 0, dayOfYear));
      const iso = toIsoDate(date);
      const quarter = raw.Q || {};
      const rawImportIntervals = validEnergyArray(quarter.C);
      const rawExportIntervals = validEnergyArray(quarter.I);
      const rawGridIntervalsComplete = VALID_INTERVAL_COUNTS.has(rawImportIntervals.length)
        && rawExportIntervals.length === rawImportIntervals.length;
      const supplement = gridSupplementDays[iso];
      const supplementImportIntervals = validEnergyArray(supplement?.import);
      const supplementExportIntervals = validEnergyArray(supplement?.export);
      const supplementIntervalsComplete = VALID_INTERVAL_COUNTS.has(supplementImportIntervals.length)
        && supplementExportIntervals.length === supplementImportIntervals.length;
      const supplementedGrid = !rawGridIntervalsComplete && supplementIntervalsComplete;
      const importIntervals = supplementedGrid ? supplementImportIntervals : rawImportIntervals;
      const exportIntervals = supplementedGrid ? supplementExportIntervals : rawExportIntervals;
      const gasIntervals = numericArray(quarter.G);
      const solarIntervals = numericArray(quarter.P);
      const gridIntervalsComplete = rawGridIntervalsComplete || supplementedGrid;
      const dailyImport = validEnergyNumber(raw.U);
      const dailyExportWh = validEnergyNumber(raw.I);
      const dailyGridComplete = raw.J === true && dailyImport != null && dailyExportWh != null;
      const hasGrid = gridIntervalsComplete || dailyGridComplete;
      const production = finiteNumber(raw.P, 0);
      const gridImport = hasGrid
        ? (gridIntervalsComplete ? sum(importIntervals) : dailyImport)
        : null;
      const gridExport = hasGrid
        ? (gridIntervalsComplete ? sum(exportIntervals) : dailyExportWh / 1000)
        : null;
      const householdUse = hasGrid ? production + gridImport - gridExport : null;
      const selfUsedSolar = hasGrid ? production - gridExport : null;
      const dailyExport = dailyExportWh == null ? null : dailyExportWh / 1000;
      const repairedFromIntervals = rawGridIntervalsComplete
        && (dailyImport == null
          || dailyExport == null
          || Math.abs(gridImport - dailyImport) > 0.1
          || Math.abs(gridExport - dailyExport) > 0.1);

      records.push({
        raw,
        date,
        iso,
        year,
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        dayOfYear,
        production,
        gridImport,
        gridExport,
        householdUse,
        selfUsedSolar,
        hasGrid,
        gridIntervalsComplete,
        supplementedGrid,
        repairedFromIntervals,
        solarFinal: raw.S === true,
        gridFinal: supplementedGrid || raw.J === true,
        weatherFinal: raw.M === true,
        anomaly: raw.AS?.A === true,
        evChargingDay: raw.C === true,
        weather: raw.MS || {},
        sunrise: raw.SRS?.R || null,
        sunset: raw.SRS?.S || null,
        intervals: {
          import: importIntervals,
          export: exportIntervals,
          gas: gasIntervals,
          solar: solarIntervals
        }
      });
    });
  });

  records.sort((left, right) => left.iso.localeCompare(right.iso));
  if (!records.length) throw new Error("No daily energy records were found.");
  return records;
}

function numericArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => finiteNumber(item, 0));
}

function validEnergyArray(value) {
  if (!Array.isArray(value)) return [];
  return value.every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0)
    ? value
    : [];
}

function validEnergyNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function initializeSelection() {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view");
  const requestedDate = params.get("date");
  const years = unique(state.records.map((record) => record.year));
  const completeYears = years.filter((year) => isCompleteYear(year));
  const defaultYear = completeYears.at(-1) || years.at(-1);

  state.view = VIEW_TYPES.has(requestedView) ? requestedView : "year";
  state.anchor = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || "")
    ? requestedDate
    : `${defaultYear}-12-31`;
}

function isCompleteYear(year) {
  const records = state.records.filter((record) => record.year === year);
  const expected = isLeapYear(year) ? 366 : 365;
  return records.length === expected && records.every((record) => record.hasGrid && record.solarFinal);
}

function latestRecordForYear(year) {
  return [...state.records].reverse().find((record) => record.year === year) || null;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function configureControls() {
  const first = state.records[0];
  const last = state.records.at(-1);
  const years = unique(state.records.map((record) => record.year));

  elements.dateInput.min = first.iso;
  elements.dateInput.max = last.iso;
  elements.monthInput.min = first.iso.slice(0, 7);
  elements.monthInput.max = last.iso.slice(0, 7);
  elements.yearSelect.innerHTML = years
    .map((year) => `<option value="${year}">${year}${isCompleteYear(year) ? "" : " (partial)"}</option>`)
    .join("");
  elements.sourceLink.href = DATA_URL;
}

function configureCharts() {
  Chart.defaults.font.family = '"IBM Plex Sans", sans-serif';
  Chart.defaults.color = "#50605a";
  Chart.defaults.borderColor = "rgba(43, 57, 51, 0.12)";

  Chart.register({
    id: "solarWindowBand",
    beforeDatasetsDraw(chart, _args, options) {
      if (!options || !Number.isFinite(options.start) || !Number.isFinite(options.end)) return;
      const x = chart.scales.x;
      const area = chart.chartArea;
      if (!x || !area) return;
      const start = x.getPixelForValue(options.start);
      const end = x.getPixelForValue(Math.min(options.end, chart.data.labels.length - 1));
      const context = chart.ctx;
      context.save();
      context.fillStyle = "rgba(242, 177, 52, 0.12)";
      context.fillRect(start, area.top, Math.max(end - start, 2), area.bottom - area.top);
      context.restore();
    }
  });
}

function render() {
  state.anchor = normalizePeriodAnchor(state.records, state.anchor, state.view);
  const rows = getPeriodRows();
  const previousRows = getPreviousPeriodRows(rows);
  const aggregate = aggregateRows(rows);
  const previousAggregate = aggregateRows(previousRows);
  const solarWindow = calculateSolarWindow(rows);

  updateUrl();
  updateControls();
  renderPeriodHeader(rows, aggregate);
  renderCoverage(rows, aggregate);
  renderSolarWindow(rows, solarWindow);
  renderKpis(aggregate, previousAggregate);
  renderEnergyChart(rows, solarWindow);
  renderFlow(aggregate);
  renderSourceTimeline(rows);
  renderGridDependencyClock(rows);
  renderOvernightGridReliance(rows);
  renderGridPeakTiming(rows);
  renderInsights(rows, aggregate, solarWindow);
  renderDailyArchetypes(rows);
  renderSurplusHeatmap(rows);
  renderCalendar(rows);
  renderRankings(rows);
  renderDayDetails(rows, solarWindow);
  renderHealth(rows, aggregate);

  if (window.lucide) window.lucide.createIcons();
}

function getPeriodRows() {
  const anchor = parseIsoDate(state.anchor);
  if (!anchor) return [];
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;

  if (state.view === "day") {
    const record = state.byDate.get(state.anchor);
    return record ? [record] : [];
  }
  if (state.view === "month") {
    return state.records.filter((record) => record.year === year && record.month === month);
  }
  return state.records.filter((record) => record.year === year);
}

function getPeriodDateBounds() {
  const anchor = parseIsoDate(state.anchor);
  if (!anchor) return {};
  if (state.view === "day") return { startIso: state.anchor, endIso: state.anchor };
  if (state.view === "month") {
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    return { startIso: toIsoDate(start), endIso: toIsoDate(end) };
  }
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), 11, 31));
  return { startIso: toIsoDate(start), endIso: toIsoDate(end) };
}

function getPreviousPeriodRows(currentRows) {
  const anchor = parseIsoDate(state.anchor);
  if (!anchor || !currentRows.length) return [];
  let rows;

  if (state.view === "day") {
    const previous = addUtcDays(anchor, -1);
    const record = state.byDate.get(toIsoDate(previous));
    rows = record ? [record] : [];
  } else if (state.view === "month") {
    const previousMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1));
    rows = state.records.filter((record) => (
      record.year === previousMonth.getUTCFullYear()
      && record.month === previousMonth.getUTCMonth() + 1
    ));
  } else {
    rows = state.records.filter((record) => record.year === anchor.getUTCFullYear() - 1);
  }

  return rows.slice(0, currentRows.length);
}

function aggregateRows(rows) {
  const solarRows = rows.filter((record) => Number.isFinite(record.production));
  const gridRows = rows.filter((record) => record.hasGrid);
  const commonRows = rows.filter((record) => record.hasGrid && Number.isFinite(record.production));
  const production = sum(solarRows.map((record) => record.production));
  const gridImport = sum(gridRows.map((record) => record.gridImport));
  const gridExport = sum(gridRows.map((record) => record.gridExport));
  const commonProduction = sum(commonRows.map((record) => record.production));
  const commonImport = sum(commonRows.map((record) => record.gridImport));
  const commonExport = sum(commonRows.map((record) => record.gridExport));
  const householdUse = commonProduction + commonImport - commonExport;
  const selfUsedSolar = commonProduction - commonExport;
  const selfConsumption = safePercent(selfUsedSolar, commonProduction);
  const selfSufficiency = safePercent(selfUsedSolar, householdUse);
  const sameDayShiftCeiling = sum(commonRows.map((record) => Math.min(record.gridImport, record.gridExport)));

  return {
    rows: rows.length,
    production,
    gridImport,
    gridExport,
    commonGridImport: commonImport,
    commonGridExport: commonExport,
    householdUse,
    selfUsedSolar,
    selfConsumption,
    selfSufficiency,
    netGrid: gridImport - gridExport,
    sameDayShiftCeiling,
    solarDays: solarRows.length,
    gridDays: gridRows.length,
    commonDays: commonRows.length,
    latestSolar: maxIso(solarRows),
    latestGrid: maxIso(gridRows),
    latestCommon: maxIso(commonRows),
    anomalyDays: rows.filter((record) => record.anomaly).length,
    repairedDays: rows.filter((record) => record.repairedFromIntervals).length,
    supplementedGridDays: rows.filter((record) => record.supplementedGrid).length,
    provisionalSolarDays: rows.filter((record) => !record.solarFinal).length,
    evDays: rows.filter((record) => record.evChargingDay).length
  };
}

function safePercent(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function maxIso(rows) {
  return rows.length ? rows.at(-1).iso : null;
}

function updateUrl() {
  const params = new URLSearchParams();
  params.set("view", state.view);
  params.set("date", state.anchor);
  const query = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", query);
}

function updateControls() {
  elements.viewSwitch.querySelectorAll("button[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  elements.dateControl.hidden = state.view !== "day";
  elements.monthControl.hidden = state.view !== "month";
  elements.yearControl.hidden = state.view !== "year";
  elements.dateInput.value = state.anchor;
  elements.monthInput.value = state.anchor.slice(0, 7);
  elements.yearSelect.value = String(parseIsoDate(state.anchor).getUTCFullYear());

  const bounds = getNavigationBounds();
  elements.previousPeriod.disabled = !bounds.canPrevious;
  elements.nextPeriod.disabled = !bounds.canNext;
}

function getNavigationBounds() {
  const first = state.records[0];
  const last = state.records.at(-1);
  const anchor = parseIsoDate(state.anchor);
  const firstDate = first.date;
  const lastDate = last.date;

  if (state.view === "day") {
    return { canPrevious: anchor > firstDate, canNext: anchor < lastDate };
  }
  if (state.view === "month") {
    const currentIndex = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
    const firstIndex = first.year * 12 + first.month - 1;
    const lastIndex = last.year * 12 + last.month - 1;
    return { canPrevious: currentIndex > firstIndex, canNext: currentIndex < lastIndex };
  }
  return { canPrevious: anchor.getUTCFullYear() > first.year, canNext: anchor.getUTCFullYear() < last.year };
}

function shiftPeriod(direction) {
  const anchor = parseIsoDate(state.anchor);
  let next;

  if (state.view === "day") {
    next = addUtcDays(anchor, direction);
  } else if (state.view === "month") {
    next = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + direction, 1));
  } else {
    next = new Date(Date.UTC(anchor.getUTCFullYear() + direction, 0, 1));
  }

  const first = state.records[0].date;
  const last = state.records.at(-1).date;
  if (next < first || next > last) return;
  state.anchor = toIsoDate(next);
  render();
}

function goToLatest() {
  const latest = state.records.at(-1);
  state.anchor = latest.iso;
  render();
}

function openDay(iso, { focusDayDetail = true } = {}) {
  if (!state.byDate.has(iso)) return;
  state.view = "day";
  state.anchor = iso;
  render();
  const destination = focusDayDetail ? elements.dayDetailSection : document.querySelector("main");
  destination?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (focusDayDetail) elements.dayDetailTitle.focus({ preventScroll: true });
}

function renderPeriodHeader(rows, aggregate) {
  const anchor = parseIsoDate(state.anchor);
  let title;
  let eyebrow;

  if (state.view === "day") {
    title = formatLongDate(anchor);
    eyebrow = "Daily energy detail";
  } else if (state.view === "month") {
    title = `${LONG_MONTHS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;
    eyebrow = "Monthly energy picture";
  } else {
    title = String(anchor.getUTCFullYear());
    eyebrow = isCompleteYear(anchor.getUTCFullYear()) ? "Complete year" : "Partial year";
  }

  elements.periodEyebrow.textContent = eyebrow;
  elements.periodTitle.textContent = title;
  elements.periodSubtitle.textContent = periodSummarySentence(rows, aggregate);
  elements.dataStatus.textContent = `${formatInteger(state.records.length)} days loaded`;

  const globalSolar = state.records.filter((record) => record.solarFinal);
  const globalGrid = state.records.filter((record) => record.hasGrid);
  elements.freshnessStatus.textContent = `Solar ${formatShortDate(maxIso(globalSolar))} / Grid ${formatShortDate(maxIso(globalGrid))}`;
  elements.lastUpdated.textContent = state.loadedAt
    ? `Loaded ${state.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "";
}

function periodSummarySentence(rows, aggregate) {
  if (!rows.length) return "No records are available for this period.";
  if (aggregate.commonDays === rows.length) {
    return `${rows.length} ${rows.length === 1 ? "day" : "days"} with complete solar and grid coverage.`;
  }
  if (aggregate.commonDays > 0) {
    return `${aggregate.solarDays} solar days; full energy balance available for ${aggregate.commonDays}.`;
  }
  return `${aggregate.solarDays} solar days; grid data is unavailable for this period.`;
}

function renderCoverage(rows, aggregate) {
  const notes = [];
  if (aggregate.gridDays < rows.length) {
    notes.push(`Grid-based values cover ${aggregate.gridDays} of ${rows.length} days${aggregate.latestGrid ? `, through ${formatShortDate(aggregate.latestGrid)}` : ""}.`);
  }
  if (aggregate.provisionalSolarDays > 0) {
    notes.push(`${aggregate.provisionalSolarDays} solar ${aggregate.provisionalSolarDays === 1 ? "record is" : "records are"} provisional.`);
  }
  if (aggregate.supplementedGridDays > 0) {
    notes.push(`${aggregate.supplementedGridDays} grid ${aggregate.supplementedGridDays === 1 ? "day was" : "days were"} restored from the Fluvius quarter-hour export.`);
  }
  if (aggregate.repairedDays > 0) {
    notes.push(`${aggregate.repairedDays} daily ${aggregate.repairedDays === 1 ? "summary was" : "summaries were"} replaced by complete interval totals.`);
  }

  elements.coverageNotice.hidden = notes.length === 0;
  elements.coverageText.textContent = notes.join(" ");
}

function calculateSolarWindow(rows) {
  const profiles = [];
  const exportProfiles = [];

  rows.forEach((record) => {
    const solarProfile = toCanonicalDaySeries(record.intervals.solar);
    if (!solarProfile) return;
    profiles.push(solarProfile);

    const exportProfile = toCanonicalDaySeries(record.intervals.export);
    if (exportProfile) {
      exportProfiles.push(exportProfile.map((value) => value == null ? null : value * 4));
    }
  });

  if (!profiles.length) return null;

  const solarProfile = Array.from({ length: 96 }, (_, index) => (
    median(profiles.map((profile) => profile[index]).filter(Number.isFinite))
  ));
  const exportProfile = exportProfiles.length
    ? Array.from({ length: 96 }, (_, index) => median(
      exportProfiles.map((profile) => profile[index]).filter(Number.isFinite)
    ))
    : Array(96).fill(0);
  const score = solarProfile.map((solar, index) => solar + exportProfile[index] * 0.65);
  const windowLength = 8;
  let bestStart = 0;
  let bestScore = -Infinity;

  for (let start = 0; start <= score.length - windowLength; start += 1) {
    const rollingScore = sum(score.slice(start, start + windowLength));
    if (rollingScore > bestScore) {
      bestScore = rollingScore;
      bestStart = start;
    }
  }

  const end = bestStart + windowLength;
  return {
    start: bestStart,
    end,
    startLabel: slotLabel(bestStart),
    endLabel: slotLabel(end),
    profile: solarProfile,
    exportProfile,
    sampleDays: profiles.length,
    peakSolar: Math.max(...solarProfile),
    peakIndex: solarProfile.indexOf(Math.max(...solarProfile))
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function slotLabel(index) {
  const normalized = ((index % 96) + 96) % 96;
  const hours = Math.floor(normalized / 4);
  const minutes = (normalized % 4) * 15;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function renderSolarWindow(rows, solarWindow) {
  const isDay = state.view === "day";
  elements.solarWindowTitle.textContent = isDay ? "Best observed solar window" : "Typical solar window";

  if (!solarWindow) {
    elements.solarWindowTime.textContent = "Not available";
    elements.solarWindowCopy.textContent = "No complete 15-minute solar profile is available for this selection.";
    elements.bestWindowBand.hidden = true;
    elements.daylightBand.hidden = true;
    elements.sunriseLabel.textContent = "";
    elements.sunsetLabel.textContent = "";
    return;
  }

  elements.solarWindowTime.textContent = `${solarWindow.startLabel} - ${solarWindow.endLabel}`;
  elements.solarWindowCopy.textContent = isDay
    ? "Run flexible loads in this recorded two-hour window to overlap with the strongest solar and export signal."
    : `Based on the median profile from ${solarWindow.sampleDays} days in this selection.`;
  elements.bestWindowBand.hidden = false;
  elements.bestWindowBand.style.left = `${(solarWindow.start / 96) * 100}%`;
  elements.bestWindowBand.style.width = `${((solarWindow.end - solarWindow.start) / 96) * 100}%`;

  const sunTimes = typicalSunTimes(rows);
  if (sunTimes) {
    const startPercent = (sunTimes.sunriseMinutes / 1440) * 100;
    const widthPercent = ((sunTimes.sunsetMinutes - sunTimes.sunriseMinutes) / 1440) * 100;
    elements.daylightBand.hidden = false;
    elements.daylightBand.style.left = `${startPercent}%`;
    elements.daylightBand.style.width = `${widthPercent}%`;
    elements.sunriseLabel.textContent = sunTimes.sunrise;
    elements.sunsetLabel.textContent = sunTimes.sunset;
  } else {
    elements.daylightBand.hidden = true;
    elements.sunriseLabel.textContent = "00:00";
    elements.sunsetLabel.textContent = "24:00";
  }
}

function typicalSunTimes(rows) {
  const pairs = rows
    .map((record) => ({
      sunrise: extractClock(record.sunrise),
      sunset: extractClock(record.sunset)
    }))
    .filter((pair) => pair.sunrise && pair.sunset);
  if (!pairs.length) return null;

  const sunriseMinutes = Math.round(median(pairs.map((pair) => clockToMinutes(pair.sunrise))));
  const sunsetMinutes = Math.round(median(pairs.map((pair) => clockToMinutes(pair.sunset))));
  return {
    sunriseMinutes,
    sunsetMinutes,
    sunrise: minutesToClock(sunriseMinutes),
    sunset: minutesToClock(sunsetMinutes)
  };
}

function extractClock(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function clockToMinutes(clock) {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToClock(total) {
  const normalized = Math.max(0, Math.min(1439, total));
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function renderKpis(current, previous) {
  const kpis = [
    {
      label: "Solar produced",
      icon: "sun",
      tone: "solar",
      value: current.production,
      previous: previous.production,
      days: current.solarDays,
      previousDays: previous.solarDays,
      detail: current.latestSolar ? `through ${formatShortDate(current.latestSolar)}` : "No solar data"
    },
    {
      label: "Household use",
      icon: "house-plug",
      tone: "home",
      value: current.commonDays ? current.householdUse : null,
      previous: previous.commonDays ? previous.householdUse : null,
      days: current.commonDays,
      previousDays: previous.commonDays,
      detail: "derived energy balance"
    },
    {
      label: "Grid import",
      icon: "arrow-down-to-line",
      tone: "import",
      value: current.gridDays ? current.gridImport : null,
      previous: previous.gridDays ? previous.gridImport : null,
      days: current.gridDays,
      previousDays: previous.gridDays,
      detail: "energy bought from grid"
    },
    {
      label: "Grid export",
      icon: "arrow-up-from-line",
      tone: "export",
      value: current.gridDays ? current.gridExport : null,
      previous: previous.gridDays ? previous.gridExport : null,
      days: current.gridDays,
      previousDays: previous.gridDays,
      detail: "solar sent to grid"
    },
    {
      label: "Self-used solar",
      icon: "circle-gauge",
      tone: "self",
      value: current.commonDays ? current.selfUsedSolar : null,
      previous: previous.commonDays ? previous.selfUsedSolar : null,
      days: current.commonDays,
      previousDays: previous.commonDays,
      detail: current.selfConsumption == null ? "No balance data" : `${formatPercent(current.selfConsumption)} of production`
    },
    {
      label: "Solar self-sufficiency",
      icon: "shield-check",
      tone: "autarky",
      value: current.selfSufficiency,
      previous: previous.selfSufficiency,
      days: current.commonDays,
      previousDays: previous.commonDays,
      isPercent: true,
      detail: "share of household demand"
    }
  ];

  elements.kpiGrid.innerHTML = kpis.map((kpi) => {
    const change = comparableChange(kpi.value, kpi.previous, kpi.days, kpi.previousDays, kpi.isPercent);
    const value = kpi.value == null
      ? "Unavailable"
      : (kpi.isPercent ? formatPercent(kpi.value) : formatEnergy(kpi.value));
    const changeClass = change?.direction === "up" ? "is-up" : change?.direction === "down" ? "is-down" : "";

    return `
      <article class="kpi-card kpi-${kpi.tone}">
        <div class="kpi-heading">
          <span class="kpi-icon" aria-hidden="true"><i data-lucide="${kpi.icon}"></i></span>
          <span>${kpi.label}</span>
        </div>
        <strong class="kpi-value ${kpi.value == null ? "is-muted" : ""}">${value}</strong>
        <div class="kpi-foot">
          <span>${kpi.detail}</span>
          ${change ? `<span class="kpi-change ${changeClass}">${change.text}</span>` : ""}
        </div>
      </article>`;
  }).join("");
}

function comparableChange(current, previous, currentDays, previousDays, isPercent = false) {
  if (current == null || previous == null || currentDays !== previousDays || currentDays === 0) return null;
  const difference = current - previous;
  if (isPercent) {
    return {
      text: `${difference >= 0 ? "+" : ""}${difference.toFixed(1)} pts`,
      direction: difference > 0.05 ? "up" : difference < -0.05 ? "down" : "flat"
    };
  }
  if (previous === 0) return null;
  const percent = (difference / Math.abs(previous)) * 100;
  return {
    text: `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`,
    direction: percent > 0.05 ? "up" : percent < -0.05 ? "down" : "flat"
  };
}

function renderEnergyChart(rows, solarWindow) {
  if (state.energyChart) state.energyChart.destroy();
  const context = elements.energyChart.getContext("2d");

  if (state.view === "day") {
    const record = rows[0];
    elements.chartTitle.textContent = "15-minute energy profile";
    elements.chartSubtitle.textContent = "Observed power; the amber band marks the recommended solar window.";

    const hasIntervalProfile = record && [
      record.intervals.solar,
      record.intervals.import,
      record.intervals.export
    ].some((values) => values.length);
    if (!hasIntervalProfile) {
      state.energyChart = createEmptyChart(context, "No interval profile is available for this day.");
      return;
    }

    const pointCount = Math.max(
      record.intervals.solar.length,
      record.intervals.import.length,
      record.intervals.export.length
    );
    const labels = buildIntervalLabels(record.iso, pointCount);
    const solar = alignIntervalSeries(record.intervals.solar, pointCount);
    const gridImport = record.hasGrid
      ? alignIntervalSeries(record.intervals.import.map((value) => value * 4), pointCount)
      : Array(pointCount).fill(null);
    const gridExport = record.hasGrid
      ? alignIntervalSeries(record.intervals.export.map((value) => value * 4), pointCount)
      : Array(pointCount).fill(null);
    const scaleValues = [...solar, ...gridImport, ...gridExport].filter(Number.isFinite);
    const robustMax = percentile(scaleValues, 0.995) * 1.2;

    state.energyChart = new Chart(context, {
      type: "line",
      data: {
        labels,
        datasets: [
          lineDataset("Solar power", solar, "#1b7f52", "rgba(27, 127, 82, 0.12)", true),
          lineDataset("Grid import", gridImport, "#3273a8", "rgba(50, 115, 168, 0.08)"),
          lineDataset("Grid export", gridExport, "#d49318", "rgba(212, 147, 24, 0.08)")
        ]
      },
      options: chartOptions({
        unit: "kW",
        max: robustMax > 0 ? robustMax : undefined,
        windowStart: mapDaySlotToSeriesIndex(solarWindow?.start, pointCount),
        windowEnd: mapDaySlotToSeriesIndex(solarWindow?.end, pointCount),
        sparseTicks: true
      })
    });
    return;
  }

  const buckets = state.view === "month" ? rows.map((record) => [record]) : groupByMonth(rows);
  const labels = state.view === "month"
    ? buckets.map(([record]) => String(record.day))
    : buckets.map((bucket) => MONTHS[bucket[0].month - 1]);
  const aggregates = buckets.map(aggregateRows);
  elements.chartTitle.textContent = state.view === "month" ? "Daily energy balance" : "Monthly energy balance";
  elements.chartSubtitle.textContent = "Production and household demand with measured grid exchange.";

  state.energyChart = new Chart(context, {
    type: "bar",
    data: {
      labels,
      datasets: [
        barDataset("Solar produced", aggregates.map((item) => item.production), "rgba(27, 127, 82, 0.82)"),
        barDataset("Grid import", aggregates.map((item) => item.gridDays ? item.gridImport : null), "rgba(50, 115, 168, 0.72)"),
        barDataset("Grid export", aggregates.map((item) => item.gridDays ? -item.gridExport : null), "rgba(212, 147, 24, 0.76)"),
        {
          type: "line",
          label: "Household use",
          data: aggregates.map((item) => item.commonDays ? item.householdUse : null),
          borderColor: "#27332e",
          backgroundColor: "#27332e",
          borderWidth: 2,
          pointRadius: state.view === "month" ? 1.5 : 3,
          pointHoverRadius: 5,
          tension: 0.2
        }
      ]
    },
    options: chartOptions({ unit: "kWh", showZeroLine: true })
  });
}

function lineDataset(label, data, borderColor, backgroundColor, fill = false) {
  return {
    label,
    data,
    borderColor,
    backgroundColor,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    spanGaps: true,
    fill,
    tension: 0.24
  };
}

function barDataset(label, data, backgroundColor) {
  return {
    label,
    data,
    backgroundColor,
    borderColor: backgroundColor,
    borderWidth: 0,
    borderRadius: 2,
    maxBarThickness: 32
  };
}

function chartOptions({ unit, max, windowStart, windowEnd, sparseTicks = false, showZeroLine = false }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    animation: { duration: 500 },
    plugins: {
      legend: {
        position: "bottom",
        labels: { usePointStyle: true, boxWidth: 8, padding: 18 }
      },
      tooltip: {
        callbacks: {
          label(context) {
            const value = context.parsed.y;
            if (value == null) return `${context.dataset.label}: unavailable`;
            const absolute = Math.abs(value);
            return `${context.dataset.label}: ${absolute.toFixed(2)} ${unit}`;
          }
        }
      },
      solarWindowBand: {
        start: windowStart,
        end: windowEnd
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          autoSkip: true,
          maxTicksLimit: sparseTicks ? 12 : 16,
          maxRotation: 0
        }
      },
      y: {
        beginAtZero: true,
        max,
        grid: {
          color(context) {
            if (showZeroLine && context.tick.value === 0) return "rgba(39, 51, 46, 0.42)";
            return "rgba(43, 57, 51, 0.09)";
          }
        },
        title: { display: true, text: unit },
        ticks: {
          callback(value) {
            return Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
          }
        }
      }
    }
  };
}

function createEmptyChart(context, message) {
  return new Chart(context, {
    type: "bar",
    data: { labels: [message], datasets: [{ data: [0], backgroundColor: "transparent" }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { grid: { display: false } }, y: { display: false } }
    }
  });
}

function buildIntervalLabels(iso, count) {
  const labels = [];
  for (let index = 0; index < count; index += 1) {
    if (count === 92) {
      const quarter = index < 8 ? index : index + 4;
      labels.push(slotLabel(quarter));
    } else if (count === 100) {
      if (index >= 8 && index < 12) {
        labels.push(`${slotLabel(index)}a`);
      } else if (index >= 12 && index < 16) {
        labels.push(`${slotLabel(index - 4)}b`);
      } else {
        labels.push(slotLabel(index < 16 ? index : index - 4));
      }
    } else {
      labels.push(slotLabel(index));
    }
  }
  return labels;
}

function padArray(values, length) {
  return Array.from({ length }, (_, index) => values[index] ?? null);
}

function alignIntervalSeries(values, targetCount) {
  if (values.length === targetCount) return [...values];
  if (values.length === 92 && targetCount === 96) {
    return [...values.slice(0, 8), ...Array(4).fill(null), ...values.slice(8)];
  }
  if (values.length === 92 && targetCount === 100) {
    return [...values.slice(0, 8), ...Array(8).fill(null), ...values.slice(8)];
  }
  if (values.length === 96 && targetCount === 100) {
    return [...values.slice(0, 12), ...Array(4).fill(null), ...values.slice(12)];
  }
  return padArray(values, targetCount);
}

function toCanonicalDaySeries(values) {
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

function mapDaySlotToSeriesIndex(index, pointCount) {
  if (index == null) return undefined;
  if (pointCount === 92) {
    if (index <= 8) return index;
    if (index < 12) return 8;
    return index - 4;
  }
  if (pointCount === 100) {
    if (index < 12) return index;
    return index + 4;
  }
  return index;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.floor((sorted.length - 1) * ratio);
  return sorted[index];
}

function groupByMonth(rows) {
  const groups = new Map();
  rows.forEach((record) => {
    const key = `${record.year}-${String(record.month).padStart(2, "0")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return [...groups.values()];
}

function renderFlow(aggregate) {
  elements.flowTitle.textContent = "Solar utilisation";

  if (!aggregate.commonDays) {
    elements.flowSubtitle.textContent = "A complete solar and grid balance is needed to show how energy was used.";
    elements.flowDiagram.innerHTML = `<div class="empty-panel"><i data-lucide="cloud-off"></i><span>Grid measurements unavailable</span></div>`;
    return;
  }

  const funnel = buildEnergyUtilizationFunnel({
    selfUsedSolar: aggregate.selfUsedSolar,
    commonGridExport: aggregate.commonGridExport,
    commonGridImport: aggregate.commonGridImport
  });
  if (!funnel) {
    elements.flowSubtitle.textContent = "The selected balance contains an invalid energy value.";
    elements.flowDiagram.innerHTML = `<div class="empty-panel"><i data-lucide="triangle-alert"></i><span>Energy balance unavailable</span></div>`;
    return;
  }

  const coverage = aggregate.latestCommon ? ` through ${formatShortDate(aggregate.latestCommon)}` : "";
  elements.flowSubtitle.textContent = `${aggregate.commonDays} ${aggregate.commonDays === 1 ? "day" : "days"} with complete solar and grid coverage${coverage}.`;
  elements.flowDiagram.innerHTML = `
    <div class="utilization-funnel">
      ${renderUtilizationStage({
        icon: "sun",
        heading: "Solar produced",
        total: funnel.solar.total,
        first: { label: "Used at home", value: funnel.solar.first, share: funnel.solar.firstShare, tone: "solar-home" },
        second: { label: "Sent to grid", value: funnel.solar.second, share: funnel.solar.secondShare, tone: "solar-grid" }
      })}
      ${renderUtilizationStage({
        icon: "house-plug",
        heading: "Household demand",
        total: funnel.household.total,
        first: { label: "Supplied by solar", value: funnel.household.first, share: funnel.household.firstShare, tone: "solar-home" },
        second: { label: "Supplied by grid", value: funnel.household.second, share: funnel.household.secondShare, tone: "grid-home" }
      })}
    </div>`;
}

function renderUtilizationStage({ icon, heading, total, first, second }) {
  const firstWidth = formatFunnelShare(first.share);
  const secondWidth = formatFunnelShare(second.share);
  const trackLabel = `${heading}: ${formatEnergy(total)}. ${first.label}: ${formatEnergy(first.value)}, ${formatPercent(first.share)}. ${second.label}: ${formatEnergy(second.value)}, ${formatPercent(second.share)}.`;
  return `
    <section class="utilization-stage">
      <header class="utilization-stage-heading">
        <span class="utilization-stage-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
        <span>${heading}</span>
        <strong>${formatEnergy(total)}</strong>
      </header>
      <div class="utilization-track" role="img" aria-label="${trackLabel}">
        <span class="utilization-segment is-${first.tone}" style="width:${firstWidth}%"></span>
        <span class="utilization-segment is-${second.tone}" style="width:${secondWidth}%"></span>
      </div>
      <div class="utilization-branches">
        <div class="utilization-branch is-${first.tone}">
          <span>${first.label}</span><strong>${formatEnergy(first.value)}</strong><small>${formatPercent(first.share)}</small>
        </div>
        <div class="utilization-branch is-${second.tone}">
          <span>${second.label}</span><strong>${formatEnergy(second.value)}</strong><small>${formatPercent(second.share)}</small>
        </div>
      </div>
    </section>`;
}

function formatFunnelShare(share) {
  return share == null ? 0 : Math.max(0, Math.min(100, share)).toFixed(3);
}

function renderSourceTimeline(rows, focusSourceId = null) {
  const timeline = buildSourceCoverageTimeline(rows, getPeriodDateBounds());
  const selectedSource = timeline.sources.some((source) => source.id === state.sourceTimelineSource)
    ? state.sourceTimelineSource
    : timeline.sources[0]?.id;
  state.sourceTimelineSource = selectedSource;

  const periodLabel = state.view === "day" ? "selected day" : state.view === "month" ? "selected month" : "selected year";
  elements.sourceTimelineTitle.textContent = state.view === "day"
    ? "Source status for this day"
    : "Source confidence across the period";
  elements.sourceTimelineSubtitle.textContent = !timeline.days
    ? "No source dates are available for this selection."
    : state.view === "day"
      ? "Observed source status for this day."
      : `${formatInteger(timeline.days)} observed ${timeline.days === 1 ? "date" : "dates"} across ${formatSourceDateRange(timeline.periodStartIso, timeline.periodEndIso)}; contiguous source states are grouped, and ${formatInteger(Math.max(0, timeline.daySpan - timeline.days))} calendar ${timeline.daySpan - timeline.days === 1 ? "gap remains" : "gaps remain"} blank.`;

  const legendItems = sourceTimelineLegendItems(timeline);
  elements.sourceTimelineLegend.innerHTML = legendItems.map((item) => `
    <span class="source-timeline-legend-item is-${item.tone}">
      <i aria-hidden="true"></i><span>${item.label}</span><strong>${formatInteger(item.days)}</strong>
    </span>`).join("");

  const selected = timeline.sources.find((source) => source.id === selectedSource);
  elements.sourceTimelineSelection.textContent = selected
    ? `${sourceTimelineReadout(selected)}${sourceTimelineGapReadout(timeline)}`
    : "No source detail is available.";

  elements.sourceTimeline.innerHTML = `
    <div class="source-timeline-scroll" tabindex="0" aria-label="Scroll horizontally to view the selected period by date">
      <div class="source-timeline-grid" style="--timeline-days:${Math.max(timeline.daySpan, 1)}" role="radiogroup" aria-label="Select a source timeline">
        ${timeline.sources.map((source) => renderSourceTimelineRow(source, selectedSource)).join("")}
      </div>
    </div>`;
  if (focusSourceId) {
    elements.sourceTimeline.querySelector(`[data-source-timeline-source="${selectedSource}"]`)?.focus();
  }
}

function renderSourceTimelineRow(source, selectedSource) {
  const sourceDetail = SOURCE_TIMELINE_SOURCES[source.id];
  const selected = source.id === selectedSource;
  const segments = source.segments.map((segment) => {
    const state = sourceTimelineStateDetail(source.id, segment.state);
    const label = sourceTimelineSegmentLabel(source, segment, state);
    return `<span class="source-timeline-segment is-${state.tone}" style="grid-column:${segment.startOffset + 1} / span ${segment.length}" aria-hidden="true" title="${label}"></span>`;
  }).join("");
  return `
    <div class="source-timeline-row ${selected ? "is-selected" : ""}">
      <button type="button" role="radio" class="source-timeline-source" data-source-timeline-source="${source.id}" aria-checked="${selected}" tabindex="${selected ? 0 : -1}">
        <i data-lucide="${sourceDetail.icon}" aria-hidden="true"></i><span>${source.label}</span>
      </button>
      <div class="source-timeline-band" aria-label="${sourceTimelineReadout(source)}">${segments}</div>
    </div>`;
}

function sourceTimelineLegendItems(timeline) {
  const items = new Map();
  timeline.sources.forEach((source) => {
    source.segments.forEach((segment) => {
      const state = sourceTimelineStateDetail(source.id, segment.state);
      const key = `${source.id}-${segment.state}`;
      const current = items.get(key) || { ...state, days: 0 };
      current.days += segment.length;
      items.set(key, current);
    });
  });
  const calendarGaps = Math.max(0, timeline.daySpan - timeline.days);
  if (calendarGaps) {
    items.set("calendar-gap", { label: "No source record", tone: "calendar-gap", days: calendarGaps });
  }
  return [...items.values()];
}

function sourceTimelineReadout(source) {
  const ranges = source.segments.map((segment) => {
    const state = sourceTimelineStateDetail(source.id, segment.state);
    return `${state.label}: ${formatSourceDateRange(segment.startIso, segment.endIso)} (${formatInteger(segment.length)} ${segment.length === 1 ? "day" : "days"})`;
  });
  return `${source.label}: ${ranges.join("; ") || "no source status"}.`;
}

function sourceTimelineGapReadout(timeline) {
  const gaps = Math.max(0, timeline.daySpan - timeline.days);
  return gaps ? ` ${formatInteger(gaps)} calendar ${gaps === 1 ? "date has" : "dates have"} no source record.` : "";
}

function sourceTimelineSegmentLabel(source, segment, state) {
  return `${source.label}, ${state.label}: ${formatSourceDateRange(segment.startIso, segment.endIso)} (${formatInteger(segment.length)} ${segment.length === 1 ? "day" : "days"}).`;
}

function sourceTimelineStateDetail(sourceId, state) {
  return SOURCE_TIMELINE_STATES[sourceId]?.[state] || { label: "Unavailable", tone: "unavailable" };
}

function formatSourceDateRange(startIso, endIso) {
  return startIso === endIso ? formatShortDate(startIso) : `${formatShortDate(startIso)} to ${formatShortDate(endIso)}`;
}

function selectSourceTimelineSource(sourceId) {
  if (!SOURCE_TIMELINE_SOURCE_ORDER.includes(sourceId)) return;
  state.sourceTimelineSource = sourceId;
  renderSourceTimeline(getPeriodRows(), sourceId);
  if (window.lucide) window.lucide.createIcons();
}

function renderGridDependencyClock(rows) {
  const clock = buildGridDependencyClock(rows);
  const isDay = state.view === "day";
  elements.gridClockTitle.textContent = isDay
    ? "Grid direction this day"
    : "Typical grid dependency by hour";
  if (!clock.sampleDays) {
    elements.gridClockSubtitle.textContent = "No complete 15-minute grid profiles are available in this selection.";
    elements.gridClockLegend.hidden = true;
    elements.gridClock.innerHTML = `<div class="grid-clock-empty"><i data-lucide="cloud-off" aria-hidden="true"></i><span>Complete grid interval data is needed to show hourly grid direction.</span></div>`;
    return;
  }

  const coverage = clock.latestIso ? ` through ${formatShortDate(clock.latestIso)}` : "";
  elements.gridClockSubtitle.textContent = `${formatInteger(clock.sampleDays)} complete grid ${clock.sampleDays === 1 ? "profile" : "profiles"}${coverage}. Each hour marks import (I), export (E), or mixed/balanced (=) direction across observed profiles.`;
  elements.gridClockLegend.hidden = false;
  elements.gridClockLegend.innerHTML = `
    ${renderGridClockLegend("import")}
    ${renderGridClockLegend("export")}
    ${renderGridClockLegend("balanced")}
    ${renderGridClockLegend("unavailable")}`;

  const availableHours = clock.hours.filter((hour) => hour.samples);
  const selectedHour = availableHours.some((hour) => hour.hour === state.gridClockHour)
    ? state.gridClockHour
    : clock.peakImport?.hour ?? availableHours[0]?.hour;
  state.gridClockHour = selectedHour;
  elements.gridClock.innerHTML = `
    <div class="grid-clock-body">
      <div class="grid-clock-face" role="radiogroup" aria-label="Select an hourly grid direction">
        <span class="grid-clock-axis is-00" aria-hidden="true">00</span>
        <span class="grid-clock-axis is-06" aria-hidden="true">06</span>
        <span class="grid-clock-axis is-12" aria-hidden="true">12</span>
        <span class="grid-clock-axis is-18" aria-hidden="true">18</span>
        ${clock.hours.map((hour) => renderGridClockHour(hour, selectedHour)).join("")}
        <div class="grid-clock-center" aria-hidden="true"><span>Selected</span><strong class="grid-clock-center-hour">${formatHourRange(selectedHour)}</strong></div>
      </div>
      <div id="gridClockReadout" class="grid-clock-readout" role="status" aria-atomic="true"></div>
    </div>`;
  renderGridClockReadout(clock.hours[selectedHour]);
}

function renderGridClockLegend(state) {
  const detail = GRID_CLOCK_STATES[state];
  return `<span class="grid-clock-legend-item is-${detail.tone}"><i aria-hidden="true">${detail.marker}</i><span>${detail.label}</span></span>`;
}

function renderGridClockHour(hour, selectedHour) {
  const detail = GRID_CLOCK_STATES[hour.state];
  const angle = hour.hour * 15;
  const reverseAngle = -angle;
  const intensity = Math.round(22 + Math.max(hour.importShare, hour.exportShare, hour.balancedShare) * 0.62);
  const label = gridClockHourLabel(hour, detail);
  return `
    <button type="button" role="radio" class="grid-clock-hour is-${detail.tone} ${hour.hour === selectedHour ? "is-selected" : ""}" data-grid-clock-hour="${hour.hour}" style="--clock-angle:${angle}deg; --clock-reverse-angle:${reverseAngle}deg; --clock-intensity:${intensity}%" aria-checked="${hour.hour === selectedHour}" tabindex="${hour.hour === selectedHour ? 0 : -1}" aria-label="${label}" title="${label}" ${hour.samples ? "" : "disabled"}>
      <span aria-hidden="true">${detail.marker}</span>
    </button>`;
}

function selectGridClockHour(hour, element) {
  if (!Number.isInteger(hour)) return;
  state.gridClockHour = hour;
  elements.gridClock.querySelector(".grid-clock-hour.is-selected")?.classList.remove("is-selected");
  elements.gridClock.querySelector(".grid-clock-hour[aria-checked=\"true\"]")?.setAttribute("aria-checked", "false");
  if (element) {
    element.classList.add("is-selected");
    element.setAttribute("aria-checked", "true");
    element.tabIndex = 0;
  }
  elements.gridClock.querySelectorAll(".grid-clock-hour:not(.is-selected)").forEach((button) => {
    button.tabIndex = -1;
  });
  const hourDetail = element ? gridClockHourDetailFromElement(element) : null;
  const centerHour = elements.gridClock.querySelector(".grid-clock-center-hour");
  if (centerHour) centerHour.textContent = formatHourRange(hour);
  if (hourDetail) renderGridClockReadout(hourDetail);
}

function gridClockHourDetailFromElement(element) {
  const hour = Number(element.dataset.gridClockHour);
  const profiles = getPeriodRows();
  return buildGridDependencyClock(profiles).hours[hour];
}

function renderGridClockReadout(hour) {
  if (!hour) return;
  const readout = elements.gridClock.querySelector(".grid-clock-readout");
  if (!readout) return;
  const detail = GRID_CLOCK_STATES[hour.state];
  const dominantShare = Math.max(hour.importShare, hour.exportShare, hour.balancedShare);
  readout.innerHTML = hour.samples
    ? `
      <span class="eyebrow">Selected hour</span>
      <strong>${formatHourRange(hour.hour)}</strong>
      <p><b>${detail.label}</b> on ${formatPercent(dominantShare)} of ${formatInteger(hour.samples)} ${hour.samples === 1 ? "profile" : "profiles"}.</p>
      <dl>
        <div><dt>Import</dt><dd>${formatPercent(hour.importShare)} / ${formatEnergy(hour.medianImport)}</dd></div>
        <div><dt>Export</dt><dd>${formatPercent(hour.exportShare)} / ${formatEnergy(hour.medianExport)}</dd></div>
        <div><dt>Balanced</dt><dd>${formatPercent(hour.balancedShare)}</dd></div>
      </dl>`
    : `
      <span class="eyebrow">Selected hour</span>
      <strong>${formatHourRange(hour.hour)}</strong>
      <p>No complete interval profiles were available for this daylight-saving hour.</p>`;
}

function gridClockHourLabel(hour, detail) {
  if (!hour.samples) return `${formatHourRange(hour.hour)}: no complete grid profiles available.`;
  return `${formatHourRange(hour.hour)}: ${detail.label}. Import ${formatPercent(hour.importShare)}, export ${formatPercent(hour.exportShare)}, balanced ${formatPercent(hour.balancedShare)} across ${formatInteger(hour.samples)} ${hour.samples === 1 ? "profile" : "profiles"}.`;
}

function nextAvailableGridClockHour(currentHour, offset, availableHours) {
  for (let step = 1; step <= 24; step += 1) {
    const candidate = (currentHour + offset * step + 240) % 24;
    if (availableHours.includes(candidate)) return candidate;
  }
  return currentHour;
}

function renderOvernightGridReliance(rows) {
  const isDay = state.view === "day";
  const groups = getOvernightGroups(rows);
  const overnight = buildOvernightGridReliance(groups);
  elements.overnightTitle.textContent = isDay
    ? "Observed overnight grid import"
    : "Overnight grid reliance";

  if (!overnight.sampleDays) {
    const exclusions = overnight.excludedProfileDays
      ? ` ${formatInteger(overnight.excludedProfileDays)} daylight-saving ${overnight.excludedProfileDays === 1 ? "window was" : "windows were"} excluded because 00:00-06:00 was incomplete.`
      : "";
    elements.overnightSubtitle.textContent = `No complete DST-normalized 00:00-06:00 grid windows are available in this selection.${exclusions}`;
    elements.overnightSummary.hidden = true;
    elements.overnightReadout.hidden = true;
    elements.overnightProfile.innerHTML = `<div class="overnight-empty"><i data-lucide="cloud-off" aria-hidden="true"></i><span>Complete overnight interval windows are needed to show observed grid import.</span></div>`;
    elements.overnightMonths.innerHTML = "";
    return;
  }

  const coverage = overnight.latestIso ? ` through ${formatShortDate(overnight.latestIso)}` : "";
  const exclusions = overnight.excludedProfileDays
    ? ` ${formatInteger(overnight.excludedProfileDays)} daylight-saving ${overnight.excludedProfileDays === 1 ? "window was" : "windows were"} excluded because 00:00-06:00 was incomplete.`
    : "";
  elements.overnightSubtitle.textContent = `${formatInteger(overnight.sampleDays)} complete DST-normalized 00:00-06:00 windows${coverage}.${exclusions}`;
  elements.overnightSummary.hidden = false;
  elements.overnightSummary.innerHTML = `
    ${renderOvernightMetric("Cumulative normalized import", formatEnergy(overnight.totalOvernight), "across complete overnight windows")}
    ${renderOvernightMetric("Median nightly import", formatOvernightEnergy(overnight.medianOvernight), "per 00:00-06:00 window")}
    ${renderOvernightMetric("Share of normalized import", formatPercent(overnight.overnightShare), "within the same profile set")}`;

  const availableHours = overnight.hourlyMedians
    .map((value, hour) => ({ value, hour }))
    .filter(({ value }) => Number.isFinite(value));
  const selectedHour = availableHours.some(({ hour }) => hour === state.overnightHour)
    ? state.overnightHour
    : availableHours[0]?.hour;
  state.overnightHour = selectedHour;
  const maxHourly = Math.max(...availableHours.map(({ value }) => value), 0);
  elements.overnightProfile.innerHTML = `
    <div class="overnight-profile-heading"><span>Typical import by hour</span><span>DST-normalized median kWh</span></div>
    <div class="overnight-hour-profile" role="radiogroup" aria-label="Select an overnight import hour">
      ${overnight.hourlyMedians.map((value, hour) => renderOvernightHour(hour, value, maxHourly, selectedHour, overnight.sampleDays)).join("")}
    </div>`;
  elements.overnightReadout.hidden = false;
  renderOvernightReadout(overnight, selectedHour);

  const maxGroupMedian = Math.max(...overnight.groups.map((group) => group.medianOvernight ?? 0), 0);
  elements.overnightMonths.innerHTML = `
    <div class="overnight-month-heading"><span>${isDay ? "Window" : "Calendar month"}</span><span>Median per night</span></div>
    ${overnight.groups.map((group) => renderOvernightMonth(group, maxGroupMedian)).join("")}`;
}

function renderOvernightMetric(label, value, detail) {
  return `<div class="overnight-metric"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
}

function renderOvernightHour(hour, value, maximum, selectedHour, samples) {
  const available = Number.isFinite(value);
  const height = available && maximum > 0 ? Math.max(8, (value / maximum) * 100) : 0;
  const label = available
    ? `${formatHourRange(hour)}: median ${formatOvernightEnergy(value)} across ${formatInteger(samples)} complete overnight windows.`
    : `${formatHourRange(hour)}: no complete overnight measurements.`;
  return `
    <button type="button" class="overnight-hour ${hour === selectedHour ? "is-selected" : ""}" role="radio" data-overnight-hour="${hour}" data-overnight-value="${available ? value : ""}" data-overnight-samples="${samples}" aria-checked="${hour === selectedHour}" tabindex="${hour === selectedHour ? 0 : -1}" aria-label="${label}" ${available ? "" : "disabled"}>
      <span class="overnight-hour-label">${String(hour).padStart(2, "0")}</span>
      <span class="overnight-hour-bar-wrap" aria-hidden="true"><i style="height:${height.toFixed(2)}%"></i></span>
      <strong>${available ? formatOvernightEnergy(value) : "-"}</strong>
    </button>`;
}

function renderOvernightMonth(group, maximum) {
  const monthLabel = group.month ? LONG_MONTHS[group.month - 1] : "Selected period";
  const value = group.medianOvernight;
  const width = value != null && maximum > 0 ? Math.max(4, (value / maximum) * 100) : 0;
  return `
    <div class="overnight-month-row">
      <span><strong>${monthLabel}</strong><small>${formatInteger(group.sampleDays)} ${group.sampleDays === 1 ? "window" : "windows"}</small></span>
      <span class="overnight-month-track" aria-label="${monthLabel}: ${value == null ? "no complete overnight windows" : `median ${formatOvernightEnergy(value)}`}"><i style="width:${width.toFixed(2)}%"></i></span>
      <strong>${formatOvernightEnergy(value)}</strong>
    </div>`;
}

function renderOvernightReadout(overnight, hour) {
  const value = overnight.hourlyMedians[hour];
  if (!Number.isFinite(value)) {
    elements.overnightReadout.textContent = `${formatHourRange(hour)}: no complete overnight measurements.`;
    return;
  }
  elements.overnightReadout.textContent = `${formatHourRange(hour)}: median ${formatOvernightEnergy(value)} of observed grid import across ${formatInteger(overnight.sampleDays)} complete DST-normalized overnight windows.`;
}

function selectOvernightHour(button) {
  if (!button || button.disabled) return;
  const hour = Number(button.dataset.overnightHour);
  state.overnightHour = hour;
  elements.overnightProfile.querySelector(".overnight-hour.is-selected")?.classList.remove("is-selected");
  elements.overnightProfile.querySelector(".overnight-hour[aria-checked=\"true\"]")?.setAttribute("aria-checked", "false");
  elements.overnightProfile.querySelectorAll(".overnight-hour").forEach((element) => { element.tabIndex = -1; });
  button.classList.add("is-selected");
  button.setAttribute("aria-checked", "true");
  button.tabIndex = 0;
  const value = Number(button.dataset.overnightValue);
  const samples = Number(button.dataset.overnightSamples);
  elements.overnightReadout.textContent = `${formatHourRange(hour)}: median ${formatOvernightEnergy(value)} of observed grid import across ${formatInteger(samples)} complete DST-normalized overnight windows.`;
}

function getOvernightGroups(rows) {
  return state.view === "year"
    ? unique(rows.map((record) => record.month)).map((month) => ({
      month,
      rows: rows.filter((record) => record.month === month)
    }))
    : [{ month: rows[0]?.month, rows }];
}

function formatOvernightEnergy(value) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} MWh`;
  return `${value < 1 ? value.toFixed(2) : value.toFixed(1)} kWh`;
}

function renderGridPeakTiming(rows, focusMetric = null) {
  const isDay = state.view === "day";
  elements.peakTimingTitle.textContent = isDay
    ? "Recurring daily peak timing"
    : state.peakTimingMetric === "export"
      ? "When daily export peaks occur"
      : "When daily import peaks occur";

  if (isDay) {
    elements.peakTimingSubtitle.textContent = "Choose a month or year to compare recurring daily grid peaks.";
    elements.peakTimingControls.hidden = true;
    elements.peakTimingLegend.hidden = true;
    elements.peakTimingReadout.hidden = true;
    renderPeakTimingEmpty("A single day shows its full 15-minute profile above; this view compares daily peak timing across multiple days.");
    return;
  }

  const groups = getGridPeakTimingGroups(rows);
  const heatmap = buildGridPeakTimingHeatmap(groups, state.peakTimingMetric);
  const metricLabel = heatmap.metric === "export" ? "export" : "import";
  elements.peakTimingSection.classList.toggle("is-import", heatmap.metric === "import");
  elements.peakTimingSection.classList.toggle("is-export", heatmap.metric === "export");
  elements.peakTimingControls.hidden = false;
  elements.peakTimingControls.innerHTML = [
    { id: "import", label: "Import peaks" },
    { id: "export", label: "Export peaks" }
  ].map((metric) => `
    <button type="button" class="peak-timing-control" role="radio" data-peak-timing-metric="${metric.id}" aria-checked="${heatmap.metric === metric.id}" tabindex="${heatmap.metric === metric.id ? 0 : -1}">${metric.label}</button>`).join("");
  if (focusMetric) {
    elements.peakTimingControls.querySelector(`[data-peak-timing-metric="${heatmap.metric}"]`)?.focus();
  }

  if (!heatmap.sampleDays) {
    elements.peakTimingSubtitle.textContent = "No complete 15-minute grid profiles are available in this selection.";
    elements.peakTimingLegend.hidden = true;
    elements.peakTimingReadout.hidden = true;
    renderPeakTimingEmpty("Complete grid interval data is needed to compare when daily peaks occur.");
    return;
  }

  if (!heatmap.peakDays) {
    elements.peakTimingSubtitle.textContent = `${formatInteger(heatmap.sampleDays)} complete grid profiles were available, but none had positive ${metricLabel}.`;
    elements.peakTimingLegend.hidden = true;
    elements.peakTimingReadout.hidden = true;
    renderPeakTimingEmpty(`No positive daily ${metricLabel} peaks were measured in this selection.`);
    return;
  }

  const peakLabel = `${LONG_MONTHS[heatmap.peak.month - 1]}, ${formatHourRange(heatmap.peak.hour)} on ${formatPercent(heatmap.peak.share)} of daily ${metricLabel} peaks`;
  const coverage = heatmap.latestIso ? ` through ${formatShortDate(heatmap.latestIso)}` : "";
  elements.peakTimingSubtitle.textContent = `${formatInteger(heatmap.sampleDays)} complete profiles${coverage}; ${formatInteger(heatmap.peakDays)} had positive daily ${metricLabel}. Tied daily maxima share one day evenly. Strongest recurring timing: ${peakLabel}.`;
  elements.peakTimingLegend.hidden = false;
  elements.peakTimingLegend.innerHTML = `
    <span>Share of positive daily ${metricLabel} peaks</span>
    <span>Low</span><span class="peak-timing-legend-scale" aria-hidden="true"></span><strong>${formatPercent(heatmap.maxShare)}</strong>
    <span class="peak-timing-legend-marker" aria-hidden="true">&#8226;</span><span>At least one daily peak</span>`;
  elements.peakTimingReadout.hidden = false;

  const selectedKey = validPeakTimingCellKey(heatmap, state.peakTimingCell)
    ? state.peakTimingCell
    : `${heatmap.metric}:${heatmap.peak.month}:${heatmap.peak.hour}`;
  state.peakTimingCell = selectedKey;
  const header = Array.from({ length: 24 }, (_, hour) => `
    <span class="peak-timing-hour-label ${hour % 3 ? "is-muted" : ""}" role="columnheader" aria-label="${formatHourRange(hour)}">${hour % 3 ? "" : String(hour).padStart(2, "0")}</span>`).join("");
  const heatmapRows = heatmap.rows.map((row) => {
    const monthLabel = LONG_MONTHS[row.month - 1];
    const cells = row.cells.map((cell) => {
      const key = `${heatmap.metric}:${row.month}:${cell.hour}`;
      const hasPeak = cell.weight > 0;
      const label = peakTimingCellLabel(metricLabel, monthLabel, cell, row.peakDays);
      const isSelected = key === selectedKey;
      const isPeak = heatmap.peak.month === row.month && heatmap.peak.hour === cell.hour;
      const intensity = heatmap.maxShare ? cell.share / heatmap.maxShare : 0;
      return `
        <span role="cell">
          <button type="button" class="peak-timing-cell ${hasPeak ? "" : "is-empty"} ${isSelected ? "is-selected" : ""} ${isPeak ? "is-peak" : ""}" style="--heat:${intensity.toFixed(3)}" data-peak-timing-metric="${heatmap.metric}" data-peak-timing-month="${row.month}" data-peak-timing-hour="${cell.hour}" data-peak-timing-share="${cell.share}" data-peak-timing-weight="${cell.weight}" data-peak-timing-days="${row.peakDays}" aria-label="${label}" title="${label}">${hasPeak ? "&#8226;" : ""}</button>
        </span>`;
    }).join("");
    return `
      <div class="peak-timing-row" role="row">
        <span class="peak-timing-row-label" role="rowheader"><strong>${monthLabel}</strong><small>${formatInteger(row.peakDays)} ${row.peakDays === 1 ? "peak day" : "peak days"}</small></span>
        ${cells}
      </div>`;
  }).join("");
  elements.peakTiming.innerHTML = `
    <div class="peak-timing-scroll" tabindex="0" aria-label="Scroll horizontally to view all hours">
      <div class="peak-timing-grid peak-timing-heatmap is-${heatmap.metric}" role="table" aria-label="Daily ${metricLabel} peak timing by month">
        <div class="peak-timing-row peak-timing-header" role="row">
          <span class="peak-timing-row-label" role="columnheader">Month</span>
          ${header}
        </div>
        ${heatmapRows}
      </div>
    </div>`;
  const selected = elements.peakTiming.querySelector(`[data-peak-timing-metric="${heatmap.metric}"][data-peak-timing-month="${selectedKey.split(":")[1]}"][data-peak-timing-hour="${selectedKey.split(":")[2]}"]`)
    || elements.peakTiming.querySelector(`[data-peak-timing-metric="${heatmap.metric}"][data-peak-timing-month="${heatmap.peak.month}"][data-peak-timing-hour="${heatmap.peak.hour}"]`);
  if (selected) selectPeakTimingCell(selected);
}

function renderPeakTimingEmpty(message) {
  elements.peakTiming.innerHTML = `
    <div class="peak-timing-empty"><i data-lucide="clock-alert" aria-hidden="true"></i><span>${message}</span></div>`;
}

function getGridPeakTimingGroups(rows) {
  return state.view === "year"
    ? unique(rows.map((record) => record.month)).map((month) => ({
      month,
      rows: rows.filter((record) => record.month === month)
    }))
    : [{ month: rows[0]?.month, rows }];
}

function selectPeakTimingMetric(metric) {
  if (!["import", "export"].includes(metric)) return;
  state.peakTimingMetric = metric;
  state.peakTimingCell = null;
  renderGridPeakTiming(getPeriodRows(), metric);
  if (window.lucide) window.lucide.createIcons();
}

function selectPeakTimingCell(cell) {
  elements.peakTiming.querySelector(".peak-timing-cell.is-selected")?.classList.remove("is-selected");
  cell.classList.add("is-selected");
  state.peakTimingCell = `${cell.dataset.peakTimingMetric}:${cell.dataset.peakTimingMonth}:${cell.dataset.peakTimingHour}`;
  elements.peakTimingReadout.textContent = peakTimingCellReadout(cell);
}

function validPeakTimingCellKey(heatmap, key) {
  if (typeof key !== "string") return false;
  const [metric, monthText, hourText] = key.split(":");
  const month = Number(monthText);
  const hour = Number(hourText);
  return metric === heatmap.metric
    && heatmap.rows.some((row) => row.month === month && row.cells[hour]?.weight > 0);
}

function peakTimingCellReadout(cell) {
  const metric = cell.dataset.peakTimingMetric;
  const month = Number(cell.dataset.peakTimingMonth);
  const hour = Number(cell.dataset.peakTimingHour);
  const share = Number(cell.dataset.peakTimingShare);
  const weight = Number(cell.dataset.peakTimingWeight);
  const peakDays = Number(cell.dataset.peakTimingDays);
  const metricLabel = metric === "export" ? "export" : "import";
  if (!weight) return `${LONG_MONTHS[month - 1]}, ${formatHourRange(hour)}: no daily ${metricLabel} peaks occurred at this hour.`;
  return `${LONG_MONTHS[month - 1]}, ${formatHourRange(hour)}: ${formatPercent(share)} of positive daily ${metricLabel} peaks (${weight.toFixed(weight % 1 ? 1 : 0)} weighted ${weight === 1 ? "day" : "days"} across ${formatInteger(peakDays)} peak days).`;
}

function peakTimingCellLabel(metricLabel, monthLabel, cell, peakDays) {
  if (!cell.weight) return `${monthLabel}, ${formatHourRange(cell.hour)}: no daily ${metricLabel} peaks occurred at this hour.`;
  return `${monthLabel}, ${formatHourRange(cell.hour)}: ${formatPercent(cell.share)} of positive daily ${metricLabel} peaks (${cell.weight.toFixed(cell.weight % 1 ? 1 : 0)} weighted ${cell.weight === 1 ? "day" : "days"} across ${formatInteger(peakDays)} peak days).`;
}

function renderInsights(rows, aggregate, solarWindow) {
  const insights = [];

  if (solarWindow) {
    insights.push({
      icon: "clock-3",
      tone: "amber",
      label: "Best time for flexible loads",
      title: `${solarWindow.startLabel} - ${solarWindow.endLabel}`,
      text: state.view === "day"
        ? "This was the strongest observed two-hour solar and surplus window."
        : `This typical window uses the median shape of ${solarWindow.sampleDays} solar profiles.`
    });
  }

  if (aggregate.commonDays) {
    if (aggregate.selfConsumption < 35 && aggregate.gridExport > 0) {
      insights.push({
        icon: "washing-machine",
        tone: "green",
        label: "Load-shifting opportunity",
        title: `${formatEnergy(aggregate.gridExport)} exported`,
        text: `Only ${formatPercent(aggregate.selfConsumption)} of solar was used directly. Move laundry, dishwashing, water heating, or EV charging into the solar window where practical.`
      });
    } else {
      insights.push({
        icon: "circle-gauge",
        tone: "green",
        label: "Solar use at home",
        title: `${formatPercent(aggregate.selfConsumption)} self-consumed`,
        text: `${formatEnergy(aggregate.selfUsedSolar)} of generated solar was used on site.`
      });
    }

    const offsetShare = safePercent(aggregate.sameDayShiftCeiling, aggregate.gridImport);
    insights.push({
      icon: "battery-charging",
      tone: "blue",
      label: "Storage scenario ceiling",
      title: `${formatEnergy(aggregate.sameDayShiftCeiling)} same-day overlap`,
      text: offsetShare == null
        ? "There was no measured grid import to offset."
        : `At most ${formatPercent(offsetShare)} of import overlapped export on the same dates. This is an unconstrained upper bound, not expected battery savings.`
    });
  }

  const bestProduction = [...rows].sort((left, right) => right.production - left.production)[0];
  if (bestProduction && rows.length > 1) {
    insights.push({
      icon: "trophy",
      tone: "coral",
      label: "Strongest solar day",
      title: `${formatShortDate(bestProduction.iso)} / ${formatEnergy(bestProduction.production)}`,
      text: bestProduction.anomaly
        ? "The source anomaly detector flagged this record, so compare it with nearby days."
        : "Use this day as a reference for the system's observed high-output range.",
      date: bestProduction.iso
    });
  }

  const weatherInsight = calculateWeatherInsight(rows);
  if (weatherInsight) insights.push(weatherInsight);

  elements.insightGrid.innerHTML = insights.slice(0, 4).map((insight) => `
    <article class="insight-item insight-${insight.tone}" ${insight.date ? `data-date="${insight.date}"` : ""}>
      <span class="insight-icon" aria-hidden="true"><i data-lucide="${insight.icon}"></i></span>
      <div>
        <span class="insight-label">${insight.label}</span>
        <strong>${insight.title}</strong>
        <p>${insight.text}</p>
      </div>
    </article>`).join("");
}

function calculateWeatherInsight(rows) {
  const weatherRows = rows.filter((record) => (
    record.weatherFinal
    && record.weather.prcp != null
    && Number.isFinite(Number(record.weather.prcp))
  ));
  const wet = weatherRows.filter((record) => Number(record.weather.prcp) >= 1);
  const dry = weatherRows.filter((record) => Number(record.weather.prcp) === 0);
  if (wet.length < 3 || dry.length < 3) return null;
  const wetAverage = sum(wet.map((record) => record.production)) / wet.length;
  const dryAverage = sum(dry.map((record) => record.production)) / dry.length;
  const difference = dryAverage - wetAverage;
  return {
    icon: "cloud-rain",
    tone: "slate",
    label: "Weather pattern",
    title: `${formatEnergy(Math.abs(difference))} ${difference >= 0 ? "more" : "less"} on dry days`,
    text: `Dry-day solar averaged ${formatEnergy(dryAverage)} versus ${formatEnergy(wetAverage)} on days with at least 1 mm precipitation.`
  };
}

function renderDailyArchetypes(rows, focusFilterId = null) {
  const isDay = state.view === "day";
  elements.dailyArchetypeSection.hidden = isDay;
  if (isDay) return;

  const archetypes = buildDailyArchetypes(rows);
  const availableCategories = DAILY_ARCHETYPE_ORDER.filter((category) => (
    dailyArchetypeFilterCount(archetypes, category) > 0
  ));
  if (state.archetypeFilter !== "all" && !availableCategories.includes(state.archetypeFilter)) {
    state.archetypeFilter = "all";
  }

  const periodLabel = state.view === "month" ? "selected month" : "selected year";
  elements.dailyArchetypeTitle.textContent = state.view === "month"
    ? "How daily energy behaved this month"
    : "How daily energy behaved across the year";
  const coverage = archetypes.latestGridIso
    ? `Complete grid days through ${formatShortDate(archetypes.latestGridIso)}.`
    : "No complete grid days are available.";
  const categoryMethod = !archetypes.completeDays
    ? "Only incomplete grid days are available, so no relative pattern can be calculated."
    : archetypes.hasSufficientReferenceDays
      ? `High-use days are the highest quarter of ${formatInteger(archetypes.referenceDays)} non-flagged complete days. Solar-surplus and grid-heavy days are the highest quarter of matching net-export or net-import days; anomaly flags take precedence.`
      : `Relative labels need at least ${DAILY_ARCHETYPE_MIN_REFERENCE_DAYS} non-flagged complete grid days; ${formatInteger(archetypes.referenceDays)} are available. Anomaly flags and incomplete grid coverage remain marked.`;
  elements.dailyArchetypeSubtitle.textContent = `${coverage} ${categoryMethod}`;

  const filters = [
    {
      id: "all",
      label: "All days",
      count: archetypes.days.length,
      icon: "calendar-days",
      tone: "all"
    },
    ...availableCategories.map((category) => ({
      id: category,
      count: dailyArchetypeFilterCount(archetypes, category),
      ...DAILY_ARCHETYPES[category]
    }))
  ];
  elements.dailyArchetypeFilters.innerHTML = filters.map((filter) => `
    <button type="button" class="daily-archetype-filter is-${filter.tone} ${state.archetypeFilter === filter.id ? "is-active" : ""}" data-archetype-filter="${filter.id}" aria-pressed="${state.archetypeFilter === filter.id}">
      <i data-lucide="${filter.icon}" aria-hidden="true"></i>
      <span>${filter.label}</span>
      <small>${formatInteger(filter.count)}</small>
    </button>`).join("");

  if (state.archetypeFilter === "all") {
    const incompleteNote = archetypes.incompleteDays
      ? ` ${formatInteger(archetypes.incompleteDays)} ${archetypes.incompleteDays === 1 ? "day has" : "days have"} incomplete grid data.`
      : "";
    elements.dailyArchetypeSummary.textContent = `${formatInteger(archetypes.days.length)} days are shown for the ${periodLabel}. Tile letters match the patterns above; a ? marks incomplete grid data. Select a pattern to emphasize matching days, then select a tile for detail.${incompleteNote}`;
  } else {
    const selected = DAILY_ARCHETYPES[state.archetypeFilter];
    const filterCount = dailyArchetypeFilterCount(archetypes, state.archetypeFilter);
    elements.dailyArchetypeSummary.textContent = `${formatInteger(filterCount)} ${selected.label.toLowerCase()} ${filterCount === 1 ? "day is" : "days are"} emphasized; nonmatching days remain muted for context. Select a tile for detail.`;
  }

  const header = Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;
    return `<span class="daily-archetype-day-label ${day % 5 ? "is-muted" : ""}" role="columnheader" aria-label="Day ${day}">${day % 5 ? "" : day}</span>`;
  }).join("");
  const timelineRows = getDailyArchetypeGroups(archetypes.days).map((group) => {
    const monthLabel = LONG_MONTHS[group.month - 1];
    const byDay = new Map(group.days.map((day) => [day.day, day]));
    const cells = Array.from({ length: 31 }, (_, index) => {
      const day = byDay.get(index + 1);
      if (!day) return `<span class="daily-archetype-blank" aria-hidden="true"></span>`;

      const config = DAILY_ARCHETYPES[day.category];
      const dimmed = !dailyArchetypeMatchesFilter(day, state.archetypeFilter);
      const label = dailyArchetypeDayLabel(day, config);
      const coverageMarker = day.gridIncomplete && day.category !== "incomplete"
        ? `<span class="daily-archetype-coverage-marker" aria-hidden="true">?</span>`
        : "";
      return `
        <span role="cell">
          <button type="button" class="daily-archetype-tile is-${config.tone} ${day.gridIncomplete ? "is-grid-incomplete" : ""} ${dimmed ? "is-dimmed" : ""}" data-date="${day.iso}" aria-label="${label}" title="${label}"><span class="daily-archetype-marker" aria-hidden="true">${config.marker}</span>${coverageMarker}</button>
        </span>`;
    }).join("");
    return `
      <div class="daily-archetype-row" role="row">
        <span class="daily-archetype-row-label" role="rowheader"><strong>${monthLabel}</strong><small>${formatInteger(group.days.length)} ${group.days.length === 1 ? "day" : "days"}</small></span>
        ${cells}
      </div>`;
  }).join("");
  elements.dailyArchetypeTimeline.innerHTML = `
    <div class="daily-archetype-scroll" tabindex="0" aria-label="Scroll horizontally to view all days">
      <div class="daily-archetype-grid" role="table" aria-label="Daily observed energy patterns by month">
        <div class="daily-archetype-row daily-archetype-header" role="row">
          <span class="daily-archetype-row-label" role="columnheader">Month</span>
          ${header}
        </div>
        ${timelineRows}
      </div>
    </div>`;
  if (focusFilterId) {
    elements.dailyArchetypeFilters.querySelector(
      `[data-archetype-filter="${state.archetypeFilter}"]`
    )?.focus();
  }
}

function getDailyArchetypeGroups(days) {
  return unique(days.map((day) => day.month)).map((month) => ({
    month,
    days: days.filter((day) => day.month === month)
  }));
}

function dailyArchetypeDayLabel(day, config) {
  const date = parseIsoDate(day.iso);
  const dateLabel = date ? formatLongDate(date) : day.iso;
  const incompleteNote = day.gridIncomplete && day.category !== "incomplete"
    ? " Grid data is incomplete."
    : "";
  return `${dateLabel}: ${config.label}. ${config.description}${incompleteNote}`;
}

function dailyArchetypeFilterCount(archetypes, filter) {
  return filter === "incomplete" ? archetypes.incompleteDays : archetypes.counts[filter];
}

function dailyArchetypeMatchesFilter(day, filter) {
  if (filter === "all") return true;
  if (filter === "incomplete") return day.gridIncomplete;
  return day.category === filter;
}

function renderSurplusHeatmap(rows) {
  const isDay = state.view === "day";
  elements.surplusHeatmapTitle.textContent = isDay
    ? "Recurring surplus by hour"
    : state.view === "month"
      ? "Typical surplus by hour"
      : "Typical surplus by month and hour";

  if (isDay) {
    elements.surplusHeatmapSubtitle.textContent = "Choose a month or year to compare recurring grid-export timing.";
    elements.surplusHeatmapLegend.hidden = true;
    elements.surplusHeatmapSelection.hidden = true;
    renderSurplusHeatmapEmpty("A single day shows its detailed profile above; this view summarizes recurring patterns.");
    return;
  }

  const heatmap = buildSurplusHeatmap(getSurplusHeatmapGroups(rows));
  if (!heatmap.sampleDays) {
    elements.surplusHeatmapSubtitle.textContent = "No complete 15-minute grid-export profiles are available in this selection.";
    elements.surplusHeatmapLegend.hidden = true;
    elements.surplusHeatmapSelection.hidden = true;
    renderSurplusHeatmapEmpty("Complete grid interval data is needed to show when energy typically reaches the grid.");
    return;
  }

  if (heatmap.maxValue <= 0) {
    elements.surplusHeatmapSubtitle.textContent = `${formatInteger(heatmap.sampleDays)} complete grid profiles were available, but none recorded grid export.`;
    elements.surplusHeatmapLegend.hidden = true;
    elements.surplusHeatmapSelection.hidden = true;
    renderSurplusHeatmapEmpty("No surplus was measured flowing to the grid in this selection.");
    return;
  }

  const periodLabel = state.view === "month" ? "selected month" : "selected year";
  const peakLabel = `${LONG_MONTHS[heatmap.peak.month - 1]}, ${formatHourRange(heatmap.peak.hour)}: ${formatHourlyEnergy(heatmap.peak.value)}`;
  const coverageLabel = heatmap.latestIso
    ? `Grid profiles through ${formatShortDate(heatmap.latestIso)}.`
    : "Grid profile coverage date unavailable.";
  elements.surplusHeatmapSubtitle.textContent = `${formatInteger(heatmap.sampleDays)} complete daily profiles in the ${periodLabel}. ${coverageLabel} Darker cells show more median grid export; the strongest typical hour is ${peakLabel}.`;
  elements.surplusHeatmapLegend.hidden = false;
  elements.surplusHeatmapLegend.setAttribute(
    "aria-label",
    `Median hourly grid export scale from zero to ${formatHourlyEnergy(heatmap.maxValue)}.`
  );
  elements.surplusHeatmapMax.textContent = formatHourlyEnergy(heatmap.maxValue);
  elements.surplusHeatmapSelection.hidden = false;
  elements.surplusHeatmapSelection.textContent = "Select or focus an hour to inspect its median grid export.";

  const header = Array.from({ length: 24 }, (_, hour) => `
    <span class="surplus-hour-label ${hour % 3 ? "is-muted" : ""}" role="columnheader" aria-label="${formatHourRange(hour)}">
      ${hour % 3 ? "" : String(hour).padStart(2, "0")}
    </span>`).join("");
  const heatmapRows = heatmap.rows.map((row) => {
    const monthLabel = row.month ? LONG_MONTHS[row.month - 1] : "Selected period";
    const cells = row.cells.map((cell, hour) => {
      const intensity = cell.value == null ? 0 : cell.value / heatmap.maxValue;
      const isPeak = heatmap.peak.month === row.month && heatmap.peak.hour === hour;
      const label = cell.value == null
        ? `${monthLabel}, ${formatHourRange(hour)}: no complete grid export samples.`
        : `${monthLabel}, ${formatHourRange(hour)}: ${formatHourlyEnergy(cell.value)} median grid export from ${formatInteger(cell.samples)} ${cell.samples === 1 ? "day" : "days"}.`;
      return `
        <span role="cell">
          <button type="button" class="surplus-heatmap-cell ${cell.value == null ? "is-unavailable" : ""} ${isPeak ? "is-peak" : ""}" style="--heat:${intensity.toFixed(3)}" data-surplus-month="${row.month}" data-surplus-hour="${hour}" data-surplus-value="${cell.value ?? ""}" data-surplus-samples="${cell.samples}" aria-label="${label}" title="${label}"></button>
        </span>`;
    }).join("");
    return `
      <div class="surplus-heatmap-row" role="row">
        <span class="surplus-heatmap-row-label" role="rowheader">
          <strong>${monthLabel}</strong>
          <small>${formatInteger(row.sampleDays)} ${row.sampleDays === 1 ? "day" : "days"}</small>
        </span>
        ${cells}
      </div>`;
  }).join("");

  elements.surplusHeatmap.innerHTML = `
    <div class="surplus-heatmap-scroll" tabindex="0" aria-label="Scroll horizontally to view all hours">
      <div class="surplus-heatmap-grid" role="table" aria-label="Typical hourly grid export by month">
        <div class="surplus-heatmap-row surplus-heatmap-header" role="row">
          <span class="surplus-heatmap-row-label" role="columnheader">Month</span>
          ${header}
        </div>
        ${heatmapRows}
      </div>
    </div>`;
}

function selectSurplusHeatmapCell(cell) {
  elements.surplusHeatmap.querySelector(".surplus-heatmap-cell.is-selected")?.classList.remove("is-selected");
  cell.classList.add("is-selected");
  elements.surplusHeatmapSelection.textContent = surplusHeatmapCellLabel(cell);
}

function surplusHeatmapCellLabel(cell) {
  const month = Number(cell.dataset.surplusMonth);
  const hour = Number(cell.dataset.surplusHour);
  const samples = Number(cell.dataset.surplusSamples);
  const value = cell.dataset.surplusValue === "" ? null : Number(cell.dataset.surplusValue);
  const monthLabel = LONG_MONTHS[month - 1] || "Selected period";
  const hourLabel = formatHourRange(hour);
  if (!Number.isFinite(value)) return `${monthLabel}, ${hourLabel}: no complete grid export samples.`;
  return `${monthLabel}, ${hourLabel}: ${formatHourlyEnergy(value)} median grid export from ${formatInteger(samples)} ${samples === 1 ? "day" : "days"}.`;
}

function renderSurplusHeatmapEmpty(message) {
  elements.surplusHeatmap.innerHTML = `
    <div class="surplus-heatmap-empty">
      <i data-lucide="grid-2x2" aria-hidden="true"></i>
      <span>${message}</span>
    </div>`;
}

function getSurplusHeatmapGroups(rows) {
  return state.view === "year"
    ? unique(rows.map((record) => record.month)).map((month) => ({
      month,
      rows: rows.filter((record) => record.month === month)
    }))
    : [{ month: rows[0]?.month, rows }];
}

function formatHourlyEnergy(value) {
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: value < 0.1 ? 2 : 1,
    maximumFractionDigits: value < 0.1 ? 2 : 1
  })} kWh`;
}

function renderCalendar(rows) {
  elements.calendarSection.hidden = state.view !== "month";
  if (state.view !== "month") return;

  const anchor = parseIsoDate(state.anchor);
  elements.calendarTitle.textContent = `${LONG_MONTHS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()} at a glance`;
  const firstWeekday = (new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)).getUTCDay() + 6) % 7;
  const metric = elements.calendarMetric.value;
  const values = rows.map((record) => calendarMetricValue(record, metric)).filter(Number.isFinite);
  const max = Math.max(...values, 1);
  const weekdayHeaders = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map((day) => `<div class="calendar-weekday">${day}</div>`)
    .join("");
  const blanks = Array.from({ length: firstWeekday }, () => `<span class="calendar-blank" aria-hidden="true"></span>`).join("");
  const days = rows.map((record) => {
    const value = calendarMetricValue(record, metric);
    const intensity = value == null ? 0 : Math.max(0.08, Math.min(1, Math.abs(value) / max));
    const label = calendarMetricLabel(value, metric);
    const tone = metric === "net" && value < 0 ? "is-export" : "";
    return `
      <button class="calendar-day ${tone}" data-date="${record.iso}" style="--heat:${intensity}" aria-label="${formatLongDate(record.date)}: ${label}">
        <span class="calendar-date">${record.day}</span>
        <strong>${label}</strong>
        <span class="calendar-flags">
          ${record.anomaly ? `<i data-lucide="triangle-alert" aria-label="Anomaly flagged"></i>` : ""}
          ${record.evChargingDay ? `<i data-lucide="car-front" aria-label="EV charging day"></i>` : ""}
          ${!record.hasGrid ? `<i data-lucide="cloud-off" aria-label="Grid data unavailable"></i>` : ""}
        </span>
      </button>`;
  }).join("");

  elements.calendarGrid.innerHTML = weekdayHeaders + blanks + days;
}

function calendarMetricValue(record, metric) {
  if (metric === "production") return record.production;
  if (!record.hasGrid) return null;
  if (metric === "consumption") return record.householdUse;
  if (metric === "export") return record.gridExport;
  if (metric === "selfSufficiency") return safePercent(record.selfUsedSolar, record.householdUse);
  if (metric === "net") return record.gridImport - record.gridExport;
  return null;
}

function calendarMetricLabel(value, metric) {
  if (value == null) return "No grid";
  if (metric === "selfSufficiency") return formatPercent(value, 0);
  if (metric === "net") return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(1)}`;
  return `${value.toFixed(1)} kWh`;
}

function renderRankings(rows) {
  elements.rankingSection.hidden = state.view === "day" || rows.length < 2;
  if (elements.rankingSection.hidden) return;

  const candidates = [...rows]
    .filter((record) => Number.isFinite(record.production))
    .sort((left, right) => right.production - left.production)
    .slice(0, 6);

  elements.rankingList.innerHTML = candidates.map((record, index) => `
    <button class="ranking-row" data-date="${record.iso}">
      <span class="ranking-position">${String(index + 1).padStart(2, "0")}</span>
      <span class="ranking-date">${formatShortDate(record.iso)}</span>
      <span class="ranking-bar"><span style="width:${Math.min(100, (record.production / candidates[0].production) * 100)}%"></span></span>
      <strong>${formatEnergy(record.production)}</strong>
      ${record.anomaly ? `<i data-lucide="triangle-alert" aria-label="Anomaly flagged"></i>` : `<i data-lucide="chevron-right" aria-hidden="true"></i>`}
    </button>`).join("");
}

function renderDayDetails(rows, solarWindow) {
  elements.dayDetailSection.hidden = state.view !== "day";
  if (state.view !== "day") return;
  const record = rows[0];
  if (!record) return;

  elements.dayDetailTitle.textContent = formatLongDate(record.date);
  const flags = [];
  if (record.evChargingDay) flags.push("EV charging session marked");
  if (record.anomaly) flags.push("Source anomaly flag");
  if (!record.solarFinal) flags.push("Solar provisional");
  if (record.supplementedGrid) flags.push("Grid from Fluvius export");
  if (!record.hasGrid) flags.push("Grid unavailable");
  elements.dayDetailMeta.textContent = flags.length ? flags.join(" / ") : "Complete daily record";

  const sunrise = extractClock(record.sunrise);
  const sunset = extractClock(record.sunset);
  const daylight = sunrise && sunset ? (clockToMinutes(sunset) - clockToMinutes(sunrise)) / 60 : null;
  const gas = record.intervals.gas.length ? sum(record.intervals.gas) : null;
  const temperature = finiteNumber(record.weather.tavg);
  const precipitation = finiteNumber(record.weather.prcp);
  const peakSolar = record.intervals.solar.length ? Math.max(...record.intervals.solar) : null;
  const peakSolarIndex = peakSolar == null ? null : record.intervals.solar.indexOf(peakSolar);
  const outliers = findIntervalOutliers(record);

  const facts = [
    { icon: "sunrise", label: "Daylight", value: sunrise && sunset ? `${sunrise} - ${sunset}` : "Unavailable", detail: daylight == null ? "" : `${daylight.toFixed(1)} hours` },
    { icon: "thermometer", label: "Average temperature", value: temperature == null ? "Unavailable" : `${temperature.toFixed(1)} C`, detail: precipitation == null ? "" : `${precipitation.toFixed(1)} mm rain` },
    { icon: "zap", label: "Peak solar power", value: peakSolar == null ? "Unavailable" : `${peakSolar.toFixed(2)} kW`, detail: peakSolarIndex == null ? "" : `at ${buildIntervalLabels(record.iso, record.intervals.solar.length)[peakSolarIndex]}` },
    { icon: "flame", label: "Gas energy", value: gas == null ? "Unavailable" : formatNumber(gas), detail: "provider unit" },
    { icon: "clock-3", label: "Best solar window", value: solarWindow ? `${solarWindow.startLabel} - ${solarWindow.endLabel}` : "Unavailable", detail: "historical observation" },
    { icon: "scan-line", label: "Interval count", value: String(Math.max(record.intervals.solar.length, record.intervals.import.length)), detail: record.intervals.import.length === 92 || record.intervals.import.length === 100 ? "daylight-saving day" : "15-minute samples" }
  ];

  elements.dayFacts.innerHTML = facts.map((fact) => `
    <div class="day-fact">
      <i data-lucide="${fact.icon}" aria-hidden="true"></i>
      <span>${fact.label}</span>
      <strong>${fact.value}</strong>
      <small>${fact.detail}</small>
    </div>`).join("");

  const qualityNotes = [];
  if (record.supplementedGrid) qualityNotes.push("Grid import and export use the sanitized Fluvius quarter-hour download.");
  if (record.repairedFromIntervals) qualityNotes.push("Daily grid summary replaced by complete interval totals.");
  if (record.anomaly) qualityNotes.push("The source detector flagged at least one daily metric as unusual.");
  if (outliers.length) qualityNotes.push(`${outliers.length} extreme interval ${outliers.length === 1 ? "value is" : "values are"} retained but excluded from automatic chart scaling: ${outliers.map((outlier) => `${outlier.label} ${outlier.value.toFixed(2)} kWh at ${outlier.time}`).join(", ")}.`);
  if (!record.hasGrid) qualityNotes.push("Only solar and weather information is available; household and grid metrics are omitted.");
  elements.dayQuality.hidden = qualityNotes.length === 0;
  elements.dayQuality.innerHTML = qualityNotes.map((note) => `<li>${note}</li>`).join("");
}

function findIntervalOutliers(record) {
  const result = [];
  [
    ["Import", record.intervals.import],
    ["Export", record.intervals.export]
  ].forEach(([label, values]) => {
    if (!values.length) return;
    const threshold = Math.max(4, percentile(values, 0.99) * 4);
    values.forEach((value, index) => {
      if (value > threshold) result.push({ label, value, time: buildIntervalLabels(record.iso, values.length)[index] });
    });
  });
  return result;
}

function renderHealth(rows, aggregate) {
  const issues = [];
  if (aggregate.gridDays < rows.length) issues.push(`${rows.length - aggregate.gridDays} days without grid measurements`);
  if (aggregate.provisionalSolarDays) issues.push(`${aggregate.provisionalSolarDays} provisional solar records`);
  if (aggregate.anomalyDays) issues.push(`${aggregate.anomalyDays} anomaly-flagged days`);
  if (aggregate.repairedDays) issues.push(`${aggregate.repairedDays} summaries repaired from intervals`);
  if (!issues.length) issues.push("No coverage issues in the selected period");

  elements.healthSummary.textContent = issues[0];
  elements.healthList.innerHTML = `
    <li><span>Solar coverage</span><strong>${aggregate.solarDays} / ${rows.length} days${aggregate.latestSolar ? ` through ${formatShortDate(aggregate.latestSolar)}` : ""}</strong></li>
    <li><span>Grid coverage</span><strong>${aggregate.gridDays} / ${rows.length} days${aggregate.latestGrid ? ` through ${formatShortDate(aggregate.latestGrid)}` : ""}</strong></li>
    <li><span>Fluvius restored days</span><strong>${aggregate.supplementedGridDays}</strong></li>
    <li><span>Interval repairs</span><strong>${aggregate.repairedDays}</strong></li>
    <li><span>Anomaly flags</span><strong>${aggregate.anomalyDays}</strong></li>
    <li><span>EV-marked days</span><strong>${aggregate.evDays}</strong></li>`;
}

function parseIsoDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return null;
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIsoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addUtcDays(date, amount) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + amount));
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
  }).format(date);
}

function formatShortDate(iso) {
  const date = parseIsoDate(iso);
  if (!date) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  }).format(date);
}

function formatEnergy(value) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  const absolute = Math.abs(value);
  if (absolute >= 1000) return `${(value / 1000).toFixed(2)} MWh`;
  if (absolute >= 100) return `${value.toFixed(0)} kWh`;
  return `${value.toFixed(1)} kWh`;
}

function formatPercent(value, digits = 1) {
  return value == null || !Number.isFinite(value) ? "Unavailable" : `${value.toFixed(digits)}%`;
}

function formatNumber(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatInteger(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function setLoading(loading) {
  elements.loadingState.hidden = !loading;
  elements.app.hidden = loading || Boolean(state.loadError);
}

function showLoadError(error) {
  elements.errorMessage.textContent = error?.message || "An unknown error occurred while loading the dashboard.";
  elements.errorState.hidden = false;
  elements.app.hidden = true;
}