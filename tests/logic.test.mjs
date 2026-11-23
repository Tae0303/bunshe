import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthLabel, daysInMonth, shiftMonth, daysCounted, summarize, parseAmount, round2, shortName, toCsv, weekdayIndex,
  applyListOps, hasName, stepAmount, sortByOrder, moveTo,
} from '../logic.js';

test('category colours: set, follow a rename, keep the target colour on a merge, go on delete', () => {
  const sheet = { categories: ['Food', 'Transit', 'Others'], shortcuts: [], colors: { Food: '#f97316', ' transit ': '#3b82f6' } };
  const r = applyListOps(sheet, [
    { type: 'categoryColor', name: 'Others', color: '#64748b' },
    { type: 'renameCategory', from: 'Food', to: '🍜 Food' },
    { type: 'categoryColor', name: 'Transit', color: '#123456' },
  ]);
  assert.deepEqual(r.colors, { '🍜 food': '#f97316', transit: '#123456', others: '#64748b' });
  const merged = applyListOps(sheet, [{ type: 'renameCategory', from: 'Food', to: 'Transit' }]);
  assert.equal(merged.colors.transit, '#3b82f6');
  assert.equal(merged.colors.food, undefined);
  assert.equal(applyListOps(sheet, [{ type: 'deleteCategory', name: 'food' }]).colors.food, undefined);
});

test('drag reorder: take an item from one place and drop it at another', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  assert.equal(moveTo(['a', 'b', 'c'], 1, 1), null); // dropped where it was
  assert.equal(moveTo(['a', 'b', 'c'], 0, -1), null); // past the top
  assert.equal(moveTo(['a', 'b', 'c'], 2, 3), null); // past the bottom
});

