/**
 * Accountant At Home: the Home-tab script plus a sync API for the Bunshe app.
 *
 * Paste this over the old Code.gs. Everything the Home tab did still works, and:
 *   - doPost() lets the app send new entries, add categories and shortcuts, and read the sheet back
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
    if (req.action === 'add' || req.action === 'addLists') {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        if (req.action === 'addLists') {
          (req.categories || []).forEach(addCategory_);
          (req.shortcuts || []).forEach(addShortcut_);
          return reply_({ ok: true });
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

const sameName_ = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Adds a category in the first empty cell of the Categories tab (so "Others" stays last). Skips names already there. */
function addCategory_(name) {
  name = String(name || '').trim();
  if (!name) return;
  const sheet = SpreadsheetApp.getActive().getSheetByName('Categories');
  if (!sheet) throw new Error('Categories tab not found.');
  const values = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
  if (values.some(([v]) => v !== '' && sameName_(v, name))) return;
  const empty = values.findIndex(([v]) => v === '');
  const row = empty >= 0 ? empty + 2 : sheet.getMaxRows() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 10);
  sheet.getRange(row, 1).setValue(name);
}

/** Adds a shortcut under the last one on the Shortcut tab; a name already there gets its amount and category updated. */
function addShortcut_(s) {
  const name = String((s && s.name) || '').trim();
  if (!name) return;
  const sheet = SpreadsheetApp.getActive().getSheetByName('Shortcut');
  if (!sheet) throw new Error('Shortcut tab not found.');
  const last = Math.max(sheet.getLastRow(), 1);
  const names = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
  const found = names.findIndex(([v]) => sameName_(v, name));
  const row = found >= 0 ? found + 2 : last + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 10);
  sheet.getRange(row, 1, 1, 3).setValues([[name, Number(s.amount) || 0, String(s.category || '')]]);
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
