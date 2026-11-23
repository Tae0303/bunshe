import * as db from './db.js';
import { syncNow, onStatus } from './sync.js';
import {
  DEFAULT_CATEGORIES, WEEKDAYS, DAY_COLORS, isoDate, monthKey, monthLabel, shiftMonth, summarize,
  parseAmount, round2, formatMoney, formatDay, shortName, weekdayIndex, toCsv,
  applyListOps, hasName, sameName, stepAmount, moveTo, nameKey,
} from './logic.js';

const APP_VERSION = '1.7.0';
const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
// Category colours, kept clear of the teal accent so a selected chip still shows its dot.
// "Others" is always slate; the rest take colours in list order, so a new category never shifts them.
const PALETTE = ['#f97316', '#8b5cf6', '#3b82f6', '#ef4444', '#eab308', '#ec4899', '#22c55e', '#06b6d4', '#a16207', '#84cc16', '#d946ef'];
const OTHER_COLOR = '#64748b';
const TITLES = { add: 'Add expense', month: 'Month', settings: 'Settings' };

const $ = (selector) => document.querySelector(selector);
const els = {
  title: $('#title'), badge: $('#syncBadge'), toast: $('#toast'), version: $('#version'),
  form: $('#entry'), amount: $('#amount'), steps: document.querySelectorAll('[data-step]'), clear: $('#clearAmount'),
  stepsGroup: $('#steps'), minusMode: $('#minusMode'),
  shortcut: $('#shortcut'), categories: $('#categories'),
  date: $('#date'), today: $('#today'), note: $('#note'), error: $('#formError'),
  monthLabel: $('#monthLabel'), prev: $('#prevMonth'), next: $('#nextMonth'),
  total: $('#mTotal'), count: $('#mCount'), avg: $('#mAvg'), days: $('#mDays'),
  donut: $('#donut'), catTable: $('#catTable'), entries: $('#entries'),
  settingsForm: $('#settingsForm'), syncUrl: $('#syncUrl'), syncKey: $('#syncKey'),
  syncInfo: $('#syncInfo'), syncNowBtn: $('#syncNow'), exportBtn: $('#exportCsv'),
  menuBtn: $('#menuBtn'), menu: $('#menu'),
  shortcutDialog: $('#shortcutDialog'), shortcutForm: $('#shortcutForm'), scTitle: $('#shortcutDialogTitle'),
  scName: $('#scName'), scAmount: $('#scAmount'), scCategory: $('#scCategory'), scError: $('#scError'),
  scSubmit: $('#scSubmit'), scDelete: $('#scDelete'),
  categoryDialog: $('#categoryDialog'), categoryForm: $('#categoryForm'), catTitle: $('#categoryDialogTitle'),
  catSwatches: $('#catSwatches'),
  catName: $('#catName'), catError: $('#catError'), catHint: $('#catHint'), catSubmit: $('#catSubmit'), catDelete: $('#catDelete'),
  listDialog: $('#listDialog'), listTitle: $('#listDialogTitle'), listItems: $('#listItems'), listAdd: $('#listAdd'),
  entriesHint: $('#entriesHint'), entryDialog: $('#entryDialog'), entryAmount: $('#entryAmount'),
  entryCategory: $('#entryCategory'), entryDate: $('#entryDate'), entryNote: $('#entryNote'),
  entryNoteLabel: $('#entryNoteLabel'), entryStatus: $('#entryStatus'), entryDelete: $('#entryDelete'),
  entryEdit: $('#entryEdit'), editDialog: $('#editDialog'), editForm: $('#editForm'),
  edAmount: $('#edAmount'), edCategory: $('#edCategory'), edDate: $('#edDate'), edNote: $('#edNote'), edError: $('#edError'),
  connectedCard: $('#connectedCard'), changeConnection: $('#changeConnection'), cancelConnection: $('#cancelConnection'),
};

