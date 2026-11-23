import * as db from './db.js';
import { syncNow, onStatus } from './sync.js';
import {
  DEFAULT_CATEGORIES, WEEKDAYS, DAY_COLORS, isoDate, monthKey, monthLabel, shiftMonth, summarize,
  parseAmount, round2, formatMoney, formatDay, shortName, weekdayIndex, toCsv,
  applyListOps, hasName, sameName,
} from './logic.js';

const APP_VERSION = '1.3.0';
const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
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
  shortcutDialog: $('#shortcutDialog'), shortcutForm: $('#shortcutForm'), scTitle: $('#shortcutDialogTitle'),
  scName: $('#scName'), scAmount: $('#scAmount'), scCategory: $('#scCategory'), scError: $('#scError'),
  scSubmit: $('#scSubmit'), scDelete: $('#scDelete'),
  categoryDialog: $('#categoryDialog'), categoryForm: $('#categoryForm'), catTitle: $('#categoryDialogTitle'),
  catName: $('#catName'), catError: $('#catError'), catHint: $('#catHint'), catSubmit: $('#catSubmit'), catDelete: $('#catDelete'),
  listDialog: $('#listDialog'), listTitle: $('#listDialogTitle'), listItems: $('#listItems'), listAdd: $('#listAdd'),
  entriesHint: $('#entriesHint'), entryDialog: $('#entryDialog'), entryAmount: $('#entryAmount'),
  entryCategory: $('#entryCategory'), entryDate: $('#entryDate'), entryNote: $('#entryNote'),
  entryNoteLabel: $('#entryNoteLabel'), entryStatus: $('#entryStatus'), entryDelete: $('#entryDelete'),
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
  queuedLists: 0, // category/shortcut changes made here, not yet in the sheet
  syncRequested: false, // you tapped Sync now: show progress even when nothing is waiting
  viewing: null, // the expense open in the entry card
  editing: null, // the shortcut or category name being edited, or null when adding
  returnToList: null, // 'shortcut' | 'category': reopen that list when the edit form closes
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const colorOf = (category) => {
  if (category === 'Others') return OTHER_COLOR;
  const i = state.categories.filter((c) => c !== 'Others').indexOf(category);
  return i >= 0 ? PALETTE[i % PALETTE.length] : OTHER_COLOR;
};
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
    state.shortcuts.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} · ${formatMoney(s.amount)}</option>`).join('');
  if (state.shortcuts.some((s) => s.name === picked)) els.shortcut.value = picked; // a sync mid-entry keeps the pick
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
      ${e.status === 'pending' ? '<span class="pending" title="Saved on this phone, waiting to sync">Not synced</span>' : ''}
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
  els.entryStatus.textContent = e.status === 'pending' ? 'Saved on this phone, waiting to sync' : 'In your sheet';
  els.entryDialog.showModal();
}

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
}

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
  toast(url && key ? 'Saved. Syncing…' : 'Sync is off.');
  syncNow();
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
for (const dialog of [els.menu, els.shortcutDialog, els.categoryDialog, els.listDialog, els.entryDialog]) {
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
  els.listItems.innerHTML = items.length
    ? items.map((item, i) => isShortcut
      ? `<li><button type="button" data-index="${i}"><span class="dot" style="background:${colorOf(item.category)}"></span>
          <span class="what"><span>${escapeHtml(item.name)}</span><small>${formatMoney(item.amount)} · ${escapeHtml(shortName(item.category || '—'))}</small></span>${CHEVRON}</button></li>`
      : `<li><button type="button" data-index="${i}"><span class="dot" style="background:${colorOf(item)}"></span>
          <span class="what"><span>${escapeHtml(item)}</span></span>${CHEVRON}</button></li>`).join('')
    : `<li class="empty">No ${isShortcut ? 'shortcuts' : 'categories'} yet.</li>`;
  if (!els.listDialog.open) els.listDialog.showModal();
}

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
  els.catTitle.textContent = existing ? 'Rename category' : 'Add category';
  els.catSubmit.textContent = existing ? 'Save' : 'Add';
  els.catDelete.hidden = !existing;
  els.catHint.hidden = !existing;
  els.catName.value = existing || '';
  dialogError(els.catError, '');
  els.categoryDialog.showModal();
}

/** Queues a category/shortcut change for the sheet and shows it right away. */
async function queueListItem(item) {
  const queue = (await db.get('pendingLists')) || [];
  queue.push({ id: newId(), ...item });
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
  if (!original) {
    await queueListItem({ type: 'category', name });
    els.categoryDialog.close();
    selectCategory(name); // ready to use straight away
    toast(`Category "${name}" added`);
    return;
  }
  if (name !== original) {
    const wasPicked = sameName(state.category, original);
    await db.renameCategory(original, name); // entries on this phone follow the new name
    await queueListItem({ type: 'renameCategory', from: original, to: name });
    if (wasPicked) selectCategory(name);
  }
  els.categoryDialog.close();
  toast(`Renamed to "${name}"`);
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
  const [expenses, categories, shortcuts, lastSync, queue] = await Promise.all([
    db.allExpenses(), db.get('categories'), db.get('shortcuts'), db.get('lastSync'), db.get('pendingLists'),
  ]);
  const queued = queue || [];
  const lists = applyListOps({ categories: categories?.length ? categories : DEFAULT_CATEGORIES, shortcuts: shortcuts || [] }, queued);
  state.expenses = expenses;
  state.categories = lists.categories;
  state.shortcuts = lists.shortcuts;
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
  if (status.state === 'syncing') return renderBadge();
  state.syncRequested = false;
  await reloadData();
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
