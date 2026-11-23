// On-phone storage (IndexedDB). Two stores:
//   expenses — one record per entry: { id, date, amount, category, note, status, seq?, createdAt? }
//              status 'pending' = saved here, not yet in the sheet; 'synced' = a copy of a sheet row;
//              'deleted' = deleted here, waiting to be deleted in the sheet (hidden in the app)
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

export async function markSynced(ids) {
  const wanted = new Set(ids);
  const current = await allExpenses();
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  // Only entries still pending: one deleted while it was being sent stays marked deleted.
  for (const e of current) if (wanted.has(e.id) && e.status === 'pending') store.put({ ...e, status: 'synced' });
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
 * Entries deleted here stay hidden, even if the sheet still has them, until that deletion is sent.
 */
export async function replaceSynced(sheetRows) {
  const inSheet = new Set(sheetRows.map((r) => r.id));
  const current = await allExpenses();
  const deleted = new Set(current.filter((e) => e.status === 'deleted').map((e) => e.id));
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  for (const e of current) {
    if (e.status === 'synced' || (e.status === 'pending' && inSheet.has(e.id))) store.delete(e.id);
  }
  for (const r of sheetRows) if (!deleted.has(r.id)) store.put({ ...r, status: 'synced' });
  return finished(tx);
}

/** Renaming a category also renames it on the entries stored here, so the phone matches the sheet. */
export async function renameCategory(from, to) {
  const match = (c) => String(c).trim().toLowerCase() === String(from).trim().toLowerCase();
  const current = await allExpenses();
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  for (const e of current) if (match(e.category)) store.put({ ...e, category: to });
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