const state = {
  categories: DEFAULT_CATEGORIES,
  shortcuts: [],
  expenses: [],
  category: '',
  minus: false, // "− Subtract" is on: the step buttons take away
  month: monthKey(isoDate()),
  autoDate: '', // the date the app filled in itself; it moves to the new day if untouched
  sync: { state: 'idle' },
  lastSync: null,
  queuedLists: 0, // category/shortcut changes made here, not yet in the sheet
  syncRequested: false, // you tapped Sync now: show progress even when nothing is waiting
  viewing: null, // the expense open in the entry card
  editingEntry: null, // the expense open in the edit form
  hasSettings: false, // a Web app URL and key are saved
  editConnection: false, // "Change connection" tapped: show the URL/key form again
  editing: null, // the shortcut or category name being edited, or null when adding
  returnToList: null, // 'shortcut' | 'category': reopen that list when the edit form closes
  colorMap: {}, // category (lower case) → palette index, so colours survive reordering and renaming
  sheetColors: {}, // category (lower case) → '#rrggbb' saved in the sheet (or picked here, waiting to sync)
  colorsInSheet: false, // the sheet script keeps colours (it sent a colour column on the last pull)
  pickedColor: '', // the colour chosen in the category form
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/*
 * Category colours. A colour saved in the sheet (Categories tab, column B, or picked in the app)
 * wins. Until a category has one, it gets the first free colour, remembered on this phone; the
 * first sync with an up-to-date sheet script copies those into the sheet. "Others" defaults to slate.
 */
const colorKey = nameKey;
const colorOf = (category) => {
  if (!category) return OTHER_COLOR;
  const saved = state.sheetColors[colorKey(category)];
  if (saved) return saved;
  if (category === 'Others') return OTHER_COLOR;
  const i = state.colorMap[colorKey(category)];
  return i === undefined ? OTHER_COLOR : PALETTE[i % PALETTE.length];
};
function assignColors() {
  const usedHex = new Set(Object.values(state.sheetColors));
  for (const i of Object.values(state.colorMap)) usedHex.add(PALETTE[i % PALETTE.length]);
  let changed = false;
  for (const c of state.categories) {
    const k = colorKey(c);
    if (c === 'Others' || state.sheetColors[k] || state.colorMap[k] !== undefined) continue;
    let i = PALETTE.findIndex((hex) => !usedHex.has(hex));
    if (i < 0) i = Object.keys(state.colorMap).length % PALETTE.length; // more categories than colours: reuse
    state.colorMap[k] = i;
    usedHex.add(PALETTE[i]);
    changed = true;
  }
  if (changed) db.set('categoryColors', state.colorMap);
}
/** A colour no category is using yet, for a new one. */
const freeColor = () => PALETTE.find((hex) => !state.categories.some((c) => colorOf(c) === hex)) || PALETTE[0];

/** First sync with a sheet script that keeps colours: copy every colour the sheet does not have yet. */
async function seedSheetColors() {
  if (!state.colorsInSheet) return;
  const queue = (await db.get('pendingLists')) || [];
  const waiting = new Set(queue.filter((op) => op.type === 'categoryColor').map((op) => colorKey(op.name)));
  const missing = state.categories.filter(
    (c) => !state.sheetColors[colorKey(c)] && !waiting.has(colorKey(c)) && !seeded.has(colorKey(c)),
  );
  if (!missing.length) return;
  for (const c of missing) {
    seeded.add(colorKey(c)); // once per session: never loop if the sheet could not store one
    queue.push({ id: newId(), type: 'categoryColor', name: c, color: colorOf(c) });
  }
  await db.set('pendingLists', queue);
  await reloadData();
}
const seeded = new Set();
// Waiting to sync: new entries, deleted entries, and category/shortcut changes.
const pendingCount = () => state.expenses.filter((e) => e.status !== 'synced').length + state.queuedLists;
// What the app shows: everything except entries deleted here (they wait only to be deleted in the sheet).
const visibleExpenses = () => state.expenses.filter((e) => e.status !== 'deleted');

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

/* ---------- Views ---------- */

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const b of document.querySelectorAll('.tabbar button')) {
    b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
  }
  els.title.textContent = TITLES[name];
  if (name === 'month') renderMonth();
  if (name === 'settings') fillSettings();
  window.scrollTo(0, 0);
}

/* ---------- Add expense ---------- */

function setAmount(n) {
  els.amount.value = n > 0 ? String(round2(n)) : '';
}

function setToday() {
  state.autoDate = isoDate();
  els.date.value = state.autoDate;
}

function selectCategory(name) {
  state.category = name;
  for (const b of els.categories.querySelectorAll('[data-cat]')) {
    const picked = b.dataset.cat === name;
    b.setAttribute('aria-pressed', String(picked));
    if (picked) revealChip(els.categories, b);
  }
}

