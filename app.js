import * as db from './db.js';
import { syncNow, onStatus } from './sync.js';
import {
  DEFAULT_CATEGORIES, WEEKDAYS, DAY_COLORS, isoDate, monthKey, monthLabel, shiftMonth, summarize,
  parseAmount, round2, formatMoney, formatDay, shortName, weekdayIndex, toCsv,
  mergeCategories, mergeShortcuts, hasName,
} from './logic.js';

const APP_VERSION = '1.1.1';
// Category colours, kept clear of the teal accent so a selected chip still shows its dot.
// "Others" is always slate; the rest take colours in list order, so a new category never shifts them.
const PALETTE = ['#f97316', '#8b5cf6', '#3b82f6', '#ef4444', '#eab308', '#ec4899', '#22c55e', '#06b6d4', '#a16207', '#84cc16', '#d946ef'];
const OTHER_COLOR = '#64748b';
const TITLES = { add: 'Add expense', month: 'Month', settings: 'Settings' };

const $ = (selector) => document.querySelector(selector);
const els = {
  title: $('#title'), badge: $('#syncBadge'), toast: $('#toast'), version: $('#version'),
  form: $('#entry'), amount: $('#amount'), steps: document.querySelectorAll('[data-step]'), clear: $('#clearAmount'),
  shortcut: $('#shortcut'), shortcutsEmpty: $('#shortcutsEmpty'), categories: $('#categories'),
  date: $('#date'), today: $('#today'), note: $('#note'), error: $('#formError'),
  monthLabel: $('#monthLabel'), prev: $('#prevMonth'), next: $('#nextMonth'),
  total: $('#mTotal'), count: $('#mCount'), avg: $('#mAvg'), days: $('#mDays'),
  donut: $('#donut'), catTable: $('#catTable'), entries: $('#entries'),
  settingsForm: $('#settingsForm'), syncUrl: $('#syncUrl'), syncKey: $('#syncKey'),
  syncInfo: $('#syncInfo'), syncNowBtn: $('#syncNow'), exportBtn: $('#exportCsv'),
  menuBtn: $('#menuBtn'), menu: $('#menu'),
  shortcutDialog: $('#shortcutDialog'), shortcutForm: $('#shortcutForm'),
  scName: $('#scName'), scAmount: $('#scAmount'), scCategory: $('#scCategory'), scError: $('#scError'),
  categoryDialog: $('#categoryDialog'), categoryForm: $('#categoryForm'), catName: $('#catName'), catError: $('#catError'),
};

const state = {
  categories: DEFAULT_CATEGORIES,
  shortcuts: [],
  expenses: [],
  category: '',
  month: monthKey(isoDate()),
  autoDate: '', // the date the app filled in itself; it moves to the new day if untouched
  sync: { state: 'idle' },
  lastSync: null,
  queuedLists: 0, // categories/shortcuts added here, not yet in the sheet
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const colorOf = (category) => {
  if (category === 'Others') return OTHER_COLOR;
  const i = state.categories.filter((c) => c !== 'Others').indexOf(category);
  return i >= 0 ? PALETTE[i % PALETTE.length] : OTHER_COLOR;
};
const pendingCount = () => state.expenses.filter((e) => e.status === 'pending').length + state.queuedLists;

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

function resetForm() {
  setAmount(0);
  selectCategory('');
  els.shortcut.value = '';
  els.note.value = '';
  setToday();
  showError('');
}

function renderCategories() {
  els.categories.innerHTML = state.categories
    .map((c) => `<button type="button" class="chip" data-cat="${escapeHtml(c)}" aria-pressed="${c === state.category}" title="${escapeHtml(c)}">
      <span class="dot" style="background:${colorOf(c)}"></span>${escapeHtml(shortName(c))}</button>`)
    .join('');
}

function renderShortcuts() {
  const none = state.shortcuts.length === 0;
  const picked = els.shortcut.value;
  els.shortcutsEmpty.hidden = !none;
  els.shortcut.disabled = none;
  els.shortcut.innerHTML =
    `<option value="">${none ? 'No shortcuts yet' : 'Choose a shortcut…'}</option>` +
    state.shortcuts.map((s, i) => `<option value="${i}">${escapeHtml(s.name)} · ${formatMoney(s.amount)}</option>`).join('');
  if (picked !== '' && Number(picked) < state.shortcuts.length) els.shortcut.value = picked; // a sync mid-entry keeps the pick
}

els.steps.forEach((button) =>
  button.addEventListener('click', () => {
    const current = parseAmount(els.amount.value);
    setAmount((Number.isNaN(current) ? 0 : current) + Number(button.dataset.step));
  }),
);
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
  if (els.shortcut.value === '') return;
  const s = state.shortcuts[Number(els.shortcut.value)];
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
  const s = summarize(state.expenses, state.month, today);
  const latest = state.expenses.reduce((max, e) => (e.date > max ? e.date : max), today);
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
    html += `<li class="entry"><span class="dot" style="background:${colorOf(e.category)}"></span>
      <span class="what"><span class="cat">${escapeHtml(shortName(e.category || 'Uncategorized'))}</span>
      ${e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : ''}</span>
      ${e.status === 'pending' ? '<span class="pending" title="Saved on this phone, waiting to sync">Not synced</span>' : ''}
      <span class="amt">${formatMoney(e.amount)}</span></li>`;
  }
  els.entries.innerHTML = html;
}

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

