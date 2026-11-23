// Sync with the Google Sheet through its Apps Script web app (apps-script/Code.gs).
// Order: send category/shortcut changes, then deleted entries, then new entries, then pull the whole sheet back.

import * as db from './db.js';

const listeners = new Set();
let running = null;

/** fn({ state, message? }) — state is 'off' | 'offline' | 'syncing' | 'ok' | 'error'. */
export function onStatus(fn) {
  listeners.add(fn);
}

function report(status) {
  for (const fn of listeners) fn(status);
}

/** Starts a sync, or joins the one already running. */
export function syncNow() {
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}

async function run() {
  const settings = await db.get('settings');
  if (!settings?.url || !settings?.key) return report({ state: 'off' });
  if (!navigator.onLine) return report({ state: 'offline' });
  report({ state: 'syncing' });
  try {
    // 1. Category and shortcut changes made on the phone (add, rename, delete), in the order they were made.
    const queue = (await db.get('pendingLists')) || [];
    if (queue.length) {
      await call(settings, { action: 'lists', ops: queue.map(({ id, ...op }) => op) });
      const sent = new Set(queue.map((op) => op.id));
      const left = ((await db.get('pendingLists')) || []).filter((op) => !sent.has(op.id)); // keep any added meanwhile
      await db.set('pendingLists', left);
    }
    // 2. Expenses deleted on the phone.
    const deleted = (await db.allExpenses()).filter((e) => e.status === 'deleted');
    if (deleted.length) {
      const entries = deleted.map(({ id, date, amount, category, note }) => ({ id, date, amount, category, note }));
      await call(settings, { action: 'delete', entries });
      await db.removeExpenses(deleted.map((e) => e.id));
    }
    // 3. Expenses waiting on the phone.
    const pending = (await db.allExpenses()).filter((e) => e.status === 'pending');
    if (pending.length) {
      const entries = pending.map(({ id, date, amount, category, note }) => ({ id, date, amount, category, note }));
      await call(settings, { action: 'add', entries });
      await db.markSynced(pending.map((e) => e.id));
    }
    // 4. Read the whole sheet back.
    const data = await call(settings, { action: 'pull' });
    await db.replaceSynced(data.expenses);
    await db.set('categories', data.categories);
    await db.set('shortcuts', data.shortcuts);
    await db.set('lastSync', new Date().toISOString());
    report({ state: 'ok' });
  } catch (err) {
    report({ state: navigator.onLine ? 'error' : 'offline', message: err.message });
  }
}

async function call(settings, payload) {
  let res;
  try {
    // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
    res = await fetch(settings.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: settings.key, ...payload }),
    });
  } catch {
    throw new Error('Could not reach Google. Check your connection.');
  }
  if (!res.ok) throw new Error(`Google returned an error (HTTP ${res.status}).`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Unexpected reply. Check the Web app URL, and that access is set to "Anyone".');
  }
  if (!data.ok && /^Unknown action/.test(data.error || '')) {
    throw new Error('The sheet script is out of date. Paste the latest Code.gs and deploy a new version (see README).');
  }
  if (!data.ok) throw new Error(data.error || 'The sheet script reported an error.');
  return data;
}