/** Slides a sideways-scrolling row so the chip is in view (e.g. a shortcut picked a far-right category). */
function revealChip(row, chip) {
  const r = row.getBoundingClientRect();
  const c = chip.getBoundingClientRect();
  if (c.left < r.left + 16 || c.right > r.right - 32) row.scrollBy({ left: c.left - r.left - 16, behavior: 'smooth' });
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

/** Subtract mode: the step buttons read −1 … −100 and take away. */
function setMinus(on) {
  state.minus = on;
  els.minusMode.setAttribute('aria-pressed', String(on));
  els.stepsGroup.classList.toggle('minus', on);
  els.stepsGroup.setAttribute('aria-label', on ? 'Take away from the amount' : 'Add to the amount');
  els.steps.forEach((b) => (b.textContent = `${on ? '−' : '+'}${b.dataset.step}`));
}

function resetForm() {
  setAmount(0);
  setMinus(false);
  selectCategory('');
  els.shortcut.value = '';
  els.note.value = '';
  setToday();
  showError('');
}

function renderCategories() {
  els.categories.innerHTML = state.categories
    // No colour dot here: category names carry their own emoji.
    .map((c) => `<button type="button" class="chip" data-cat="${escapeHtml(c)}" aria-pressed="${c === state.category}" title="${escapeHtml(c)}">${escapeHtml(shortName(c))}</button>`)
    .join('');
}

function renderShortcuts() {
  const none = state.shortcuts.length === 0;
  const picked = els.shortcut.value;
  els.shortcut.disabled = none;
  els.shortcut.innerHTML =
    `<option value="">${none ? 'No shortcuts yet · add one from ☰' : 'Choose a shortcut…'}</option>` +
    state.shortcuts.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} · ${formatMoney(s.amount)}</option>`).join('');
  if (state.shortcuts.some((s) => s.name === picked)) els.shortcut.value = picked; // a sync mid-entry keeps the pick
}

els.steps.forEach((button) =>
  button.addEventListener('click', () => {
    setAmount(stepAmount(parseAmount(els.amount.value), Number(button.dataset.step), state.minus));
  }),
);
els.minusMode.addEventListener('click', () => setMinus(!state.minus));
els.clear.addEventListener('click', () => setAmount(0));
els.today.addEventListener('click', setToday);
// Any change to the form clears an old "Enter an amount" / "Pick a category" message.
els.form.addEventListener('click', (ev) => {
  if (ev.target.closest('button:not([type="submit"])')) showError('');
});
els.form.addEventListener('input', () => showError(''));

els.categories.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-cat]');
  if (button) selectCategory(button.dataset.cat);
});

els.shortcut.addEventListener('change', () => {
  const s = state.shortcuts.find((x) => x.name === els.shortcut.value);
  if (!s) return;
  setAmount(s.amount);
  if (s.category) selectCategory(s.category);
  setToday(); // same as the sheet: a shortcut also sets the date to today
});

els.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = parseAmount(els.amount.value);
  const date = els.date.value;
  const problem = !(amount > 0)
    ? 'Enter an amount above 0.'
    : !state.category
      ? 'Pick a category.'
      : !/^\d{4}-\d{2}-\d{2}$/.test(date)
        ? 'Pick a date.'
        : '';
  if (problem) return showError(problem);

  const entry = {
    id: newId(), date, amount, category: state.category, note: els.note.value.trim(),
    status: 'pending', createdAt: Date.now(),
  };
  try {
    await db.putExpense(entry);
  } catch (err) {
    return showError(`Could not save on this phone: ${err.message}`);
  }
  state.expenses.push(entry);
  toast(`Saved ${formatMoney(amount)} · ${shortName(entry.category)}`);
  resetForm();
  renderBadge();
  syncNow();
});

/* ---------- Month ---------- */

function renderMonth() {
  const today = isoDate();
  const expenses = visibleExpenses();
  const s = summarize(expenses, state.month, today);
  const latest = expenses.reduce((max, e) => (e.date > max ? e.date : max), today);
  els.monthLabel.textContent = monthLabel(state.month);
  els.next.disabled = state.month >= monthKey(latest);
  els.total.textContent = formatMoney(s.total);
  els.count.textContent = `${s.count} ${s.count === 1 ? 'entry' : 'entries'}`;
  els.avg.textContent = s.perDay == null ? '—' : formatMoney(s.perDay);
  els.days.textContent = s.days ? `over ${s.days} ${s.days === 1 ? 'day' : 'days'}` : '';
  renderDonut(s);
  els.catTable.innerHTML = s.categories.length
    ? `<thead><tr><th>Category</th><th>Total</th><th>Per day</th></tr></thead><tbody>${s.categories
        .map((c) => `<tr><td><span class="dot" style="background:${colorOf(c.name)}"></span>${escapeHtml(shortName(c.name))}</td>
          <td>${formatMoney(c.total)}</td><td>${c.perDay == null ? '—' : formatMoney(c.perDay)}</td></tr>`)
        .join('')}</tbody>`
    : '';
  renderEntries(s.rows);
}

function renderDonut(s) {
  const r = 46;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = s.total > 0
    ? s.categories.map((c) => {
        const length = (c.total / s.total) * circumference;
        const arc = `<circle r="${r}" cx="60" cy="60" fill="none" stroke="${colorOf(c.name)}" stroke-width="20"
          stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}">
          <title>${escapeHtml(shortName(c.name))}: ${formatMoney(c.total)}</title></circle>`;
        offset += length;
        return arc;
      }).join('')
    : '';
  els.donut.innerHTML = `<g transform="rotate(-90 60 60)"><circle r="${r}" cx="60" cy="60" fill="none" stroke="var(--line)" stroke-width="20"/>${arcs}</g>`;
}

function renderEntries(rows) {
  els.entriesHint.hidden = !rows.length;
  if (!rows.length) {
    els.entries.innerHTML = '<li class="empty">No entries this month.</li>';
    return;
  }
  const dayTotals = new Map();
  for (const e of rows) dayTotals.set(e.date, round2((dayTotals.get(e.date) || 0) + e.amount));
  let html = '';
  let day = '';
  for (const e of rows) {
    if (e.date !== day) {
      day = e.date;
      const w = weekdayIndex(day);
      html += `<li class="day"><span class="wd" style="background:${DAY_COLORS[w]}">${WEEKDAYS[w]}</span>
        <span>${formatDay(day)}</span><span class="day-total">${formatMoney(dayTotals.get(day))}</span></li>`;
    }
    html += `<li><button type="button" class="entry" data-id="${escapeHtml(e.id)}"><span class="dot" style="background:${colorOf(e.category)}"></span>
      <span class="what"><span class="cat">${escapeHtml(shortName(e.category || 'Uncategorized'))}</span>
      ${e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : ''}</span>
      ${e.status !== 'synced' ? '<span class="pending" title="Changed on this phone, waiting to sync">Not synced</span>' : ''}
      <span class="amt">${formatMoney(e.amount)}</span></button></li>`;
  }
  els.entries.innerHTML = html;
}

/* ---------- Entry card: see one expense, delete it ---------- */

els.entries.addEventListener('click', (ev) => {
  const id = ev.target.closest('[data-id]')?.dataset.id;
  const entry = id && state.expenses.find((e) => e.id === id);
  if (entry) openEntryDialog(entry);
});

function openEntryDialog(e) {
  state.viewing = e;
  const w = weekdayIndex(e.date);
  els.entryAmount.textContent = formatMoney(e.amount);
  els.entryCategory.innerHTML = `<span class="dot" style="background:${colorOf(e.category)}"></span> ${escapeHtml(e.category || 'Uncategorized')}`;
  els.entryDate.innerHTML = `<span class="wd" style="background:${DAY_COLORS[w]}">${WEEKDAYS[w]}</span> ${formatDay(e.date)}`;
  els.entryNote.textContent = e.note || '';
  els.entryNote.hidden = els.entryNoteLabel.hidden = !e.note;
  els.entryStatus.textContent =
    e.status === 'pending' ? 'Saved on this phone, waiting to sync'
      : e.status === 'edited' ? 'Edited on this phone, waiting to sync'
        : 'In your sheet';
  els.entryDialog.showModal();
}

/* Edit form: amount, category, date, note. */
els.entryEdit.addEventListener('click', () => {
  const e = state.viewing;
  if (!e) return;
  els.entryDialog.close();
  state.editingEntry = e;
  els.edAmount.value = String(e.amount);
  const choices = e.category && !hasName(state.categories, e.category) ? [...state.categories, e.category] : state.categories;
  els.edCategory.innerHTML =
    '<option value="">Choose a category…</option>' +
    choices.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  els.edCategory.value = e.category || '';
  els.edDate.value = e.date;
  els.edNote.value = e.note || '';
  dialogError(els.edError, '');
  els.editDialog.showModal();
});

els.editForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = state.editingEntry;
  if (!e) return;
  const amount = parseAmount(els.edAmount.value);
  const category = els.edCategory.value;
  const date = els.edDate.value;
  const note = els.edNote.value.trim();
  const problem = !(amount > 0)
    ? 'Enter an amount above 0.'
    : !category
      ? 'Pick a category.'
      : !/^\d{4}-\d{2}-\d{2}$/.test(date)
        ? 'Pick a date.'
        : '';
  if (problem) return dialogError(els.edError, problem);
  els.editDialog.close();
  if (amount === e.amount && category === e.category && date === e.date && note === (e.note || '')) return;
  await db.updateExpense(e.id, { amount, category, date, note }); // shows now; the sheet follows on the next sync
  await reloadData();
  const moved = monthKey(date) !== monthKey(e.date);
  toast(moved ? `Saved · moved to ${monthLabel(monthKey(date))}` : 'Expense saved');
  syncNow();
});
els.editForm.addEventListener('input', () => dialogError(els.edError, ''));
els.editDialog.addEventListener('close', () => (state.editingEntry = null));

els.entryDelete.addEventListener('click', async () => {
  const e = state.viewing;
  const label = e && `${formatMoney(e.amount)} · ${shortName(e.category || 'Uncategorized')}`;
  if (!e || !confirm(`Delete this expense?\n\n${label} on ${formatDay(e.date)}`)) return;
  await db.markDeleted(e.id); // hidden now; removed from the sheet on the next sync
  els.entryDialog.close();
  await reloadData();
  toast(`Deleted ${label}`);
  syncNow();
});
els.entryDialog.addEventListener('close', () => (state.viewing = null));

els.prev.addEventListener('click', () => {
  state.month = shiftMonth(state.month, -1);
  renderMonth();
});
els.next.addEventListener('click', () => {
  state.month = shiftMonth(state.month, 1);
  renderMonth();
});

/* ---------- Sync status + settings ---------- */

function statusText() {
  const n = pendingCount();
  switch (state.sync.state) {
    case 'off': return ['Not connected', 'muted'];
    case 'idle': return ['…', 'muted'];
    case 'syncing': return ['Syncing…', 'muted'];
    case 'offline': return [n ? `Offline · ${n} waiting` : 'Offline', 'warn'];
    case 'error': return ['Sync failed', 'error'];
    default: return n ? [`${n} waiting`, 'warn'] : ['Synced', 'ok'];
  }
}

/*
 * The top-right badge only speaks when there is something to know: changes waiting, offline with
 * changes, a failed sync, not connected, or a sync you asked for. Once everything is synced it says
 * "Synced" for a moment (if it was showing) and hides. Settings → Status always has the details.
 */
let badgeTimer = null;

function setBadge(text, tone) {
  els.badge.textContent = text;
  els.badge.dataset.tone = tone;
  els.badge.hidden = false;
}

function renderBadge() {
  const [text, tone] = statusText();
  const n = pendingCount();
  const s = state.sync.state;
  const quiet =
    tone === 'ok' || s === 'idle' || (s === 'offline' && !n) || (s === 'syncing' && !n && !state.syncRequested);
  if (!quiet) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
    return setBadge(text, tone);
  }
  const wasShowing = !els.badge.hidden && els.badge.dataset.tone !== 'ok';
  if (tone === 'ok' && wasShowing) {
    setBadge('Synced', 'ok');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      els.badge.hidden = true;
      badgeTimer = null;
    }, 1500);
  } else if (!badgeTimer) {
    els.badge.hidden = true;
  }
}

/** A sync you asked for (badge, menu, Settings): show it working even if nothing is waiting. */
function manualSync() {
  state.syncRequested = true;
  renderBadge();
  syncNow();
}

function renderSyncInfo() {
  const last = state.lastSync
    ? new Date(state.lastSync).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : 'never';
  const lines = [
    `<b>Status:</b> ${escapeHtml(statusText()[0])}`,
    `<b>Last synced:</b> ${escapeHtml(last)}`,
    `<b>Waiting to sync:</b> ${pendingCount()}`,
  ];
  if (state.sync.state === 'error' && state.sync.message) lines.push(`<span class="error">${escapeHtml(state.sync.message)}</span>`);
  els.syncInfo.innerHTML = lines.join('<br>');
}

async function fillSettings() {
  const settings = (await db.get('settings')) || {};
  els.syncUrl.value = settings.url || '';
  els.syncKey.value = settings.key || '';
  renderSyncInfo();
  renderConnection();
}

/**
 * Once a sync has worked, the URL and key are tucked away behind "Change connection".
 * They come back by themselves if a sync fails, so a wrong key can be fixed.
 */
function renderConnection() {
  const connected = state.hasSettings && !!state.lastSync && !['error', 'off'].includes(state.sync.state);
  els.connectedCard.hidden = !connected || state.editConnection;
  els.settingsForm.hidden = connected && !state.editConnection;
  els.cancelConnection.hidden = !connected;
}

els.changeConnection.addEventListener('click', async () => {
  state.editConnection = true;
  await fillSettings();
  els.syncUrl.focus();
});
els.cancelConnection.addEventListener('click', () => {
  state.editConnection = false;
  renderConnection();
});

els.badge.addEventListener('click', () => (state.sync.state === 'off' ? showView('settings') : manualSync()));
els.syncNowBtn.addEventListener('click', manualSync);

els.settingsForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = els.syncUrl.value.trim();
  const key = els.syncKey.value.trim();
  if (url && !/^(https:\/\/|http:\/\/localhost[:/])/.test(url)) {
    toast('The Web app URL should start with https://');
    return;
  }
  await db.set('settings', { url, key });
  state.hasSettings = !!(url && key);
  state.editConnection = false; // tucked away again if this sync works; shown again if it fails
  toast(url && key ? 'Saved. Syncing…' : 'Sync is off.');
  manualSync();
});

els.exportBtn.addEventListener('click', () => {
  const blob = new Blob(['﻿' + toCsv(visibleExpenses())], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `bunshe-${isoDate()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

/* ---------- Menu: add, rename and delete shortcuts / categories ---------- */

// Tapping the dimmed backdrop or any [data-close] button closes a dialog.
for (const dialog of [els.menu, els.shortcutDialog, els.categoryDialog, els.listDialog, els.entryDialog, els.editDialog]) {
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog || ev.target.closest('[data-close]')) dialog.close();
  });
}
// After editing an item opened from a list, go back to that list.
for (const dialog of [els.shortcutDialog, els.categoryDialog]) {
  dialog.addEventListener('close', () => {
    const kind = state.returnToList;
    state.returnToList = null;
    state.editing = null;
    if (kind) openList(kind);
  });
}

