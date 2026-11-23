/**
 * Accountant At Home: the Home-tab script plus a sync API for the Bunshe app.
 *
 * Paste this over the old Code.gs. Everything the Home tab did still works, and:
 *   - doPost() lets the app add, edit and delete entries, add / rename / delete / reorder
 *     categories and shortcuts, and read the sheet back
 *   - fixes spec issues #1 (monthly trigger made "[object Object]"),
 *     #3 (clearing the Shortcut cell threw an error) and #6 (two time zones)
 * Setup steps: README.md in the app's repository.
 */

const ID_COL = 8; // column H: the app's id for each entry it sends, so a retried send is never added twice
const MONTH_TAB = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/;

function tz_() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone();
}

/* ---------- Home tab (same behaviour as before) ---------- */

function onEdit(e) {
  const range = e.range;
  if (range.getSheet().getName() !== 'Home') return;
  switch (range.getA1Notation()) {
    case 'D2':
      if (range.getValue() === true) {
        setToday();
        range.setValue(false);
      }
      break;
    case 'B4':
      selectShortcut(range.getValue());
      break;
    case 'B6':
      if (range.getValue() === true) save();
      range.setValue(false);
      break;
  }
}

function save() {
  const home = SpreadsheetApp.getActive().getSheetByName('Home');
  const [[amount], [date], [category], , [note]] = home.getRange('B1:B5').getValues();
  if (!(date instanceof Date)) throw new Error('The date in B2 is not a valid date.');
  appendExpense_(date, amount, category, note, '');
  home.getRange('B1:B6').setValues([[0], [todayText_()], [''], [''], [''], [false]]);
}

function selectShortcut(name) {
  if (!name) return; // the cell was cleared
  const ss = SpreadsheetApp.getActive();
  const list = ss.getSheetByName('Shortcut');
  const cell = list.getRange('A:A').createTextFinder(String(name)).matchEntireCell(true).findNext();
  if (!cell) return;
  const [[, amount, category]] = list.getRange(cell.getRow(), 1, 1, 3).getValues();
  const home = ss.getSheetByName('Home');
  home.getRange('B1').setValue(amount);
  home.getRange('B3').setValue(category);
  setToday();
}

function setToday() {
  SpreadsheetApp.getActive().getSheetByName('Home').getRange('B2').setValue(todayText_());
}

function todayText_() {
  return Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy');
}

/* ---------- Month tabs ---------- */

/** Returns the tab for a month, copying Template first if it does not exist yet. */
function addNewMonthSheet(sheetName) {
  const ss = SpreadsheetApp.getActive();
  // A time-driven trigger passes an event object here, so only a text name counts.
  const name = typeof sheetName === 'string' ? sheetName : Utilities.formatDate(new Date(), tz_(), 'MMM yyyy');
  const existing = ss.getSheetByName(name);
  if (existing) return existing;
  const template = ss.getSheetByName('Template');
  if (!template) throw new Error('Template sheet not found.');
  const sheet = template.copyTo(ss).setName(name);
  setChartTitleToSheetName(sheet);
  sheet.showSheet();
  return sheet;
}

function setChartTitleToSheetName(sheet) {
  sheet.getCharts().forEach((chart) => {
    sheet.updateChart(chart.modify().setOption('title', sheet.getName() + ' Expense Chart').build());
  });
}

/** Writes one entry under the last filled row of its month tab. Returns false if the id is already there. */
function appendExpense_(date, amount, category, note, id) {
  const sheet = addNewMonthSheet(Utilities.formatDate(date, tz_(), 'MMM yyyy'));
  const last = lastEntryRow_(sheet);
  if (id && last > 1) {
    const ids = sheet.getRange(2, ID_COL, last - 1, 1).getValues();
    if (ids.some(([value]) => value === id)) return false;
  }
  const row = last + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  sheet.getRange(row, 1, 1, 4).setValues([[date, amount, category, note]]);
  if (id) {
    sheet.getRange(row, ID_COL).setValue(id);
    if (!sheet.isColumnHiddenByUser(ID_COL)) sheet.hideColumns(ID_COL);
  }
  return true;
}

function lastEntryRow_(sheet) {
  const values = sheet.getRange(1, 1, sheet.getMaxRows(), 1).getValues();
  for (let i = values.length - 1; i > 0; i--) if (values[i][0] !== '') return i + 1;
  return 1;
}

