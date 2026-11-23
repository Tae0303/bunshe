// On-phone storage (IndexedDB). Two stores:
//   expenses — one record per entry: { id, date, amount, category, note, status, seq?, createdAt? }
//              status 'pending' = saved here, not yet in the sheet; 'synced' = a copy of a sheet row
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
  for (const e of current) if (wanted.has(e.id)) store.put({ ...e, status: 'synced' });
  return finished(tx);
}

/**
 * The sheet is the main copy: its rows replace every synced entry here.
 * Pending entries stay, unless the sheet already has them (a send whose reply was lost).
 */
export async function replaceSynced(sheetRows) {
  const inSheet = new Set(sheetRows.map((r) => r.id));
  const current = await allExpenses();
  const db = await open();
  const tx = db.transaction('expenses', 'readwrite');
  const store = tx.objectStore('expenses');
  for (const e of current) if (e.status !== 'pending' || inSheet.has(e.id)) store.delete(e.id);
  for (const r of sheetRows) store.put({ ...r, status: 'synced' });
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