els.menuBtn.addEventListener('click', () => els.menu.showModal());
els.menu.addEventListener('click', (ev) => {
  const action = ev.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  els.menu.close();
  if (action === 'add-shortcut') openShortcutDialog();
  else if (action === 'add-category') openCategoryDialog();
  else if (action === 'edit-shortcuts') openList('shortcut');
  else if (action === 'edit-categories') openList('category');
  else if (action === 'sync') manualSync();
  else if (action === 'settings') showView('settings');
});

function dialogError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

/* The list of shortcuts or categories to pick one to edit. */
function openList(kind) {
  const isShortcut = kind === 'shortcut';
  els.listDialog.dataset.kind = kind;
  els.listTitle.textContent = isShortcut ? 'Shortcuts' : 'Categories';
  els.listAdd.textContent = isShortcut ? 'Add shortcut' : 'Add category';
  const items = isShortcut ? state.shortcuts : state.categories;
  // Each row: the item (tap to rename / delete) and a ≡ grip to drag it to a new place.
  // Categories show their colour dot (as in the Month view); shortcuts do not.
  const row = (i, name, dot, sub) => `<li class="reorder-row">
      <button type="button" class="row-main" data-index="${i}">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}
        <span class="what"><span>${escapeHtml(name)}</span>${sub ? `<small>${sub}</small>` : ''}</span></button>
      <button type="button" class="grip" data-grip="${i}" aria-label="Move ${escapeHtml(name)}: drag, or use the up and down arrow keys">${GRIP}</button></li>`;
  els.listItems.innerHTML = items.length
    ? items.map((item, i) => isShortcut
      ? row(i, item.name, null, `${formatMoney(item.amount)} · ${escapeHtml(shortName(item.category || '—'))}`)
      : row(i, item, colorOf(item))).join('')
    : `<li class="empty">No ${isShortcut ? 'shortcuts' : 'categories'} yet.</li>`;
  if (!els.listDialog.open) els.listDialog.showModal();
}

