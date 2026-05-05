import React, { useMemo, useRef, useState } from "react";

const STORAGE_KEY = "driver_hos_tracker_v6";
const ALL_DRIVERS = "All Drivers";

const MONTHS = {
  Jan: "01", January: "01", Feb: "02", February: "02", Mar: "03", March: "03",
  Apr: "04", April: "04", May: "05", Jun: "06", June: "06", Jul: "07", July: "07",
  Aug: "08", August: "08", Sep: "09", Sept: "09", September: "09", Oct: "10", October: "10",
  Nov: "11", November: "11", Dec: "12", December: "12",
};

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function createEntry(overrides = {}) {
  return {
    id: makeId(),
    driver: "",
    date: todayISO(),
    start: "",
    finish: "",
    totalHoursFromPdf: "",
    drivingHours: 0,
    breakMinutes: 0,
    isOff: false,
    notes: "",
    ...overrides,
  };
}

function parseTimeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return null;
  const [h, m] = value.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function hoursBetween(start, finish) {
  const startMins = parseTimeToMinutes(start);
  let finishMins = parseTimeToMinutes(finish);
  if (startMins === null || finishMins === null) return 0;
  if (finishMins < startMins) finishMins += 1440;
  return (finishMins - startMins) / 60;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatHours(value) {
  const safe = Math.max(0, Number(value) || 0);
  let h = Math.floor(safe);
  let m = Math.round((safe - h) * 60);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  return `${h}h ${m}m`;
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function detectHeader(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  const simple = clean.match(/^([A-Z][A-Za-z' -]+?)\s+(Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+(\d{4})/);
  if (simple) return { driver: simple[1].trim(), month: MONTHS[simple[2]], year: simple[3] };

  const form = clean.match(/Driver.?s Name \(print\)\s*([A-Z][A-Za-z' -]+?)\s+Employee No\..*?Month\s+([A-Za-z]+)\s+Year\s+(\d{4})/);
  if (form) return { driver: form[1].trim(), month: MONTHS[form[2]] || "01", year: form[3] };

  return { driver: "Imported Driver", month: "01", year: new Date().getFullYear().toString() };
}

function createOffEntry(header, day) {
  return createEntry({
    driver: header.driver,
    date: `${header.year}-${header.month}-${String(day).padStart(2, "0")}`,
    start: "",
    finish: "",
    totalHoursFromPdf: 0,
    drivingHours: 0,
    breakMinutes: 0,
    isOff: true,
    notes: "Imported as off-duty day.",
  });
}

function createDutyEntry(header, day, start, finish, total, driving, source = "PDF/text") {
  return createEntry({
    driver: header.driver,
    date: `${header.year}-${header.month}-${String(day).padStart(2, "0")}`,
    start,
    finish,
    totalHoursFromPdf: round2(Number(total)),
    drivingHours: round2(Number(driving)),
    breakMinutes: 0,
    isOff: false,
    notes: `Imported from ${source}.`,
  });
}

function parseRowsFromPlainText(text) {
  const header = detectHeader(text);
  const entries = [];
  const lines = String(text || "").split(/\n+/);
  let fallbackDay = 1;

  for (const raw of lines) {
    const line = raw.trim();

    const offMatch = line.match(/^(\d{1,2})\s+Off\b/i);
    if (offMatch) {
      entries.push(createOffEntry(header, Number(offMatch[1])));
      continue;
    }

    let match = line.match(/^(\d{1,2})\s+(\d{2}:\d{2})\s+(\d{2}:\d{2})\s+([\d.]+)\s+([\d.]+)/);
    let day;

    if (match) {
      day = Number(match[1]);
    } else {
      match = line.match(/(\d{2}:\d{2})\s+(\d{2}:\d{2})\s+([\d.]+)\s+([\d.]+)/);
      if (!match) continue;
      day = fallbackDay;
      fallbackDay += 1;
    }

    const offset = match.length === 6 ? 1 : 0;
    entries.push(createDutyEntry(
      header,
      day,
      match[1 + offset],
      match[2 + offset],
      match[3 + offset],
      match[4 + offset]
    ));
  }

  return entries;
}

function parseRowsFromPdfItems(pages) {
  const allEntries = [];

  for (const page of pages) {
    const items = page.items.map((item) => ({
      str: String(item.str || "").trim(),
      x: item.transform?.[4] || 0,
      y: item.transform?.[5] || 0,
    })).filter((item) => item.str);

    const pageText = items.map((item) => item.str).join(" ");
    const header = detectHeader(pageText);

    // Use the left Date column as the row anchor, then pull values from that same horizontal row.
    const dayMarkers = items
      .filter((item) => /^[0-9]{1,2}$/.test(item.str))
      .map((item) => ({ day: Number(item.str), x: item.x, y: item.y }))
      .filter((item) => item.day >= 1 && item.day <= 31 && item.x >= 20 && item.x <= 110 && item.y >= 60 && item.y <= 620)
      .sort((a, b) => a.day - b.day);

    const seenDays = new Set();

    for (const marker of dayMarkers) {
      if (seenDays.has(marker.day)) continue;

      let rowItems = [];
      for (const tolerance of [3, 5, 8, 12, 16, 22]) {
        rowItems = items
          .filter((item) => Math.abs(item.y - marker.y) <= tolerance)
          .filter((item) => item.x > marker.x + 15 && item.x < 470)
          .sort((a, b) => a.x - b.x);
        const rowText = rowItems.map((item) => item.str).join(" ").trim();
        if (/(^| )Off( |$)/i.test(rowText) || /[0-9]{2}:[0-9]{2}/.test(rowText)) break;
      }

      const rowText = rowItems.map((item) => item.str).join(" ").trim();

      if (/(^| )Off( |$)/i.test(rowText)) {
        allEntries.push(createOffEntry(header, marker.day));
        seenDays.add(marker.day);
        continue;
      }

      const times = rowText.match(/[0-9]{2}:[0-9]{2}/g) || [];
      const numbers = rowText.match(/[0-9]+[.][0-9]+/g) || [];

      if (times.length >= 2 && numbers.length >= 2) {
        allEntries.push(createDutyEntry(header, marker.day, times[0], times[1], numbers[0], numbers[1], "PDF"));
        seenDays.add(marker.day);
      }
    }
  }

  return allEntries;
}

function getDailyWarnings(entry) {
  if (entry.isOff) return [];

  const elapsed = hoursBetween(entry.start, entry.finish);
  const total = Number(entry.totalHoursFromPdf);
  const onDuty = total > 0 ? total : Math.max(0, elapsed - (Number(entry.breakMinutes) || 0) / 60);
  const driving = Number(entry.drivingHours) || 0;
  const warnings = [];

  if (!entry.driver.trim()) warnings.push("Driver name missing");
  if (elapsed > 14) warnings.push("Over 14-hour window");
  if (onDuty > 14) warnings.push("More than 14 on-duty hours recorded");
  if (driving > 11) warnings.push("Over 11 driving hours");
  if (driving > 8 && (Number(entry.breakMinutes) || 0) < 30) warnings.push("30-minute break may be required");
  if (driving > onDuty) warnings.push("Driving hours exceed on-duty hours");

  return warnings;
}

function calculateEntry(entry) {
  if (entry.isOff) {
    return {
      ...entry,
      start: "",
      finish: "",
      totalHoursFromPdf: 0,
      drivingHours: 0,
      elapsedHours: 0,
      onDutyHours: 0,
      remainingDriveToday: 11,
      remaining14HourWindow: 14,
      warnings: [],
    };
  }

  const elapsedHours = round2(hoursBetween(entry.start, entry.finish));
  const total = Number(entry.totalHoursFromPdf);
  const onDutyHours = round2(total > 0 ? total : Math.max(0, elapsedHours - (Number(entry.breakMinutes) || 0) / 60));
  const drivingHours = round2(Number(entry.drivingHours) || 0);

  return {
    ...entry,
    elapsedHours,
    onDutyHours,
    drivingHours,
    remainingDriveToday: round2(Math.max(0, 11 - drivingHours)),
    remaining14HourWindow: round2(Math.max(0, 14 - elapsedHours)),
    warnings: getDailyWarnings(entry),
  };
}

function keepCurrentHosTimeframe(imported, cycleDays) {
  const byDriver = new Map();
  for (const entry of imported) {
    const driver = entry.driver || "Imported Driver";
    if (!byDriver.has(driver)) byDriver.set(driver, []);
    byDriver.get(driver).push(entry);
  }

  const kept = [];
  for (const [, driverEntries] of byDriver) {
    const sorted = driverEntries.slice().sort((a, b) => a.date.localeCompare(b.date));
    const latestDate = sorted[sorted.length - 1]?.date;
    if (!latestDate) continue;
    const startDate = addDays(latestDate, -(cycleDays - 1));
    kept.push(...sorted.filter((entry) => entry.date >= startDate && entry.date <= latestDate));
  }

  return kept.sort((a, b) => `${a.driver}${a.date}`.localeCompare(`${b.driver}${b.date}`));
}

function getDateTimeHours(date, time, useEndOfDay = false) {
  if (!date) return null;
  if (!time && useEndOfDay) time = "23:59";
  if (!time) return null;
  const mins = parseTimeToMinutes(time);
  if (mins === null) return null;
  const base = new Date(`${date}T00:00:00`).getTime() / 3600000;
  return base + mins / 60;
}

function getDutyStartHours(entry) {
  if (entry.isOff) return null;
  return getDateTimeHours(entry.date, entry.start);
}

function getDutyFinishHours(entry) {
  if (entry.isOff) return null;
  const startMins = parseTimeToMinutes(entry.start);
  const finishMins = parseTimeToMinutes(entry.finish);
  if (startMins === null || finishMins === null) return null;
  let finishDate = entry.date;
  if (finishMins < startMins) finishDate = addDays(entry.date, 1);
  return getDateTimeHours(finishDate, entry.finish);
}

function hoursToDateString(hours) {
  return new Date(hours * 3600000).toISOString().slice(0, 10);
}

function applyRollingCycle(entries, cycleDays, cycleLimit) {
  const byDriver = new Map();
  for (const entry of entries) {
    const driver = entry.driver.trim() || "Unknown Driver";
    if (!byDriver.has(driver)) byDriver.set(driver, []);
    byDriver.get(driver).push(entry);
  }

  const output = [];

  for (const [, driverEntries] of byDriver) {
    const sorted = driverEntries.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
    const dailyTotals = new Map();

    for (const entry of sorted) {
      dailyTotals.set(entry.date, round2((dailyTotals.get(entry.date) || 0) + entry.onDutyHours));
    }

    const dates = Array.from(dailyTotals.keys()).sort();
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];

    if (firstDate && lastDate) {
      for (let d = firstDate; d <= lastDate; d = addDays(d, 1)) {
        if (!dailyTotals.has(d)) dailyTotals.set(d, 0);
        if (d === lastDate) break;
      }
    }

    const dutyEntries = sorted
      .filter((entry) => !entry.isOff)
      .map((entry) => ({ ...entry, startHours: getDutyStartHours(entry), finishHours: getDutyFinishHours(entry) }))
      .filter((entry) => entry.startHours !== null && entry.finishHours !== null)
      .sort((a, b) => a.startHours - b.startHours);

    const resetEvents = [];
    for (let i = 1; i < dutyEntries.length; i += 1) {
      const previous = dutyEntries[i - 1];
      const current = dutyEntries[i];
      const offDutyGap = current.startHours - previous.finishHours;
      if (offDutyGap >= 34) {
        resetEvents.push({
          restartDate: current.date,
          restartHours: current.startHours,
          offDutyGap: round2(offDutyGap),
          previousFinishDate: hoursToDateString(previous.finishHours),
          previousFinishTime: previous.finish,
          nextStartDate: current.date,
          nextStartTime: current.start,
        });
      }
    }

    for (const entry of sorted) {
      const entryPoint = entry.isOff ? getDateTimeHours(entry.date, "23:59") : getDutyStartHours(entry);
      const rollingStart = addDays(entry.date, -(cycleDays - 1));

      const resetInside = resetEvents
        .filter((reset) => reset.restartHours <= (entryPoint ?? Infinity) && reset.restartDate >= rollingStart && reset.restartDate <= entry.date)
        .sort((a, b) => a.restartHours - b.restartHours)
        .pop();

      // Only show the restart warning ON the actual restart day (not every row after)
      const isRestartRow = resetInside && entry.date === resetInside.restartDate;

      const effectiveStart = resetInside ? resetInside.restartDate : rollingStart;

      let used = 0;
      for (const [date, hours] of dailyTotals.entries()) {
        if (date >= effectiveStart && date <= entry.date) used += hours;
      }

      const remaining = round2(Math.max(0, cycleLimit - used));
      const cycleWarnings = [];
      if (used > cycleLimit) cycleWarnings.push(`Rolling ${cycleLimit}/${cycleDays} cycle exceeded by ${round2(used - cycleLimit)} hours`);
      if (remaining <= 2 && used <= cycleLimit && !entry.isOff) cycleWarnings.push(`Low cycle availability: ${formatHours(remaining)} remaining`);
      if (isRestartRow) {
        cycleWarnings.push(`34-hour restart detected: ${formatHours(resetInside.offDutyGap)} off duty before ${resetInside.nextStartDate} ${resetInside.nextStartTime}`);
      }

      output.push({
        ...entry,
        isRestartRow: Boolean(isRestartRow),
        restartDetails: isRestartRow ? resetInside : null,
        rollingCycleStart: effectiveStart,
        rollingCycleUsed: round2(used),
        rollingCycleRemaining: remaining,
        cycleWarnings,
        allWarnings: [...entry.warnings, ...cycleWarnings],
      });
    }
  }

  return output.sort((a, b) => `${b.date}${b.start}`.localeCompare(`${a.date}${a.start}`));
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;

  await new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-pdfjs]");
    if (existing) {
      existing.addEventListener("load", resolve);
      existing.addEventListener("error", reject);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.setAttribute("data-pdfjs", "true");
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return window.pdfjsLib;
}

async function readPdfFile(file) {
  const pdfjsLib = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    pages.push({ pageNo, items: content.items });
  }

  return pages;
}

function runCalculationTests() {
  const parsed = parseRowsFromPlainText("Joseph Gold Apr 2026\n1 09:00 18:27 9.45 1.00");
  const offParsed = parseRowsFromPlainText("Joseph Gold May 2026\n3 Off");
  const sample = [
    createEntry({ driver: "Test", date: "2026-04-01", start: "09:00", finish: "18:00", totalHoursFromPdf: 9, drivingHours: 1 }),
    createEntry({ driver: "Test", date: "2026-04-02", start: "09:00", finish: "19:00", totalHoursFromPdf: 10, drivingHours: 1 }),
    createEntry({ driver: "Test", date: "2026-04-03", start: "09:00", finish: "21:00", totalHoursFromPdf: 12, drivingHours: 0 }),
  ].map(calculateEntry);
  const rolling = applyRollingCycle(sample, 8, 70);
  const kept = keepCurrentHosTimeframe([
    createEntry({ driver: "Test", date: "2026-04-20" }),
    createEntry({ driver: "Test", date: "2026-04-27" }),
    createEntry({ driver: "Test", date: "2026-05-04", isOff: true }),
  ], 8);

  const tests = [
    { name: "Driver auto-detection", actual: parsed[0]?.driver, expected: "Joseph Gold" },
    { name: "Date is preserved from row number", actual: parsed[0]?.date, expected: "2026-04-01" },
    { name: "PDF total hours imported", actual: parsed[0]?.totalHoursFromPdf, expected: 9.45 },
    { name: "Off row imports as zero-hour reset day", actual: offParsed[0]?.isOff, expected: true },
    { name: "Off row date is preserved", actual: offParsed[0]?.date, expected: "2026-05-03" },
    { name: "Over 11 driving warning", actual: calculateEntry(createEntry({ driver: "Test", drivingHours: 12 })).warnings.includes("Over 11 driving hours"), expected: true },
    { name: "30-minute break warning", actual: calculateEntry(createEntry({ driver: "Test", drivingHours: 8.25, breakMinutes: 0 })).warnings.includes("30-minute break may be required"), expected: true },
    { name: "Rolling cycle adds prior days", actual: rolling.find((e) => e.date === "2026-04-03")?.rollingCycleUsed, expected: 31 },
    { name: "Import keeps only current 8-day timeframe", actual: kept.map((e) => e.date).join(","), expected: "2026-04-27,2026-05-04" },
  ];

  return tests.map((test) => ({ ...test, passed: Object.is(test.actual, test.expected) }));
}

const styles = {
  page: { minHeight: "100vh", background: "#f8fafc", color: "#0f172a", fontFamily: "Arial, Helvetica, sans-serif", padding: 24 },
  container: { maxWidth: 1500, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 20 },
  title: { fontSize: 30, fontWeight: 800, margin: 0 },
  subtitle: { color: "#475569", marginTop: 6, marginBottom: 0 },
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 18, padding: 18, boxShadow: "0 1px 2px rgba(15,23,42,.05)", marginBottom: 16 },
  fieldGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  button: { border: "1px solid #cbd5e1", background: "#fff", borderRadius: 12, padding: "9px 13px", cursor: "pointer", fontWeight: 700 },
  primaryButton: { border: "1px solid #1d4ed8", background: "#1d4ed8", color: "#fff", borderRadius: 12, padding: "9px 13px", cursor: "pointer", fontWeight: 700 },
  dangerButton: { border: "1px solid #fecaca", background: "#fff1f2", color: "#b91c1c", borderRadius: 12, padding: "8px 10px", cursor: "pointer", fontWeight: 700 },
  label: { display: "block", fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 6 },
  input: { width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 10, padding: "9px 10px", fontSize: 14, background: "#fff" },
  textarea: { width: "100%", minHeight: 130, boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 10, padding: "9px 10px", fontSize: 14, background: "#fff" },
  statGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 },
  stat: { background: "#f1f5f9", borderRadius: 14, padding: 12 },
  statLabel: { color: "#64748b", fontSize: 12, margin: 0 },
  statValue: { fontWeight: 800, margin: "4px 0 0" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", minWidth: 1550, borderCollapse: "separate", borderSpacing: "0 8px" },
  th: { textAlign: "left", color: "#64748b", fontSize: 12, textTransform: "uppercase", padding: "0 8px" },
  td: { background: "#fff", borderTop: "1px solid #e2e8f0", borderBottom: "1px solid #e2e8f0", padding: 8, verticalAlign: "middle" },
  warning: { color: "#b91c1c", fontSize: 12, fontWeight: 700 },
  restartBadge: { display: "inline-block", background: "#dbeafe", color: "#1d4ed8", border: "1px solid #93c5fd", borderRadius: 999, padding: "3px 8px", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap" },
  ok: { color: "#15803d", fontSize: 12, fontWeight: 700 },
  note: { color: "#475569", fontSize: 13, lineHeight: 1.5 },
};

export default function DriverHOSTracker() {
  const [entries, setEntries] = useState(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return [createEntry()];
  });
  const [cycleRule, setCycleRule] = useState("70-8");
  const [activeDriver, setActiveDriver] = useState(ALL_DRIVERS);
  const [showTests, setShowTests] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [pasteText, setPasteText] = useState("");
  const fileInputRef = useRef(null);

  const cycleLimit = cycleRule === "60-7" ? 60 : 70;
  const cycleDays = cycleRule === "60-7" ? 7 : 8;

  const calculatedEntries = useMemo(() => entries.map(calculateEntry), [entries]);
  const rollingEntries = useMemo(() => applyRollingCycle(calculatedEntries, cycleDays, cycleLimit), [calculatedEntries, cycleDays, cycleLimit]);
  const tests = useMemo(runCalculationTests, []);

  const drivers = useMemo(() => {
    const names = rollingEntries.map((e) => e.driver.trim()).filter(Boolean);
    return [ALL_DRIVERS, ...Array.from(new Set(names)).sort()];
  }, [rollingEntries]);

  const filteredEntries = useMemo(() => rollingEntries.filter((e) => activeDriver === ALL_DRIVERS || e.driver === activeDriver), [rollingEntries, activeDriver]);

  const latestByDriver = useMemo(() => {
    const map = new Map();
    for (const entry of rollingEntries) {
      if (!map.has(entry.driver) || entry.date > map.get(entry.driver).date) map.set(entry.driver, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.driver.localeCompare(b.driver));
  }, [rollingEntries]);

  function persist(next) {
    setEntries(next);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  }

  function addImported(imported) {
    if (!imported.length) {
      setImportStatus("No valid rows found. For best results, use the Driver’s Time Record PDF format or paste extracted text.");
      return;
    }

    const kept = keepCurrentHosTimeframe(imported, cycleDays);
    persist([...entries, ...kept]);
    setImportStatus(`Imported ${kept.length} current HOS timeframe row(s) for ${kept[0].driver}. Older rows outside the current ${cycleDays}-day window were ignored.`);
  }

  async function handlePdfUpload(file) {
    setImportStatus("Reading PDF...");
    try {
      const pages = await readPdfFile(file);
      const imported = parseRowsFromPdfItems(pages);
      addImported(imported);
    } catch (error) {
      setImportStatus("PDF.js could not load or read this PDF in the preview. Use the paste-text box below, or deploy with pdfjs-dist installed.");
    }
  }

  function importPastedText() {
    addImported(parseRowsFromPlainText(pasteText));
  }

  function updateEntry(id, field, value) {
    const numericFields = new Set(["totalHoursFromPdf", "drivingHours", "breakMinutes"]);
    persist(entries.map((entry) => entry.id === id ? { ...entry, [field]: numericFields.has(field) ? (value === "" ? "" : Number(value)) : value } : entry));
  }

  function toggleOffDuty(id, checked) {
    persist(entries.map((entry) => entry.id === id ? {
      ...entry,
      isOff: checked,
      start: checked ? "" : entry.start,
      finish: checked ? "" : entry.finish,
      totalHoursFromPdf: checked ? 0 : entry.totalHoursFromPdf,
      drivingHours: checked ? 0 : entry.drivingHours,
      notes: checked ? "Marked as off-duty day." : entry.notes,
    } : entry));
  }

  function addEntry() {
    const last = entries[entries.length - 1] || {};
    persist([...entries, createEntry({ driver: last.driver || "", date: last.date || todayISO() })]);
  }

  function deleteEntry(id) {
    persist(entries.length <= 1 ? [createEntry()] : entries.filter((e) => e.id !== id));
  }

  function resetAll() {
    const freshEntries = [createEntry()];
    setEntries(freshEntries);
    setActiveDriver(ALL_DRIVERS);
    setImportStatus("");
    setPasteText("");
    setShowTests(false);
    try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function exportCsv() {
    const headers = ["Driver", "Date", "Status", "Start", "Finish", "PDF Total Hours", "On Duty Hours", "Driving Hours", "Rolling Cycle Used", "Rolling Cycle Remaining", "Warnings", "Restart", "Notes"]; 
    const rows = rollingEntries.map((e) => [e.driver, e.date, e.isOff ? "Off" : "On Duty", e.start, e.finish, e.totalHoursFromPdf, e.onDutyHours, e.drivingHours, e.rollingCycleUsed, e.rollingCycleRemaining, e.allWarnings.join("; "), e.isRestartRow ? "34-Hour Restart" : "", e.notes]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "driver-hos-tracker.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>Driver HOS Tracker</h1>
            <p style={styles.subtitle}>Imports only the current HOS lookback window, treats Off days as zero-hour reset days, and calculates rolling 60/7 or 70/8 availability.</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={styles.primaryButton} onClick={addEntry}>+ Add Entry</button>
            <button type="button" style={styles.button} onClick={exportCsv}>Export CSV</button>
            <button type="button" style={styles.button} onClick={() => setShowTests(!showTests)}>Tests</button>
            <button type="button" style={styles.dangerButton} onClick={resetAll}>Reset</button>
          </div>
        </header>

        <section style={styles.card}>
          <div style={styles.fieldGrid}>
            <div>
              <label style={styles.label}>Upload Driver Time Record PDF</label>
              <input ref={fileInputRef} style={styles.input} type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && handlePdfUpload(e.target.files[0])} />
              {importStatus && <p style={styles.note}>{importStatus}</p>}
            </div>
            <div>
              <label style={styles.label}>Cycle Rule</label>
              <select style={styles.input} value={cycleRule} onChange={(e) => setCycleRule(e.target.value)}>
                <option value="70-8">70 hours / 8 days</option>
                <option value="60-7">60 hours / 7 days</option>
              </select>
            </div>
            <div>
              <label style={styles.label}>Driver Filter</label>
              <select style={styles.input} value={activeDriver} onChange={(e) => setActiveDriver(e.target.value)}>
                {drivers.map((driver) => <option key={driver} value={driver}>{driver}</option>)}
              </select>
            </div>
          </div>
        </section>

        <section style={styles.card}>
          <label style={styles.label}>Paste Extracted Text Fallback</label>
          <textarea style={styles.textarea} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'Example:\nJoseph Gold May 2026\n1 09:18 19:11 9.88 0.00\n2 09:13 19:13 10.00 0.00\n3 Off\n4 Off'} />
          <div style={{ marginTop: 10 }}>
            <button type="button" style={styles.button} onClick={importPastedText}>Import Pasted Text</button>
          </div>
        </section>

        <section style={styles.card}>
          <h2 style={{ marginTop: 0 }}>Current Driver Summary</h2>
          <div style={styles.statGrid}>
            {latestByDriver.length === 0 ? <p style={styles.note}>No driver entries yet.</p> : latestByDriver.map((e) => (
              <div key={e.driver} style={{ ...styles.stat, border: e.allWarnings.length ? "1px solid #fecaca" : "1px solid #bbf7d0" }}>
                <p style={styles.statLabel}>{e.driver}</p>
                <p style={styles.statValue}>Cycle Used: {formatHours(e.rollingCycleUsed)}</p>
                <p style={styles.statValue}>Cycle Left: {formatHours(e.rollingCycleRemaining)}</p>
                <p style={styles.note}>As of {e.date}. Window starts {e.rollingCycleStart}.</p>
                {e.allWarnings.length > 0 && <p style={styles.warning}>{e.allWarnings.join("; ")}</p>}
              </div>
            ))}
          </div>
        </section>

        <section style={styles.card}>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Driver</th>
                  <th style={styles.th}>Date</th>
                  <th style={styles.th}>Off</th>
                  <th style={styles.th}>Start</th>
                  <th style={styles.th}>Finish</th>
                  <th style={styles.th}>PDF Total</th>
                  <th style={styles.th}>Driving</th>
                  <th style={styles.th}>Break Min.</th>
                  <th style={styles.th}>On Duty</th>
                  <th style={styles.th}>Rolling Used</th>
                  <th style={styles.th}>Rolling Left</th>
                  <th style={styles.th}>Warnings</th>
                  <th style={styles.th}>Restart</th>
                  <th style={styles.th}>Notes</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((e) => (
                  <tr key={e.id} style={e.isRestartRow ? { outline: "2px solid #93c5fd", background: "#eff6ff" } : undefined}>
                    <td style={styles.td}><input style={styles.input} value={e.driver} onChange={(ev) => updateEntry(e.id, "driver", ev.target.value)} /></td>
                    <td style={styles.td}><input style={styles.input} type="date" value={e.date} onChange={(ev) => updateEntry(e.id, "date", ev.target.value)} /></td>
                    <td style={styles.td}><input type="checkbox" checked={Boolean(e.isOff)} onChange={(ev) => toggleOffDuty(e.id, ev.target.checked)} /></td>
                    <td style={styles.td}><input style={styles.input} type="time" value={e.start} disabled={e.isOff} onChange={(ev) => updateEntry(e.id, "start", ev.target.value)} /></td>
                    <td style={styles.td}><input style={styles.input} type="time" value={e.finish} disabled={e.isOff} onChange={(ev) => updateEntry(e.id, "finish", ev.target.value)} /></td>
                    <td style={styles.td}><input style={styles.input} type="number" step="0.01" value={e.totalHoursFromPdf} disabled={e.isOff} onChange={(ev) => updateEntry(e.id, "totalHoursFromPdf", ev.target.value)} /></td>
                    <td style={styles.td}><input style={styles.input} type="number" step="0.01" value={e.drivingHours} disabled={e.isOff} onChange={(ev) => updateEntry(e.id, "drivingHours", ev.target.value)} /></td>
                    <td style={styles.td}><input style={styles.input} type="number" step="1" value={e.breakMinutes} disabled={e.isOff} onChange={(ev) => updateEntry(e.id, "breakMinutes", ev.target.value)} /></td>
                    <td style={styles.td}><strong>{e.isOff ? "Off" : formatHours(e.onDutyHours)}</strong></td>
                    <td style={styles.td}>{formatHours(e.rollingCycleUsed)}</td>
                    <td style={styles.td}>{formatHours(e.rollingCycleRemaining)}</td>
                    <td style={styles.td}><span style={e.allWarnings.length ? styles.warning : styles.ok}>{e.allWarnings.length ? e.allWarnings.join("; ") : "OK"}</span></td>
                    <td style={styles.td}>{e.isRestartRow ? <span style={styles.restartBadge}>34-Hour Restart</span> : ""}</td>
                    <td style={styles.td}><input style={styles.input} value={e.notes} onChange={(ev) => updateEntry(e.id, "notes", ev.target.value)} /></td>
                    <td style={styles.td}><button type="button" style={styles.dangerButton} onClick={() => deleteEntry(e.id)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {showTests && (
          <section style={styles.card}>
            <h2 style={{ marginTop: 0 }}>Calculation Tests</h2>
            {tests.map((t) => <p key={t.name} style={{ color: t.passed ? "#15803d" : "#b91c1c" }}><strong>{t.passed ? "PASS" : "FAIL"}</strong> — {t.name}: expected {String(t.expected)}, got {String(t.actual)}</p>)}
          </section>
        )}

        <section style={styles.card}>
          <h2 style={{ marginTop: 0 }}>Important Notes</h2>
          <p style={styles.note}>PDF import now keeps only the current HOS lookback window based on the latest date in the uploaded record. Under the 70/8 rule, a record ending May 4 keeps April 27 through May 4 and ignores older rows.</p>
          <p style={styles.note}>Off rows are imported as zero-hour days and can create a possible 34-hour reset/restart. Review manually before dispatching. This is an internal planning tracker, not a certified ELD.</p>
        </section>
      </div>
    </div>
  );
}
