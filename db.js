// On-phone storage (IndexedDB). Two stores:
//   expenses — one record per entry: { id, date, amount, category, note, status, seq?, createdAt? }
//              status 'pending' = saved here, not yet in the sheet; 'synced' = a copy of a sheet row;
//              'deleted' = deleted here, waiting to be deleted in the sheet (hidden in the app);
//              'edited' = a sheet row changed here, waiting to be updated in the sheet.
//              orig = the values the sheet row still has, so the sheet script can find the row.
//   kv       — small values: settings, categories, shortcuts, lastSync

const DB_NAME = 'bunshe';
const DB_VERSION = 1;
let connection;

function open() {
  connection ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('expenses', { keyPath: 'id' });
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return connection;
}

const finished = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const result = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function allExpenses() {
  const db = await open();
  return result(db.transaction('expenses').objectStore('expenses').getAll());
}

export async function putExpense(entry) {
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  tx.objectStore('expenses').put(entry);
  return finished(tx);
}

const VALUE_KEYS = ['date', 'amount', 'category', 'note'];
/** The four values a sheet row holds. */
export const values = (e) => ({ date: e.date, amount: e.amount, category: e.category, note: e.note || '' });
const sameValues = (a, b) => VALUE_KEYS.every((k) => (a[k] ?? '') === (b[k] ?? ''));

/**
 * After the sheet accepted `sent` (new entries or edits): those entries are now synced.
 * One changed again while it was being sent becomes 'edited', with orig = what the sheet now has.
 * One deleted meanwhile stays deleted.
 */
export async function settle(sent) {
  const current = new Map((await allExpenses()).map((e) => [e.id, e]));
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  for (const s of sent) {
    const e = current.get(s.id);
    if (!e || e.status === 'deleted' || e.status === 'synced') continue;
    const { orig, ...rest } = e;
    if (sameValues(e, s)) store.put({ ...rest, status: 'synced' });
    else store.put({ ...rest, status: 'edited', orig: values(s) });
  }
  return finished(tx);
}

/** Changes an entry's values here; the sheet follows on the next sync. */
export async function updateExpense(id, changes) {
  const e = (await allExpenses()).find((x) => x.id === id);
  if (!e || e.status === 'deleted') return;
  let next = { ...e, ...changes };
  // A synced row becomes 'edited' and remembers what the sheet has. A pending one is simply sent with its new values.
  if (e.status === 'synced') next = { ...next, status: 'edited', orig: values(e) };
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  tx.objectStore('expenses').put(next);
  return finished(tx);
}

/** Hides an entry at once and remembers to delete it from the sheet on the next sync. */
export async function markDeleted(id) {
  const current = (await allExpenses()).find((e) => e.id === id);
  if (!current) return;
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  tx.objectStore('expenses').put({ ...current, status: 'deleted' });
  return finished(tx);
}

/** Forgets entries for good (after the sheet confirmed their deletion). */
export async function removeExpenses(ids) {
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  for (const id of ids) store.delete(id);
  return finished(tx);
}

/**
 * The sheet is the main copy: its rows replace every synced entry here.
 * Pending entries stay, unless the sheet already has them (a send whose reply was lost).
 * Entries deleted or edited here keep their local version, even if the sheet still has the old one,
 * until that change is sent.
 */
export async function replaceSynced(sheetRows) {
  const inSheet = new Set(sheetRows.map((r) => r.id));
  const current = await allExpenses();
  const held = new Set(current.filter((e) => e.status === 'deleted' || e.status === 'edited').map((e) => e.id));
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  for (const e of current) {
    if (e.status === 'synced' || (e.status === 'pending' && inSheet.has(e.id))) store.delete(e.id);
  }
  for (const r of sheetRows) if (!held.has(r.id)) store.put({ ...r, status: 'synced' });
  return finished(tx);
}

/** Renaming a category also renames it on the entries stored here, so the phone matches the sheet. */
export async function renameCategory(from, to) {
  const match = (c) => String(c).trim().toLowerCase() === String(from).trim().toLowerCase();
  const current = await allExpenses();
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  for (const e of current) {
    // orig too: the sheet renames its rows before it looks for an edited one.
    const orig = e.orig && match(e.orig.category) ? { ...e.orig, category: to } : e.orig;
    if (match(e.category) || orig !== e.orig) store.put({ ...e, category: match(e.category) ? to : e.category, orig });
  }
  return finished(tx);
}

export async function get(key) {
  const db = await open();
  return result(db.transaction('kv').objectStore('kv').get(key));
}

export async function set(key, value) {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  return finished(tx);
}