/** Moves an item from one place to another: shows at once; moves close together reach the sheet as one change. */
async function reorderList(kind, from, to) {
  const names = kind === 'shortcut' ? state.shortcuts.map((s) => s.name) : state.categories;
  const order = moveTo(names, from, to);
  if (!order) return;
  const type = kind === 'shortcut' ? 'reorderShortcuts' : 'reorderCategories';
  // The newest full order replaces any older one still waiting.
  const queue = ((await db.get('pendingLists')) || []).filter((op) => op.type !== type);
  queue.push({ id: newId(), type, order });
  await db.set('pendingLists', queue);
  await reloadData();
  openList(kind);
  els.listItems.querySelector(`[data-grip="${to}"]`)?.focus({ preventScroll: true });
  clearTimeout(reorderTimer);
  reorderTimer = setTimeout(syncNow, 1500);
}
let reorderTimer;

/*
 * Drag to reorder, built on pointer events: the browser's own drag-and-drop does not work with
 * touch on iPhone. Press the ≡ grip and move: the row follows the finger, the others slide out
 * of the way, and the list scrolls when the finger nears its top or bottom edge.
 */
let drag = null;

els.listItems.addEventListener('pointerdown', (ev) => {
  const grip = ev.target.closest('[data-grip]');
  if (!grip || drag || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
  ev.preventDefault();
  const list = els.listItems;
  const rows = [...list.querySelectorAll('.reorder-row')];
  const from = Number(grip.dataset.grip);
  const top = list.getBoundingClientRect().top;
  // Row centres in list-content coordinates, so scrolling the list does not throw them off.
  const centers = rows.map((r) => {
    const b = r.getBoundingClientRect();
    return b.top - top + list.scrollTop + b.height / 2;
  });
  grip.setPointerCapture(ev.pointerId);
  rows[from].classList.add('dragging');
  rows.forEach((r, k) => k !== from && r.classList.add('shifting'));
  drag = {
    kind: els.listDialog.dataset.kind, pointerId: ev.pointerId, rows, from, to: from, centers,
    height: rows[from].getBoundingClientRect().height, startY: ev.clientY, lastY: ev.clientY,
    startScroll: list.scrollTop, speed: 0, raf: 0,
  };
});

function followFinger() {
  const d = drag;
  const list = els.listItems;
  const dy = d.lastY - d.startY + (list.scrollTop - d.startScroll);
  const min = d.centers[0] - d.centers[d.from] - d.height / 2;
  const max = d.centers.at(-1) - d.centers[d.from] + d.height / 2;
  const y = Math.max(min, Math.min(max, dy));
  d.rows[d.from].style.transform = `translateY(${y}px)`;
  const center = d.centers[d.from] + y;
  d.to = d.centers.filter((c, k) => k !== d.from && c < center).length; // the place it would land
  d.rows.forEach((r, k) => {
    if (k === d.from) return;
    const shift = d.from < d.to && k > d.from && k <= d.to ? -d.height : d.from > d.to && k >= d.to && k < d.from ? d.height : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
  // Near the top or bottom edge of the list: keep scrolling while the finger stays there.
  const box = list.getBoundingClientRect();
  d.speed = d.lastY < box.top + 36 ? -8 : d.lastY > box.bottom - 36 ? 8 : 0;
  if (d.speed && !d.raf) {
    const tick = () => {
      if (!drag || !drag.speed) {
        if (drag) drag.raf = 0;
        return;
      }
      list.scrollTop += drag.speed;
      followFinger();
      drag.raf = requestAnimationFrame(tick);
    };
    d.raf = requestAnimationFrame(tick);
  }
}

els.listItems.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  drag.lastY = ev.clientY;
  followFinger();
});

function endDrag(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const { kind, from, to, rows, raf } = drag;
  cancelAnimationFrame(raf);
  drag = null;
  rows.forEach((r) => {
    r.style.transform = '';
    r.classList.remove('dragging', 'shifting');
  });
  if (to !== from) reorderList(kind, from, to);
}
els.listItems.addEventListener('pointerup', endDrag);
els.listItems.addEventListener('pointercancel', endDrag);

// Keyboard: with the grip focused, the up / down arrow keys move the item one place.
els.listItems.addEventListener('keydown', (ev) => {
  const grip = ev.target.closest('[data-grip]');
  if (!grip || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
  ev.preventDefault();
  const i = Number(grip.dataset.grip);
  reorderList(els.listDialog.dataset.kind, i, i + (ev.key === 'ArrowUp' ? -1 : 1));
});

els.listItems.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-index]');
  if (!button) return;
  const kind = els.listDialog.dataset.kind;
  const i = Number(button.dataset.index);
  els.listDialog.close();
  if (kind === 'shortcut') openShortcutDialog(state.shortcuts[i]);
  else openCategoryDialog(state.categories[i]);
  state.returnToList = kind;
});
els.listAdd.addEventListener('click', () => {
  const kind = els.listDialog.dataset.kind;
  els.listDialog.close();
  if (kind === 'shortcut') openShortcutDialog();
  else openCategoryDialog();
  state.returnToList = kind;
});

