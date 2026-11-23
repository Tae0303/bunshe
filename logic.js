// Pure helpers shared by the app and the tests: no DOM, no storage.

export const DEFAULT_CATEGORIES = [
  'Food & Drinks',
  'Hobbies (Board games, Card games, Video games, Books)',
  'Transit',
  'Items',
  'Snack & Beverage',
  'Medical Expense',
  'Monthly Expenses',
  'Others',
];

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Thai day colours, the same ones the sheet uses to colour its date cells.
export const DAY_COLORS = ['#f4cccc', '#fff2cc', '#f3c4e7', '#d9ead3', '#fce5cd', '#cfe2f3', '#d9d2e9'];

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const parts = (s) => s.split('-').map(Number);

/** 'YYYY-MM-DD' for a Date, in the phone's local time. */
export function isoDate(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 'YYYY-MM' — the month an entry belongs to. */
export const monthKey = (iso) => iso.slice(0, 7);

/** 'Nov 2026' — same as the sheet's month tab names. */
export function monthLabel(key) {
  const [y, m] = parts(key);
  return `${MONTHS[m - 1]} ${y}`;
}

export function daysInMonth(key) {
  const [y, m] = parts(key);
  return new Date(y, m, 0).getDate();
}

export function shiftMonth(key, delta) {
  const [y, m] = parts(key);
  return isoDate(new Date(y, m - 1 + delta, 1)).slice(0, 7);
}

export function weekdayIndex(iso) {
  const [y, m, d] = parts(iso);
  return new Date(y, m - 1, d).getDay();
}

export function formatDay(iso) {
  const [y, m, d] = parts(iso);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Days the average is spread over: the whole month once it is over, today's day
 * number in the current month, 0 for a future month. Compares year and month
 * together, so a past year is never treated as the current month (spec issue #2).
 */
export function daysCounted(key, todayIso) {
  const current = monthKey(todayIso);
  if (key < current) return daysInMonth(key);
  if (key === current) return Number(todayIso.slice(8, 10));
  return 0;
}

/** Newest first within a day: entries not yet synced, then sheet rows from the bottom up. */
export const entryOrder = (e) => (e.status === 'pending' ? 1e15 + (e.createdAt || 0) : e.seq || 0);

/** Everything the Month screen shows: total, average per day, category breakdown, rows. */
export function summarize(expenses, key, todayIso) {
  const rows = expenses.filter((e) => monthKey(e.date) === key);
  const days = daysCounted(key, todayIso);
  const sums = new Map();
  let total = 0;
  for (const e of rows) {
    total += e.amount;
    const name = e.category || 'Uncategorized';
    sums.set(name, (sums.get(name) || 0) + e.amount);
  }
  const categories = [...sums]
    .map(([name, sum]) => ({ name, total: round2(sum), perDay: days ? sum / days : null }))
    .sort((a, b) => b.total - a.total);
  rows.sort((a, b) => b.date.localeCompare(a.date) || entryOrder(b) - entryOrder(a));
  return { key, count: rows.length, total: round2(total), days, perDay: days ? total / days : null, categories, rows };
}

/** One tap on a step button: add the step (or take it away in subtract mode), never below 0. */
export const stepAmount = (current, step, subtract = false) =>
  round2(Math.max(0, (Number.isFinite(current) ? current : 0) + (subtract ? -step : step)));

/** '1,234.5' or '฿17' → number rounded to 2 places; NaN when it is not a number. */
export function parseAmount(text) {
  const n = Number(String(text).replace(/[,\s฿]/g, ''));
  return Number.isFinite(n) ? round2(n) : NaN;
}

export const formatMoney = (n) =>
  '฿' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 'Hobbies (Board games, …)' → 'Hobbies' for chips and lists. */
export const shortName = (category) => category.replace(/\s*\(.*\)\s*$/, '') || category;

/** Names match ignoring case and surrounding spaces ("transit" = "Transit "). */
export const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
export const hasName = (names, name) => names.some((n) => sameName(n, name));

/**
 * Category and shortcut changes made on the phone wait in a queue until they reach the sheet.
 * This replays that queue, in order, over the lists last read from the sheet, so changes show at once.
 * The sheet script (applyListOp_ in Code.gs) applies the same ops the same way.
 *   { type: 'category', name }                          add a category
 *   { type: 'renameCategory', from, to }                rename; shortcuts using it follow
 *   { type: 'deleteCategory', name }
 *   { type: 'shortcut', name, amount, category }        add (or replace one with that name)
 *   { type: 'updateShortcut', from, name, amount, category }
 *   { type: 'deleteShortcut', name }
 *   { type: 'reorderCategories', order: [names] }      the full new order
 *   { type: 'reorderShortcuts', order: [names] }
 */
export function applyListOps(fromSheet, queue) {
  let categories = [...fromSheet.categories];
  let shortcuts = fromSheet.shortcuts.map((s) => ({ ...s }));
  const putShortcut = (key, s) => {
    const i = shortcuts.findIndex((x) => sameName(x.name, key));
    if (i >= 0) shortcuts[i] = s;
    else shortcuts.push(s);
  };
  for (const op of queue) {
    switch (op.type) {
      case 'category':
        if (!hasName(categories, op.name)) categories.push(op.name);
        break;
      case 'renameCategory': {
        const i = categories.findIndex((c) => sameName(c, op.from));
        if (hasName(categories, op.to) && !sameName(op.from, op.to)) {
          if (i >= 0) categories.splice(i, 1); // the new name already exists: the two become one
        } else if (i >= 0) {
          categories[i] = op.to;
        }
        shortcuts = shortcuts.map((s) => (sameName(s.category, op.from) ? { ...s, category: op.to } : s));
        break;
      }
      case 'deleteCategory':
        categories = categories.filter((c) => !sameName(c, op.name));
        break;
      case 'shortcut':
        putShortcut(op.name, { name: op.name, amount: op.amount, category: op.category });
        break;
      case 'updateShortcut':
        putShortcut(op.from, { name: op.name, amount: op.amount, category: op.category });
        break;
      case 'deleteShortcut':
        shortcuts = shortcuts.filter((s) => !sameName(s.name, op.name));
        break;
      case 'reorderCategories':
        categories = sortByOrder(categories, op.order);
        break;
      case 'reorderShortcuts':
        shortcuts = sortByOrder(shortcuts, op.order, (s) => s.name);
        break;
    }
  }
  return { categories, shortcuts };
}

/**
 * Puts items in the order of `order` (matched by name). Items not in `order` (added in the sheet
 * meanwhile) keep their relative order after them. Code.gs sortByOrder_ does the same.
 */
export function sortByOrder(items, order, nameOf = (x) => x) {
  const rank = (item) => {
    const i = order.findIndex((o) => sameName(o, nameOf(item)));
    return i < 0 ? order.length : i;
  };
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
    .map((x) => x.item);
}

/** Swaps an item with its neighbour (delta −1 = up, +1 = down). Returns the new array, or null at an end. */
export function moveItem(items, index, delta) {
  const j = index + delta;
  if (index < 0 || index >= items.length || j < 0 || j >= items.length) return null;
  const out = [...items];
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

export function toCsv(expenses) {
  const cell = (v) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [...expenses]
    .sort((a, b) => a.date.localeCompare(b.date) || entryOrder(a) - entryOrder(b))
    .map((e) => [e.date, e.amount.toFixed(2), e.category, e.note || '', e.status === 'pending' ? 'no' : 'yes'].map(cell).join(','));
  return ['Date,Amount,Category,Note,Synced', ...rows].join('\r\n') + '\r\n';
}