/* ---------- Sync API for the app ---------- */

/** Run once from the editor. Prints the key to paste into the app's Settings. */
function createSyncKey() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('SYNC_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SYNC_KEY', key);
  }
  console.log('Sync key (paste into the app): ' + key);
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
    if (!key || req.key !== key) return reply_({ ok: false, error: 'Wrong sync key. Run createSyncKey again and copy the key from the log.' });
    if (req.action === 'pull') return reply_(Object.assign({ ok: true }, pull_()));
    if (['add', 'lists', 'delete', 'update'].indexOf(req.action) >= 0) {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        if (req.action === 'lists') {
          (req.ops || []).forEach(applyListOp_);
          return reply_({ ok: true });
        }
        if (req.action === 'delete') {
          const deleted = (req.entries || []).filter(deleteExpense_).length;
          return reply_({ ok: true, deleted: deleted });
        }
        if (req.action === 'update') {
          const updated = (req.entries || []).filter(updateExpense_).length;
          return reply_({ ok: true, updated: updated });
        }
        const added = req.entries.filter(addFromApp_).length;
        return reply_({ ok: true, added: added });
      } finally {
        lock.releaseLock();
      }
    }
    return reply_({ ok: false, error: 'Unknown action: ' + req.action });
  } catch (err) {
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return reply_({ ok: true, app: 'Accountant At Home sync', note: 'The Bunshe app talks to this URL with POST.' });
}

function addFromApp_(entry) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error('Bad date: ' + entry.date);
  const amount = Number(entry.amount);
  if (!(amount >= 0)) throw new Error('Bad amount: ' + entry.amount);
  const date = Utilities.parseDate(entry.date, tz_(), 'yyyy-MM-dd');
  return appendExpense_(date, amount, String(entry.category || ''), String(entry.note || ''), String(entry.id));
}

/**
 * Finds an entry's row, given the values the sheet row has (`v`: date, amount, category, note).
 * Entries the app sent are found by their id (column H). Rows typed in the sheet are found by their
 * old row number, but only if that row still holds the same date, amount, category and note
 * (otherwise the first row that does) — so a moved or changed row is never touched by mistake.
 * Returns { sheet, row }, or null when it is not there (already gone, or changed in the sheet).
 */
function findExpense_(id, v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw new Error('Bad date: ' + (v && v.date));
  const tz = tz_();
  const sheet = SpreadsheetApp.getActive().getSheetByName(
    Utilities.formatDate(Utilities.parseDate(v.date, tz, 'yyyy-MM-dd'), tz, 'MMM yyyy'));
  if (!sheet) return null;
  const last = lastEntryRow_(sheet);
  if (last < 2) return null;
  const rows = sheet.getRange(2, 1, last - 1, ID_COL).getValues();
  id = String(id || '');
  const same = (r) =>
    r[0] instanceof Date &&
    Utilities.formatDate(r[0], tz, 'yyyy-MM-dd') === v.date &&
    Math.abs((Number(r[1]) || 0) - Number(v.amount)) < 0.005 &&
    String(r[2]) === String(v.category || '') &&
    String(r[3]) === String(v.note || '');
  let i;
  const typedRow = /!(\d+)$/.exec(id); // "Nov 2026!5" = row 5, typed in the sheet
  if (!typedRow) {
    i = rows.findIndex((r) => String(r[ID_COL - 1]) === id);
  } else {
    const guess = Number(typedRow[1]) - 2;
    i = rows[guess] && !rows[guess][ID_COL - 1] && same(rows[guess]) ? guess : rows.findIndex((r) => !r[ID_COL - 1] && same(r));
  }
  return i < 0 ? null : { sheet: sheet, row: i + 2 };
}

/**
 * Removes only the entry's own cells (Date, Amount, Category, Note and the id in H); the cells
 * below move up, so totals, the chart and other formulas are left alone.
 */
function removeCells_(found) {
  found.sheet.getRange(found.row, 1, 1, 4).deleteCells(SpreadsheetApp.Dimension.ROWS);
  found.sheet.getRange(found.row, ID_COL).deleteCells(SpreadsheetApp.Dimension.ROWS);
}