/** Add form when `existing` is empty; edit form (with Delete) for an existing shortcut. */
function openShortcutDialog(existing = null) {
  state.editing = existing?.name ?? null;
  // A new shortcut starts from what is on the Add screen: "type it once, then save it as a shortcut".
  const amount = existing ? existing.amount : parseAmount(els.amount.value);
  const category = existing ? existing.category : state.category;
  els.scTitle.textContent = existing ? 'Edit shortcut' : 'Add shortcut';
  els.scSubmit.textContent = existing ? 'Save' : 'Add';
  els.scDelete.hidden = !existing;
  els.scName.value = existing ? existing.name : '';
  els.scAmount.value = amount > 0 ? String(amount) : '';
  const choices = category && !hasName(state.categories, category) ? [...state.categories, category] : state.categories;
  els.scCategory.innerHTML =
    '<option value="">Choose a category…</option>' +
    choices.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  els.scCategory.value = category;
  dialogError(els.scError, '');
  els.shortcutDialog.showModal();
}

/** Add form when `existing` is empty; rename form (with Delete) for an existing category. */
function openCategoryDialog(existing = null) {
  state.editing = existing;
  els.catTitle.textContent = existing ? 'Edit category' : 'Add category';
  els.catSubmit.textContent = existing ? 'Save' : 'Add';
  els.catDelete.hidden = !existing;
  els.catHint.hidden = !existing;
  els.catName.value = existing || '';
  state.pickedColor = existing ? colorOf(existing) : freeColor();
  renderSwatches();
  dialogError(els.catError, '');
  els.categoryDialog.showModal();
}