function renderBadge() {
  const [text, tone] = statusText();
  els.badge.textContent = text;
  els.badge.dataset.tone = tone;
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
}

els.badge.addEventListener('click', () => (state.sync.state === 'off' ? showView('settings') : syncNow()));
els.syncNowBtn.addEventListener('click', () => syncNow());

els.settingsForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = els.syncUrl.value.trim();
  const key = els.syncKey.value.trim();
  if (url && !/^(https:\/\/|http:\/\/localhost[:/])/.test(url)) {
    toast('The Web app URL should start with https://');
    return;
  }
  await db.set('settings', { url, key });
  toast(url && key ? 'Saved. Syncing…' : 'Sync is off.');
  syncNow();
});

els.exportBtn.addEventListener('click', () => {
  const blob = new Blob(['﻿' + toCsv(state.expenses)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `bunshe-${isoDate()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

/* ---------- Menu: add shortcut / add category ---------- */

// Tapping the dimmed backdrop or any [data-close] button closes a dialog.
for (const dialog of [els.menu, els.shortcutDialog, els.categoryDialog]) {
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog || ev.target.closest('[data-close]')) dialog.close();
  });
}

els.menuBtn.addEventListener('click', () => els.menu.showModal());
els.menu.addEventListener('click', (ev) => {
  const action = ev.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  els.menu.close();
  if (action === 'add-shortcut') openShortcutDialog();
  else if (action === 'add-category') openCategoryDialog();
  else if (action === 'sync') syncNow();
  else if (action === 'settings') showView('settings');
});

function dialogError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function openShortcutDialog() {
  // Start from what is on the Add screen, so "type it once, then save it as a shortcut" works.
  const amount = parseAmount(els.amount.value);
  els.scName.value = '';
  els.scAmount.value = amount > 0 ? String(amount) : '';
  els.scCategory.innerHTML =
    '<option value="">Choose a category…</option>' +
    state.categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  els.scCategory.value = state.category;
  dialogError(els.scError, '');
  els.shortcutDialog.showModal();
}

function openCategoryDialog() {
  els.catName.value = '';
  dialogError(els.catError, '');
  els.categoryDialog.showModal();
}

/** Queues a new category or shortcut for the sheet and shows it right away. */
async function queueListItem(item) {
  const queue = (await db.get('pendingLists')) || [];
  queue.push({ id: newId(), ...item });
  await db.set('pendingLists', queue);
  await reloadData();
  syncNow();
}

els.shortcutForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = els.scName.value.trim();
  const amount = parseAmount(els.scAmount.value);
  const category = els.scCategory.value;
  const problem = !name
    ? 'Enter a name.'
    : hasName(state.shortcuts.map((s) => s.name), name)
      ? `You already have a shortcut called "${name}".`
      : !(amount > 0)
        ? 'Enter an amount above 0.'
        : !category
          ? 'Pick a category.'
          : '';
  if (problem) return dialogError(els.scError, problem);
  await queueListItem({ type: 'shortcut', name, amount, category });
  els.shortcutDialog.close();
  toast(`Shortcut "${name}" added`);
});

els.categoryForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = els.catName.value.trim();
  const problem = !name
    ? 'Enter a name.'
    : hasName(state.categories, name)
      ? `"${name}" is already a category.`
      : '';
  if (problem) return dialogError(els.catError, problem);
  await queueListItem({ type: 'category', name });
  els.categoryDialog.close();
  selectCategory(name); // ready to use straight away
  toast(`Category "${name}" added`);
});
els.shortcutForm.addEventListener('input', () => dialogError(els.scError, ''));
els.categoryForm.addEventListener('input', () => dialogError(els.catError, ''));

/* ---------- Data + lifecycle ---------- */

async function reloadData() {
  const [expenses, categories, shortcuts, lastSync, queue] = await Promise.all([
    db.allExpenses(), db.get('categories'), db.get('shortcuts'), db.get('lastSync'), db.get('pendingLists'),
  ]);
  const queued = queue || [];
  state.expenses = expenses;
  state.categories = mergeCategories(categories?.length ? categories : DEFAULT_CATEGORIES, queued);
  state.shortcuts = mergeShortcuts(shortcuts || [], queued);
  state.queuedLists = queued.length;
  state.lastSync = lastSync || null;
  renderCategories();
  renderShortcuts();
  renderMonth();
  renderBadge();
  renderSyncInfo();
}

onStatus(async (status) => {
  state.sync = status;
  if (status.state === 'syncing') renderBadge();
  else await reloadData();
});

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