/** Deletes one entry the app deleted. Returns false if there was nothing to delete. */
function deleteExpense_(e) {
  const found = findExpense_(e.id, e);
  if (!found) return false;
  removeCells_(found);
  return true;
}

/**
 * Applies one edit made in the app. `u.orig` = the values the sheet row had, to find it.
 * Same month: the row is updated in place. New month: it moves to that month's tab.
 * Returns false if the row is gone or was changed in the sheet meanwhile (the sheet wins).
 */
function updateExpense_(u) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(u.date)) throw new Error('Bad date: ' + u.date);
  const amount = Number(u.amount);
  if (!(amount >= 0)) throw new Error('Bad amount: ' + u.amount);
  const found = findExpense_(u.id, u.orig || u);
  if (!found) return false;
  const tz = tz_();
  const date = Utilities.parseDate(u.date, tz, 'yyyy-MM-dd');
  const category = String(u.category || '');
  const note = String(u.note || '');
  if (found.sheet.getName() === Utilities.formatDate(date, tz, 'MMM yyyy')) {
    found.sheet.getRange(found.row, 1, 1, 4).setValues([[date, amount, category, note]]);
    return true;
  }
  const appId = /!\d+$/.test(String(u.id)) ? '' : String(u.id); // rows typed in the sheet have no id
  removeCells_(found);
  appendExpense_(date, amount, category, note, appId);
  return true;
}

/* ---------- Categories and Shortcut tabs (changes made in the app) ---------- */

const sameName_ = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** One change from the app's queue. Same ops, same meaning as applyListOps in the app's logic.js. */
function applyListOp_(op) {
  switch (op && op.type) {
    case 'category': return addCategory_(op.name);
    case 'renameCategory': return renameCategory_(op.from, op.to);
    case 'deleteCategory': return deleteCategory_(op.name);
    case 'shortcut': return putShortcut_(op.name, op);
    case 'updateShortcut': return putShortcut_(op.from, op);
    case 'deleteShortcut': return deleteShortcut_(op.name);
    case 'reorderCategories': return reorderCategories_(op.order || []);
    case 'reorderShortcuts': return reorderShortcuts_(op.order || []);
    default: throw new Error('Unknown change: ' + (op && op.type));
  }
}

/** Same as sortByOrder in the app's logic.js: names in `order` first, the rest after in their old order. */
function sortByOrder_(items, order, nameOf) {
  const rank = (item) => {
    const i = order.findIndex((o) => sameName_(o, nameOf(item)));
    return i < 0 ? order.length : i;
  };
  return items
    .map((item, i) => ({ item: item, i: i }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
    .map((x) => x.item);
}

/** New category order. Names move between the cells that hold names, so blank rows stay blank. */
function reorderCategories_(order) {
  const c = categoryCells_();
  const filled = [];
  c.values.forEach(([v], i) => { if (v !== '') filled.push(i); });
  if (filled.length < 2) return;
  const sorted = sortByOrder_(filled.map((i) => c.values[i][0]), order, (v) => v);
  filled.forEach((i, k) => { c.values[i][0] = sorted[k]; });
  const span = filled[filled.length - 1] + 1;
  c.sheet.getRange(2, 1, span, 1).setValues(c.values.slice(0, span));
}

/** New shortcut order. Whole rows (name, amount, category) move; the "-" reset row and blank rows stay put. */
function reorderShortcuts_(order) {
  const sheet = tab_('Shortcut');
  const last = sheet.getLastRow();
  if (last < 3) return;
  const rows = sheet.getRange(2, 1, last - 1, 3).getValues();
  const movable = [];
  rows.forEach((r, i) => { if (r[0] !== '' && r[0] !== '-') movable.push(i); });
  const sorted = sortByOrder_(movable.map((i) => rows[i]), order, (r) => r[0]);
  movable.forEach((i, k) => { rows[i] = sorted[k]; });
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
}

function tab_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error(name + ' tab not found.');
  return sheet;
}

/** Column A of the Categories tab from row 2, and the row of `name` in it (0 if missing). */
function categoryCells_() {
  const sheet = tab_('Categories');
  const values = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
  const rowOf = (name) => {
    const i = values.findIndex(([v]) => v !== '' && sameName_(v, name));
    return i >= 0 ? i + 2 : 0;
  };
  return { sheet: sheet, values: values, rowOf: rowOf };
}

/** Adds a category in the first empty cell of the Categories tab (so "Others" stays last). Skips names already there. */
function addCategory_(name) {
  name = String(name || '').trim();
  if (!name) return;
  const c = categoryCells_();
  if (c.rowOf(name)) return;
  const empty = c.values.findIndex(([v]) => v === '');
  const row = empty >= 0 ? empty + 2 : c.sheet.getMaxRows() + 1;
  if (row > c.sheet.getMaxRows()) c.sheet.insertRowsAfter(c.sheet.getMaxRows(), 10);
  c.sheet.getRange(row, 1).setValue(name);
}

/** Renames a category, and every past entry, shortcut and the Home form that use it. */
function renameCategory_(from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!from || !to) return;
  const c = categoryCells_();
  const row = c.rowOf(from);
  const taken = !sameName_(from, to) && c.rowOf(to);
  if (row) {
    if (taken) c.sheet.getRange(row, 1).clearContent(); // the new name already exists: the two become one
    else c.sheet.getRange(row, 1).setValue(to);
  }
  const ss = SpreadsheetApp.getActive();
  ss.getSheets().filter((s) => MONTH_TAB.test(s.getName())).forEach((s) => replaceInColumn_(s, 3, from, to));
  const shortcuts = ss.getSheetByName('Shortcut');
  if (shortcuts) replaceInColumn_(shortcuts, 3, from, to);
  const home = ss.getSheetByName('Home');
  if (home && sameName_(home.getRange('B3').getValue(), from)) home.getRange('B3').setValue(to);
}