/* Colour swatches in the category form: the palette, slate, and 🌈 for any colour (the system picker). */
const SWATCHES = [...PALETTE, OTHER_COLOR];

function renderSwatches() {
  els.catSwatches.innerHTML =
    SWATCHES.map((hex) => `<button type="button" class="swatch" data-color="${hex}" style="background:${hex}" aria-label="Colour ${hex}"></button>`).join('') +
    '<label class="swatch custom" title="Any colour"><input type="color" id="catCustomColor" aria-label="Pick any colour"></label>';
  markSwatch();
}

/** Marks the picked colour without rebuilding the swatches (so an open colour picker stays open). */
function markSwatch() {
  const picked = state.pickedColor;
  let onPalette = false;
  for (const b of els.catSwatches.querySelectorAll('[data-color]')) {
    const on = b.dataset.color === picked;
    b.classList.toggle('picked', on);
    b.setAttribute('aria-pressed', String(on));
    onPalette ||= on;
  }
  const custom = els.catSwatches.querySelector('.custom');
  custom.classList.toggle('picked', !onPalette);
  custom.style.background = onPalette ? '' : picked;
  const input = custom.querySelector('input');
  if (input.value !== picked) input.value = picked;
}

els.catSwatches.addEventListener('click', (ev) => {
  const swatch = ev.target.closest('[data-color]');
  if (!swatch) return;
  state.pickedColor = swatch.dataset.color;
  markSwatch();
});
els.catSwatches.addEventListener('input', (ev) => {
  if (ev.target.id !== 'catCustomColor') return;
  state.pickedColor = ev.target.value.toLowerCase();
  markSwatch();
});

/** Queues category/shortcut changes for the sheet and shows them right away. */
async function queueListItem(...items) {
  const queue = (await db.get('pendingLists')) || [];
  for (const item of items) queue.push({ id: newId(), ...item });
  await db.set('pendingLists', queue);
  await reloadData();
  syncNow();
}