test('reorder: names in the order come first; ones added in the sheet meanwhile keep their place after', () => {
  assert.deepEqual(sortByOrder(['Food', 'Transit', 'New one', 'Others'], ['transit', 'Others', 'Food']), ['Transit', 'Others', 'Food', 'New one']);
  const r = applyListOps(
    { categories: ['Food & Drinks', 'Transit', 'Others'], shortcuts: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    [
      { type: 'reorderCategories', order: ['Transit', 'Food & Drinks', 'Others'] },
      { type: 'reorderShortcuts', order: ['C', 'A', 'B'] },
      { type: 'renameCategory', from: 'Transit', to: 'Travel' },
    ],
  );
  assert.deepEqual(r.categories, ['Travel', 'Food & Drinks', 'Others']);
  assert.deepEqual(r.shortcuts.map((s) => s.name), ['C', 'A', 'B']);
});

test('step buttons: add, subtract, never below 0, exact decimals', () => {
  assert.equal([100, 50, 10, 5, 1].reduce((sum, s) => stepAmount(sum, s), 0), 166);
  assert.equal(stepAmount(167, 50, true), 117);
  assert.equal(stepAmount(7, 10, true), 0);
  assert.equal(stepAmount(NaN, 5), 5); // empty or unreadable amount counts as 0
  assert.equal(stepAmount(12.3, 1, true), 11.3);
});

const sheetLists = () => ({
  categories: ['Food & Drinks', 'Transit', 'Others'],
  shortcuts: [{ name: 'Coffee', amount: 55, category: 'Food & Drinks' }],
});

test('added categories show before they reach the sheet, without duplicates', () => {
  const { categories } = applyListOps(sheetLists(), [
    { type: 'category', name: 'Gifts' },
    { type: 'category', name: 'transit' }, // already there, different case
  ]);
  assert.deepEqual(categories, ['Food & Drinks', 'Transit', 'Others', 'Gifts']);
  assert.ok(hasName(['Food & Drinks'], '  food & drinks '));
});

test('renaming a category keeps its place and moves its shortcuts along', () => {
  const r = applyListOps(sheetLists(), [{ type: 'renameCategory', from: 'Food & Drinks', to: 'Food' }]);
  assert.deepEqual(r.categories, ['Food', 'Transit', 'Others']);
  assert.equal(r.shortcuts[0].category, 'Food');
});

test('changes replay in order: add, rename, then delete', () => {
  const r = applyListOps(sheetLists(), [
    { type: 'category', name: 'Gifts' },
    { type: 'renameCategory', from: 'Gifts', to: 'Presents' },
    { type: 'deleteCategory', name: 'presents' },
  ]);
  assert.deepEqual(r.categories, ['Food & Drinks', 'Transit', 'Others']);
});

test('shortcuts: add, edit (rename + new amount), delete', () => {
  const start = sheetLists();
  const r = applyListOps(start, [
    { type: 'shortcut', name: 'Lunch set', amount: 89, category: 'Food & Drinks' },
    { type: 'updateShortcut', from: 'coffee', name: 'Iced coffee', amount: 65, category: 'Food & Drinks' },
    { type: 'deleteShortcut', name: 'LUNCH SET' },
  ]);
  assert.deepEqual(r.shortcuts, [{ name: 'Iced coffee', amount: 65, category: 'Food & Drinks' }]);
  assert.equal(start.shortcuts[0].name, 'Coffee'); // the sheet copy is not changed
});

test('month names match the sheet tabs', () => {
  assert.equal(monthLabel('2026-11'), 'Nov 2026');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(daysInMonth('2028-02'), 29);
});

test('average uses the whole month once it is over, and today in the current month', () => {
  assert.equal(daysCounted('2026-10', '2026-11-23'), 31);
  assert.equal(daysCounted('2026-11', '2026-11-23'), 23);
  assert.equal(daysCounted('2026-12', '2026-11-23'), 0);
});

test('a past year is not mistaken for the current month (spec issue #2)', () => {
  assert.equal(daysCounted('2026-12', '2027-01-05'), 31);
  assert.equal(daysCounted('2026-11', '2027-01-05'), 30);
});

test('summary: totals, per-day averages, categories sorted by total', () => {
  const rows = [
    { id: 'a', date: '2026-10-02', amount: 17, category: 'Transit', status: 'synced', seq: 2 },
    { id: 'b', date: '2026-10-02', amount: 129, category: 'Food & Drinks', status: 'synced', seq: 3 },
    { id: 'c', date: '2026-10-31', amount: 62, category: 'Food & Drinks', status: 'pending', createdAt: 1 },
    { id: 'd', date: '2026-11-01', amount: 999, category: 'Items', status: 'synced', seq: 2 },
  ];
  const s = summarize(rows, '2026-10', '2026-11-23');
  assert.equal(s.total, 208);
  assert.equal(s.count, 3);
  assert.equal(s.days, 31);
  assert.equal(round2(s.perDay), 6.71);
  assert.deepEqual(s.categories.map((c) => [c.name, c.total]), [['Food & Drinks', 191], ['Transit', 17]]);
  assert.deepEqual(s.rows.map((r) => r.id), ['c', 'b', 'a']);
});

test('the spec example: Oct 2026 average', () => {
  const s = summarize([{ id: 'x', date: '2026-10-05', amount: 15308.47, category: 'Items' }], '2026-10', '2026-11-23');
  assert.equal(round2(s.perDay), 493.82);
});

test('amount parsing and the +1/+5/+10/+100 steps add up exactly', () => {
  assert.equal(parseAmount('1,234.5'), 1234.5);
  assert.equal(parseAmount('฿17'), 17);
  assert.equal(parseAmount(''), 0);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.equal([100, 10, 5, 1, 1].reduce((sum, step) => round2(sum + step), 0), 117);
  assert.equal(round2(0.1 + 0.2), 0.3);
});

test('short category names and weekdays', () => {
  assert.equal(shortName('Hobbies (Board games, Card games, Video games, Books)'), 'Hobbies');
  assert.equal(shortName('Food & Drinks'), 'Food & Drinks');
  assert.equal(weekdayIndex('2026-11-23'), 1); // Monday
});

test('CSV export quotes commas and quotes', () => {
  const csv = toCsv([{ date: '2026-11-23', amount: 17, category: 'Transit', note: 'BTS, "Siam"', status: 'pending' }]);
  assert.equal(csv, 'Date,Amount,Category,Note,Synced\r\n2026-11-23,17.00,Transit,"BTS, ""Siam""",no\r\n');
});