/** Removes a category from the list. Past entries keep it. */
function deleteCategory_(name) {
  const c = categoryCells_();
  const row = c.rowOf(name);
  if (row) c.sheet.getRange(row, 1).clearContent();
}

function replaceInColumn_(sheet, col, from, to) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  sheet.getRange(2, col, last - 1, 1).createTextFinder(from).matchEntireCell(true).matchCase(false).replaceAllWith(to);
}

/** Row of a shortcut on the Shortcut tab (0 if missing). */
function shortcutRow_(sheet, name) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const i = sheet.getRange(2, 1, last - 1, 1).getValues().findIndex(([v]) => sameName_(v, name));
  return i >= 0 ? i + 2 : 0;
}

/** Updates the shortcut named `key` (rename included), or adds it under the last one. */
function putShortcut_(key, s) {
  const name = String((s && s.name) || '').trim();
  if (!name) return;
  const sheet = tab_('Shortcut');
  const row = shortcutRow_(sheet, key || name) || Math.max(sheet.getLastRow(), 1) + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 10);
  sheet.getRange(row, 1, 1, 3).setValues([[name, Number(s.amount) || 0, String(s.category || '')]]);
}

function deleteShortcut_(name) {
  const sheet = tab_('Shortcut');
  const row = shortcutRow_(sheet, name);
  if (row) sheet.deleteRow(row);
}

function pull_() {
  const ss = SpreadsheetApp.getActive();
  const tz = tz_();
  const expenses = [];
  ss.getSheets().forEach((sheet) => {
    const tab = sheet.getName();
    if (!MONTH_TAB.test(tab) || sheet.getMaxRows() < 2) return;
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, ID_COL).getValues().forEach((r, i) => {
      if (!(r[0] instanceof Date)) return;
      expenses.push({
        id: r[ID_COL - 1] ? String(r[ID_COL - 1]) : tab + '!' + (i + 2),
        date: Utilities.formatDate(r[0], tz, 'yyyy-MM-dd'),
        amount: Number(r[1]) || 0,
        category: String(r[2]),
        note: String(r[3]),
        seq: i + 2,
      });
    });
  });
  return {
    expenses: expenses,
    categories: listRows_('Categories', 1).map((r) => String(r[0])),
    shortcuts: listRows_('Shortcut', 3)
      .filter((r) => r[0] !== '-')
      .map((r) => ({ name: String(r[0]), amount: Number(r[1]) || 0, category: String(r[2]) })),
    timeZone: tz,
  };
}

function listRows_(tabName, width) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues().filter((r) => r[0] !== '');
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