els.shortcutForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const original = state.editing;
  const name = els.scName.value.trim();
  const amount = parseAmount(els.scAmount.value);
  const category = els.scCategory.value;
  const others = state.shortcuts.map((s) => s.name).filter((n) => !(original && sameName(n, original)));
  const problem = !name
    ? 'Enter a name.'
    : hasName(others, name)
      ? `You already have a shortcut called "${name}".`
      : !(amount > 0)
        ? 'Enter an amount above 0.'
        : !category
          ? 'Pick a category.'
          : '';
  if (problem) return dialogError(els.scError, problem);
  if (original) await queueListItem({ type: 'updateShortcut', from: original, name, amount, category });
  else await queueListItem({ type: 'shortcut', name, amount, category });
  els.shortcutDialog.close();
  toast(original ? `Shortcut "${name}" saved` : `Shortcut "${name}" added`);
});

els.scDelete.addEventListener('click', async () => {
  const name = state.editing;
  if (!name || !confirm(`Delete the shortcut "${name}"?`)) return;
  await queueListItem({ type: 'deleteShortcut', name });
  els.shortcutDialog.close();
  toast(`Shortcut "${name}" deleted`);
});

els.categoryForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const original = state.editing;
  const name = els.catName.value.trim();
  const others = state.categories.filter((c) => !(original && sameName(c, original)));
  const problem = !name
    ? 'Enter a name.'
    : hasName(others, name)
      ? `"${name}" is already a category.`
      : '';
  if (problem) return dialogError(els.catError, problem);
  const color = state.pickedColor;
  if (!original) {
    await queueListItem({ type: 'category', name }, { type: 'categoryColor', name, color });
    els.categoryDialog.close();
    selectCategory(name); // ready to use straight away
    toast(`Category "${name}" added`);
    return;
  }
  const renamed = name !== original;
  if (renamed) {
    const wasPicked = sameName(state.category, original);
    // The colour goes with the category.
    if (state.colorMap[colorKey(original)] !== undefined) {
      state.colorMap[colorKey(name)] = state.colorMap[colorKey(original)];
      delete state.colorMap[colorKey(original)];
      await db.set('categoryColors', state.colorMap);
    }
    await db.renameCategory(original, name); // entries on this phone follow the new name
    await queueListItem({ type: 'renameCategory', from: original, to: name });
    if (wasPicked) selectCategory(name);
  }
  const recolored = color !== colorOf(name);
  if (recolored) await queueListItem({ type: 'categoryColor', name, color });
  els.categoryDialog.close();
  if (renamed || recolored) toast(renamed ? `Renamed to "${name}"` : 'Colour saved');
});

els.catDelete.addEventListener('click', async () => {
  const name = state.editing;
  if (!name || !confirm(`Delete the category "${name}"?\n\nPast entries keep it. You just won't be able to pick it for new ones.`)) return;
  await queueListItem({ type: 'deleteCategory', name });
  if (sameName(state.category, name)) selectCategory('');
  els.categoryDialog.close();
  toast(`Category "${name}" deleted`);
});

els.shortcutForm.addEventListener('input', () => dialogError(els.scError, ''));
els.categoryForm.addEventListener('input', () => dialogError(els.catError, ''));

/* ---------- Data + lifecycle ---------- */

async function reloadData() {
  const [expenses, categories, shortcuts, lastSync, queue, settings, colors, sheetColors] = await Promise.all([
    db.allExpenses(), db.get('categories'), db.get('shortcuts'), db.get('lastSync'), db.get('pendingLists'), db.get('settings'),
    db.get('categoryColors'), db.get('sheetColors'),
  ]);
  state.colorMap = colors || {};
  state.colorsInSheet = sheetColors != null;
  state.hasSettings = !!(settings?.url && settings?.key);
  const queued = queue || [];
  const lists = applyListOps(
    { categories: categories?.length ? categories : DEFAULT_CATEGORIES, shortcuts: shortcuts || [], colors: sheetColors || {} },
    queued,
  );
  state.expenses = expenses;
  state.categories = lists.categories;
  state.shortcuts = lists.shortcuts;
  state.sheetColors = lists.colors;
  state.queuedLists = queued.length;
  state.lastSync = lastSync || null;
  assignColors();
  renderCategories();
  renderShortcuts();
  renderMonth();
  renderBadge();
  renderSyncInfo();
  renderConnection();
}

onStatus(async (status) => {
  state.sync = status;
  if (status.state === 'syncing') return renderBadge();
  state.syncRequested = false;
  await reloadData();
  if (status.state === 'ok') await seedSheetColors();
  // Something changed while that sync was running: send it now rather than at the next minute.
  if (status.state === 'ok' && pendingCount()) setTimeout(syncNow, 300);
});

// No zoom. Safari on iPhone can ignore user-scalable=no, so also cancel its pinch gestures.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (ev) => {
  if (ev.touches.length > 1) ev.preventDefault(); // two fingers = pinch
}, { passive: false });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Replaces the sheet's daily trigger: an untouched date moves on to the new day.
  if (els.date.value === state.autoDate && state.autoDate !== isoDate()) setToday();
  renderMonth();
  syncNow();
});
window.addEventListener('online', () => syncNow());
setInterval(() => {
  if (pendingCount() && navigator.onLine) syncNow();
}, 60_000);

async function init() {
  els.version.textContent = APP_VERSION;
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  resetForm();
  await reloadData();
  showView('add');
  syncNow();
}

init();
