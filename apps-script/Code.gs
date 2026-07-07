/**
 * Stock Tracker backend — Google Apps Script
 *
 * Setup (one time):
 *   1. Go to https://script.google.com → New project.
 *   2. Replace the default Code.gs contents with this file. Name the project "stock-tracker-api".
 *   3. Deploy → New deployment → type: Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   4. Authorize when prompted, then copy the /exec Web app URL.
 *   5. Open the Stock Tracker web app → Settings (gear) → paste the URL → Save.
 *
 * Note: "Anyone" means anyone who knows the (unguessable) URL can read your
 * holdings and write gain columns. Keep the URL private. The rest of your
 * Google account is not exposed — the script can only touch this spreadsheet.
 */

const SHEET_ID = '16yETcWNiY4UNBlhTakLnM2T5663rLWviRHQNYEl8ezk';
const SHEET_NAME = ''; // '' = first sheet/tab
// Optional RSU tab: A Grant Date, B Symbol, C Granted Qty, D Vested Qty,
// E Unvested Qty, F Sellable Qty; G-H written back by the app.
const RSU_SHEET_NAME = 'RSU';
const RSU_WRITEBACK_HEADER = ['Est. Market Value $', 'Last Updated'];

// Sheet columns: A Symbol, B Qty, C Price Paid $, D Date Acquired, E Total Cost $, F Bank
// Columns written back by the app:
const COL_LAST_PRICE = 7; // G
const WRITEBACK_HEADER = ['Last Price $', 'Value $', 'Total Gain $', 'Total Gain %', 'Last Updated'];

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = p.action || 'holdings';
    let data;
    if (action === 'holdings') data = getHoldings();
    else if (action === 'quotes') data = getQuotes(String(p.symbols || '').split(',').filter(String));
    else if (action === 'history') data = getHistory(p.symbol, p.range || '1y');
    else if (action === 'ping') data = { pong: true, sheet: sheet_().getName() };
    else throw new Error('Unknown action: ' + action);
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'writeGains') {
      writeGains_(body.rows || [], body.rsuRows || [], body.updatedAt || new Date().toISOString());
      return json_({ ok: true, written: (body.rows || []).length + (body.rsuRows || []).length });
    }
    throw new Error('Unknown action: ' + body.action);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sh) throw new Error('Sheet not found: ' + SHEET_NAME);
  return sh;
}

function getHoldings() {
  const sh = sheet_();
  const values = sh.getDataRange().getValues();
  const tz = Session.getScriptTimeZone();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!v[0]) continue;
    const qty = Number(v[1]);
    const pricePaid = Number(v[2]);
    rows.push({
      row: i + 1, // 1-based sheet row, used for write-back
      symbol: String(v[0]).trim().toUpperCase(),
      qty: qty,
      pricePaid: pricePaid,
      dateAcquired: v[3] instanceof Date ? Utilities.formatDate(v[3], tz, 'yyyy-MM-dd') : String(v[3]),
      totalCost: Number(v[4]) || qty * pricePaid,
      bank: String(v[5] || '')
    });
  }
  return { rows: rows, rsu: getRsu_() };
}

function getRsu_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(RSU_SHEET_NAME);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  const tz = Session.getScriptTimeZone();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!v[0] || !v[1]) continue;
    rows.push({
      row: i + 1,
      grantDate: v[0] instanceof Date ? Utilities.formatDate(v[0], tz, 'MM/dd/yyyy') : String(v[0]),
      symbol: String(v[1]).trim().toUpperCase(),
      granted: Number(v[2]) || 0,
      vested: Number(v[3]) || 0,
      unvested: Number(v[4]) || 0,
      sellable: Number(v[5]) || 0
    });
  }
  return rows;
}

// Yahoo uses '-' where brokers use '.' (BRK.B -> BRK-B)
function yahooSymbol_(s) {
  return s.replace(/\./g, '-');
}

function getQuotes(symbols) {
  if (!symbols.length) return {};
  const reqs = symbols.map(function (s) {
    return {
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooSymbol_(s)) +
        '?range=1d&interval=1d',
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
  });
  const resps = UrlFetchApp.fetchAll(reqs);
  const out = {};
  resps.forEach(function (r, i) {
    try {
      const meta = JSON.parse(r.getContentText()).chart.result[0].meta;
      out[symbols[i]] = {
        price: meta.regularMarketPrice,
        prevClose: (meta.chartPreviousClose != null) ? meta.chartPreviousClose : meta.previousClose,
        currency: meta.currency,
        marketTime: meta.regularMarketTime
      };
    } catch (err) {
      out[symbols[i]] = { error: 'quote failed (' + r.getResponseCode() + ')' };
    }
  });
  return out;
}

function getHistory(symbol, range) {
  if (!symbol) throw new Error('symbol required');
  const interval = (range === '5y' || range === 'max') ? '1wk' : '1d';
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooSymbol_(symbol)) +
    '?range=' + encodeURIComponent(range) + '&interval=' + interval;
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const res = JSON.parse(r.getContentText()).chart.result[0];
  const quote = res.indicators.quote[0];
  const adj = res.indicators.adjclose && res.indicators.adjclose[0];
  return {
    symbol: symbol,
    range: range,
    timestamps: res.timestamp || [],
    closes: (adj && adj.adjclose) || quote.close || []
  };
}

function writeGains_(rows, rsuRows, updatedAt) {
  const sh = sheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sh.getRange(1, COL_LAST_PRICE, 1, WRITEBACK_HEADER.length).setValues([WRITEBACK_HEADER]);
    rows.forEach(function (r) {
      if (!r.row || r.row < 2) return;
      sh.getRange(r.row, COL_LAST_PRICE, 1, 5)
        .setValues([[r.lastPrice, r.value, r.gain, r.gainPct, updatedAt]]);
    });
    if (rsuRows.length) {
      const rsh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(RSU_SHEET_NAME);
      if (rsh) {
        rsh.getRange(1, 7, 1, RSU_WRITEBACK_HEADER.length).setValues([RSU_WRITEBACK_HEADER]);
        rsuRows.forEach(function (r) {
          if (!r.row || r.row < 2) return;
          rsh.getRange(r.row, 7, 1, 2).setValues([[r.estValue, updatedAt]]);
        });
      }
    }
  } finally {
    lock.releaseLock();
  }
}
