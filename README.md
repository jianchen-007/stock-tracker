# Stock Tracker

A dependency-free PWA that tracks a stock portfolio stored in a Google Sheet:

- Reads holdings (lots) from the sheet; groups multiple lots per symbol.
- Fetches live quotes and daily/total gains, refreshed every 60 s.
- Writes Last Price / Value / Gain / Gain % / Last Updated back to the sheet (columns G–K, at most every 5 min).
- Works offline: app shell via service worker, data via localStorage cache.
- Click a symbol row for a price-history chart with buy dates marked (▲); click the ▶ caret to expand individual lots.
- Click the Total Value card for a combined portfolio-history chart (lots enter the curve on their buy dates, so contributions show as step-ups).
- Three tabs: **Stocks/ETFs** (default), **RSUs**, **Retirement**. Each shows "Today's movers" (positions beyond ±2% on the day), the rest grouped into collapsible per-account cards, with the tab's totals at the bottom.
- Clickable movers-table headers to sort; "Show $ / Show %" toggle.
- Row stripes mark long-term (blue, held >1 yr) vs short-term (amber) positions; mixed-lot symbols get a split stripe; unknown dates get no stripe.
- Symbol `CASH` is treated as a constant $1.00 for money-market/sweep balances.
- Allocation donut, dark mode (follows the system setting).

**Sheet:** https://docs.google.com/spreadsheets/d/16yETcWNiY4UNBlhTakLnM2T5663rLWviRHQNYEl8ezk

Sheet layout (row 1 = header): `Symbol | Qty | Price Paid $ | Date Acquired | Total Cost $ | Bank` — columns G–K are app-managed. Add/edit rows in the sheet; the app picks changes up on its next refresh.

## One-time backend setup (~2 min)

Browsers can't reach the Sheets or quote APIs directly, so a tiny Google Apps Script acts as the backend (it runs under your Google account, free):

1. Open https://script.google.com → **New project**.
2. Paste the contents of [`apps-script/Code.gs`](apps-script/Code.gs) over the default file.
3. **Deploy → New deployment → Web app**, Execute as: **Me**, Who has access: **Anyone**. Authorize when asked.
4. Copy the `…/exec` URL, open the tracker app → ⚙ Settings → paste → **Test connection** → **Save**.

> "Anyone" means anyone holding the unguessable URL can read holdings / write gain columns — keep the URL private. Nothing else in your account is reachable.

## Running the app

**Local dev (full experience, no Apps Script needed):**

```bash
cd /Users/jchen/AI/stock_tracking && python3 dev-server.py
# open http://localhost:8765
```

`dev-server.py` serves the app **and** emulates the backend at `/api` — holdings come
from `holdings.csv` and live quotes/history are proxied from Yahoo Finance, so
everything works except sheet sync (write-backs are logged, not persisted). The
frontend auto-detects this endpoint when no Apps Script URL is saved (status shows
"Dev ·" instead of "Live ·").

**Production:** any static hosting, e.g. GitHub Pages (same as the camp-schedule
app) — the service worker needs HTTPS or localhost. With the Apps Script URL saved
in Settings, the app reads/writes the real Google Sheet.

## Files

| File | Purpose |
|---|---|
| `index.html` / `style.css` | UI shell |
| `app.js` | State, API calls, rendering, offline cache, write-back |
| `chart.js` | Canvas price chart with buy markers + hover tooltip |
| `sw.js` / `manifest.json` / `icon.svg` | PWA offline + install |
| `apps-script/Code.gs` | Google Apps Script backend (sheet I/O + Yahoo Finance proxy) |
| `holdings.csv` | Snapshot of the initial data; also the no-backend dev fallback |
