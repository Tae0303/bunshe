# Bunshe

An expense tracker you install on your phone's home screen. It works offline and syncs to your **Accountant At Home** Google Sheet.

- Log a spend in a few taps: **+1 / +5 / +10 / +50 / +100** buttons (turn on **− Subtract** to take away instead), a shortcut dropdown and a sideways-scrolling row of categories.
- **☰ menu** (top left): add, rename, delete or reorder (drag ≡) shortcuts and categories. Each category keeps its colour wherever it moves. Changes show at once and reach the sheet's Shortcut / Categories tabs on the next sync. Renaming a category also renames it on past entries; deleting one keeps past entries as they are.
- Month view: total, average per day, spending by category, and entries grouped by day in the Thai day colours. Tap an entry to see it, edit it (amount, category, date, note) or delete it. Changes show at once and reach the sheet on the next sync: an edit updates the row in place, or moves it to another month's tab if the date changed; a deletion removes only that row's cells.
- The sync badge (top right) only appears when something needs your attention: changes waiting, offline with changes, a failed sync, or not connected. Settings → Status always shows the details.
- Saves on the phone first, then syncs to the sheet, which stays the main copy.

## How your data is saved

1. **On the phone first.** Saving stores the expense in the app's on-phone database (IndexedDB) and marks it *Not synced*. This works with no signal.
2. **Then sent to the sheet.** When the phone is online, the app sends every waiting entry to the sheet's Apps Script. The script writes each one into its month tab, creating the tab from `Template` if needed. Each entry carries an id, kept in hidden column H, so a retried send is never added twice.
3. **Then read back.** The app downloads every month tab, plus the Categories and Shortcut lists. Edits you make directly in Google Sheets show up in the app after the next sync.

The app retries on its own when you come back online, when you reopen it, and every minute while anything is waiting. Settings → **Export CSV** downloads a backup of everything on the phone.

## One-time setup

### 1. Update the sheet's script

1. Open the sheet → **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs), then save.
3. In the function menu at the top, pick **createSyncKey**, click **Run**, and allow access. Copy the key it prints in the Execution log.
4. **Deploy → New deployment**, click the gear, and choose **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. Delete the stray `[object Object]` tab: **View → Hidden sheets**, show it, then right-click → Delete.

Your existing triggers keep working. The monthly trigger now creates the new month's tab properly.

### 2. Install the app on your iPhone

1. Open **https://tae0303.github.io/bunshe/** in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open Bunshe from the home screen → **Settings**, paste the Web app URL and the sync key, then tap **Save and sync**. Your past months appear after the first sync, and the URL and key are tucked away behind **Change connection**.

Keep the URL and key private: together they let anyone read and add to your expenses. To change the key, delete `SYNC_KEY` under **Project Settings → Script properties**, run `createSyncKey` again, and paste the new key into the app.

## Making changes

- **App:** edit the files, bump `VERSION` in `sw.js`, then commit and push. Phones pick up the new version the second time the app is opened after the push.
- **Script:** after editing `Code.gs`, go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Develop

Requires Node 22 or later. There are no dependencies to install.

```
npm start        # http://localhost:8080
npm test         # logic tests
npm run icons    # redraw the PNG icons
```

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Screens: Add, Month, Settings |
| `logic.js` | Month keys, totals, average per day, CSV (no browser APIs; tested in `tests/`) |
| `db.js` | On-phone storage (IndexedDB) |
| `sync.js` | Send waiting entries, then pull the sheet |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install and offline support |
| `apps-script/Code.gs` | The sheet's script: Home tab, month tabs, and the sync API |
