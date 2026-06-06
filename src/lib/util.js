// Generic utilities: ids, math, CSV parsing, time/number coercion, category helpers.

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#e91e63","#00bcd4","#607d8b","#8bc34a","#ff5722"];

function parseCSV(text) {
  // Simple CSV parser handling quoted fields and commas
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = line => {
    const out = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const headers = parseLine(lines[0]).map(h => h || "col");
  const rows = lines.slice(1).map(line => {
    const cells = parseLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : ""; });
    return row;
  });
  return { headers, rows };
}

// Largest dot radius (px) so `count` circles fit in a w×h box with `gap` spacing,
// clamped to [min,max]. Used to keep stacked-dot cells from overflowing.
function fitDotR(count, w, h, min = 2, max = 8, gap = 2) {
  for (let r = max; r >= min; r--) {
    const cols = Math.floor((w + gap) / (2 * r + gap));
    const rowsFit = Math.floor((h + gap) / (2 * r + gap));
    if (cols >= 1 && rowsFit >= 1 && cols * rowsFit >= count) return r;
  }
  return min;
}

// ── Time parsing: recognize 24h "13:05" and 12h "1:05pm" as numeric minutes ────
// Returns minutes since midnight (0–1439) or null when v is not a time string.
function parseTimeToMinutes(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  // 12-hour with am/pm, e.g. "1:05pm", "12:00 AM", "9:30 a.m."
  let m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i);
  if (m) {
    let h = +m[1]; const min = +m[2];
    if (h < 1 || h > 12 || min > 59) return null;
    if (h === 12) h = 0;
    return (m[3].toLowerCase() === "p" ? h + 12 : h) * 60 + min;
  }
  // 24-hour, e.g. "13:05", "9:30"
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

function minutesToTime(mins) {
  let m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0");
}

// Convert a cell value to a number, understanding time strings.
function toNum(v) {
  if (v === undefined || v === null || v === "") return NaN;
  const n = Number(v);
  if (!isNaN(n)) return n;
  const t = parseTimeToMinutes(v);
  return t === null ? NaN : t;
}

// Classify a column: numeric if ≥80% of values parse as numbers or times;
// `time` marks columns whose numeric values came (mostly) from time parsing.
function colKind(rows, col) {
  const vals = rows.map(r => r[col]).filter(v => v !== undefined && v !== "");
  if (!vals.length) return { numeric: false, time: false };
  let numCount = 0, plainNum = 0, timeCount = 0;
  vals.forEach(v => {
    if (!isNaN(Number(v))) { numCount++; plainNum++; }
    else if (parseTimeToMinutes(v) !== null) { numCount++; timeCount++; }
  });
  const numeric = numCount / vals.length >= 0.8;
  return { numeric, time: numeric && timeCount > plainNum };
}

// Collapse a list of categories to the top `limit` by count plus an aggregated
// "Other" bucket. Returns the displayed categories and whether collapsing happened.
const OTHER_CAT = "Other";
function collapseCats(cats, countByCat, expanded, limit = 10) {
  if (expanded || cats.length <= limit) return { shown: cats, isCollapsed: false, hidden: 0 };
  const sorted = [...cats].sort((a, b) => (countByCat[b] || 0) - (countByCat[a] || 0));
  const top = sorted.slice(0, limit);
  return { shown: [...top, OTHER_CAT], isCollapsed: true, hidden: cats.length - limit };
}

// Suggest the label for a newly-added device item, continuing whatever pattern the
// existing labels (in order) already follow. Detects an arithmetic numeric run from the
// last two labels (4,5,6→7; 10,20,30→40) and a consecutive single-letter run, case-aware
// (a,b→c; A,B,C→D). A lone trailing single letter also continues (a→b). When no pattern is
// found — or the only continuation would collide / overflow past z/Z — it falls back to
// "New<n>". Always skips labels that already exist so re-adding after a middle delete makes
// a fresh item instead of merging into an existing one.
function nextItemLabel(labels) {
  const set = new Set(labels);
  const n = labels.length;
  const last = n >= 1 ? labels[n - 1] : null;
  const prev = n >= 2 ? labels[n - 2] : null;
  const isNum = s => typeof s === "string" && /^-?\d+$/.test(s);
  const isLetter = s => typeof s === "string" && /^[a-zA-Z]$/.test(s);
  const nextChar = s => {                          // next letter, or null past z/Z
    const c = String.fromCharCode(s.charCodeAt(0) + 1);
    return /^[a-zA-Z]$/.test(c) ? c : null;
  };

  let advance = null;                              // s -> next label in the run (may be null)
  if (isNum(prev) && isNum(last)) {
    const step = parseInt(last, 10) - parseInt(prev, 10);
    if (step !== 0) advance = s => String(parseInt(s, 10) + step);
  } else if (isLetter(prev) && isLetter(last) &&
             (prev <= "z") === (last <= "z") &&    // same case (both lower or both upper)
             last.charCodeAt(0) - prev.charCodeAt(0) === 1) {
    advance = nextChar;
  } else if (isLetter(last)) {
    advance = nextChar;
  }

  if (advance) {
    let cand = advance(last);
    let guard = 0;
    while (cand != null && set.has(cand) && guard++ < 1000) cand = advance(cand);
    if (cand != null && !set.has(cand)) return cand;
  }

  let k = n + 1;
  while (set.has(`New${k}`)) k++;
  return `New${k}`;
}

export { uid, clamp, sleep, COLORS, parseCSV, fitDotR, parseTimeToMinutes, minutesToTime, toNum, colKind, OTHER_CAT, collapseCats, nextItemLabel };
