/* Stock Tracker — main app logic (vanilla JS, no dependencies). */
(function () {
  'use strict';

  const LS = {
    api: 'st_apiUrl',
    cache: 'st_cache',        // {holdings, quotes, fetchedAt}
    history: 'st_hist_',      // + SYMBOL_range -> {data, fetchedAt}
    lastWrite: 'st_lastWriteback'
  };
  const WRITEBACK_MIN_MS = 5 * 60 * 1000;
  const REFRESH_MS = 60 * 1000;
  const PORTFOLIO = '__PORTFOLIO__'; // pseudo-symbol for the combined chart

  const $ = (id) => document.getElementById(id);

  const state = {
    holdings: [],   // lots from the sheet
    quotes: {},     // symbol -> {price, prevClose, ...}
    fetchedAt: null,
    live: false,    // last fetch succeeded
    devApi: false,  // same-origin dev-server.py API detected
    openGroups: new Set(),
    sort: { key: 'value', dir: -1 },
    detailSymbol: null,
    detailRange: '1y',
    chart: null
  };

  /* ---------- formatting ---------- */

  const fmt = (v, dp = 2) =>
    (v == null || isNaN(v)) ? '—'
      : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

  const signCls = (v) => v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : '';

  function fmtTime(ts) {
    const d = new Date(ts);
    const sameDay = new Date().toDateString() === d.toDateString();
    return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // "10/23/2023" or "2023-10-23" -> unix seconds (local noon, avoids TZ edge)
  function parseDate(s) {
    if (!s) return null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() / 1000;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2], 12).getTime() / 1000;
    const d = new Date(s);
    return isNaN(d) ? null : d.getTime() / 1000;
  }

  /* ---------- backend API ---------- */

  const apiUrl = () => localStorage.getItem(LS.api) || '';
  // Effective base: the configured Apps Script URL, else the same-origin /api
  // endpoint that dev-server.py provides (detected once at boot).
  const apiBase = () => apiUrl() || (state.devApi ? 'api' : '');

  async function probeDevApi() {
    if (apiUrl()) return;
    try {
      const res = await fetch('api?action=ping');
      const j = await res.json();
      state.devApi = !!(j.ok && j.data && j.data.pong);
    } catch (e) { state.devApi = false; }
  }

  async function api(params) {
    const base = apiBase();
    if (!base) throw new Error('NO_API');
    const url = base + (base.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'backend error');
    return j.data;
  }

  async function apiPost(body) {
    const base = apiBase();
    if (!base) throw new Error('NO_API');
    const res = await fetch(base, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script can't answer
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'backend error');
    return j;
  }

  /* ---------- data loading ---------- */

  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(LS.cache));
      if (c && c.holdings) {
        state.holdings = c.holdings;
        state.quotes = c.quotes || {};
        state.fetchedAt = c.fetchedAt;
      }
    } catch (e) { /* corrupt cache — ignore */ }
  }

  function saveCache() {
    localStorage.setItem(LS.cache, JSON.stringify({
      holdings: state.holdings, quotes: state.quotes, fetchedAt: state.fetchedAt
    }));
  }

  // Dev fallback: with no backend configured, load lots from the bundled CSV.
  async function loadCsvFallback() {
    const res = await fetch('holdings.csv');
    if (!res.ok) throw new Error('no csv');
    const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
    return lines.map(function (ln, i) {
      const c = ln.split(',');
      return {
        row: i + 2, symbol: c[0].trim().toUpperCase(), qty: +c[1], pricePaid: +c[2],
        dateAcquired: c[3], totalCost: +c[4] || +c[1] * +c[2], bank: c[5] || ''
      };
    });
  }

  async function refresh(manual) {
    setStatus('Refreshing…');
    try {
      const h = await api({ action: 'holdings' });
      state.holdings = h.rows;
      const symbols = [...new Set(state.holdings.map(r => r.symbol))];
      state.quotes = await api({ action: 'quotes', symbols: symbols.join(',') });
      state.fetchedAt = Date.now();
      state.live = true;
      saveCache();
      render();
      writeBack();
    } catch (err) {
      state.live = false;
      if (String(err.message) === 'NO_API') {
        if (!state.holdings.length) {
          try { state.holdings = await loadCsvFallback(); } catch (e) { /* nothing */ }
        }
        render();
        showBanner('No backend configured — showing holdings without live prices. ' +
          '<a id="bannerSetup">Open Settings</a> to connect your Google Sheet.');
        const a = $('bannerSetup');
        if (a) a.onclick = () => toggle($('settings'), true);
      } else {
        render();
        showBanner('Offline or backend unreachable — showing cached data' +
          (state.fetchedAt ? ' from ' + fmtTime(state.fetchedAt) : '') + '.');
        if (manual) console.warn('refresh failed:', err);
      }
    }
  }

  /* ---------- write gains back to the sheet ---------- */

  async function writeBack() {
    const last = +localStorage.getItem(LS.lastWrite) || 0;
    if (Date.now() - last < WRITEBACK_MIN_MS) return;
    const rows = state.holdings.map(function (r) {
      const q = state.quotes[r.symbol];
      if (!q || q.price == null) return null;
      const value = q.price * r.qty;
      const gain = value - r.totalCost;
      return {
        row: r.row,
        lastPrice: +q.price.toFixed(4),
        value: +value.toFixed(2),
        gain: +gain.toFixed(2),
        gainPct: +(gain / r.totalCost * 100).toFixed(2)
      };
    }).filter(Boolean);
    if (!rows.length) return;
    try {
      await apiPost({ action: 'writeGains', rows: rows, updatedAt: new Date().toLocaleString('en-US') });
      localStorage.setItem(LS.lastWrite, String(Date.now()));
    } catch (err) {
      console.warn('write-back failed:', err);
    }
  }

  /* ---------- rendering ---------- */

  function setStatus(txt) { $('syncStatus').textContent = txt; }

  function showBanner(html) {
    const b = $('banner');
    b.innerHTML = html;
    b.classList.remove('hidden');
  }
  function hideBanner() { $('banner').classList.add('hidden'); }

  function groups() {
    const map = new Map();
    state.holdings.forEach(function (r) {
      if (!map.has(r.symbol)) map.set(r.symbol, []);
      map.get(r.symbol).push(r);
    });
    return [...map.entries()].map(function ([symbol, lots]) {
      const qty = lots.reduce((s, l) => s + l.qty, 0);
      const cost = lots.reduce((s, l) => s + l.totalCost, 0);
      const q = state.quotes[symbol];
      const price = q && q.price != null ? q.price : null;
      const value = price != null ? price * qty : null;
      return {
        symbol, lots, qty, cost,
        avgCost: qty ? cost / qty : null,
        price,
        value,
        gain: value != null ? value - cost : null,
        gainPct: value != null && cost ? (value - cost) / cost * 100 : null,
        dayGain: (q && price != null && q.prevClose != null) ? (price - q.prevClose) * qty : null
      };
    }).sort(function (a, b) {
      const { key, dir } = state.sort;
      // with no live quotes, "value" falls back to cost so the order stays useful
      const av = key === 'value' ? (a.value ?? a.cost) : a[key];
      const bv = key === 'value' ? (b.value ?? b.cost) : b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls last, either direction
      if (bv == null) return -1;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }

  function render() {
    hideBanner();
    const gs = groups();

    // summary cards
    const tot = { cost: 0, value: 0, day: 0, anyValue: false, anyDay: false };
    gs.forEach(function (g) {
      tot.cost += g.cost;
      if (g.value != null) { tot.value += g.value; tot.anyValue = true; }
      else tot.value += g.cost; // fall back to cost so the total is still meaningful
      if (g.dayGain != null) { tot.day += g.dayGain; tot.anyDay = true; }
    });
    const totGain = tot.anyValue ? tot.value - tot.cost : null;
    $('summary').innerHTML = [
      card('Total Value', '$' + fmt(tot.anyValue ? tot.value : null), '', 'view history →', 'portfolioCard'),
      card("Day's Gain", tot.anyDay ? gainTxt(tot.day) : '—', tot.anyDay ? signCls(tot.day) : ''),
      card('Total Gain', totGain != null ? gainTxt(totGain) : '—', totGain != null ? signCls(totGain) : '',
        totGain != null && tot.cost ? fmt(totGain / tot.cost * 100) + '%' : ''),
      card('Cost Basis', '$' + fmt(tot.cost)),
      allocationCard(gs, tot.value)
    ].join('');
    const pc = $('portfolioCard');
    if (pc) pc.onclick = () => openDetail(PORTFOLIO);

    // sort indicators
    document.querySelectorAll('#portfolioHead th').forEach(function (th) {
      if (!th.dataset.label) th.dataset.label = th.textContent;
      th.textContent = th.dataset.label +
        (th.dataset.key === state.sort.key ? (state.sort.dir === -1 ? ' ▼' : ' ▲') : '');
    });

    // table
    const tb = $('portfolioBody');
    tb.innerHTML = '';
    gs.forEach(function (g) {
      const open = state.openGroups.has(g.symbol);
      const tr = document.createElement('tr');
      tr.className = 'group' + (open ? ' open' : '');
      tr.innerHTML =
        '<td class="sym"><span class="caret">▶</span>' + g.symbol +
        (g.lots.length > 1 ? ' <span class="dim">×' + g.lots.length + '</span>' : '') + '</td>' +
        '<td class="num">' + fmt(g.qty, g.qty % 1 ? 2 : 0) + '</td>' +
        '<td class="num">' + fmt(g.avgCost) + '</td>' +
        '<td class="num">' + fmt(g.price) + '</td>' +
        '<td class="num ' + signCls(g.dayGain) + '">' + (g.dayGain != null ? gainTxt(g.dayGain) : '—') + '</td>' +
        '<td class="num ' + signCls(g.gain) + '">' + (g.gain != null ? gainTxt(g.gain) : '—') + '</td>' +
        '<td class="num">' + (g.gainPct != null ? '<span class="pill ' + signCls(g.gainPct) + '">' + fmt(g.gainPct) + '%</span>' : '—') + '</td>' +
        '<td class="num">' + fmt(g.value ?? null) + '</td>';
      tr.addEventListener('click', function (ev) {
        // caret area toggles lots; anywhere else opens the chart
        if (ev.target.classList.contains('caret')) {
          state.openGroups.has(g.symbol) ? state.openGroups.delete(g.symbol) : state.openGroups.add(g.symbol);
          render();
        } else {
          openDetail(g.symbol);
        }
      });
      tb.appendChild(tr);

      if (open) {
        g.lots.forEach(function (l) {
          const q = state.quotes[g.symbol];
          const value = q && q.price != null ? q.price * l.qty : null;
          const gain = value != null ? value - l.totalCost : null;
          const ltr = document.createElement('tr');
          ltr.className = 'lot';
          ltr.innerHTML =
            '<td class="sym">' + l.dateAcquired + (l.bank ? ' · ' + l.bank : '') + '</td>' +
            '<td class="num">' + fmt(l.qty, l.qty % 1 ? 2 : 0) + '</td>' +
            '<td class="num">' + fmt(l.pricePaid) + '</td>' +
            '<td class="num"></td>' +
            '<td class="num"></td>' +
            '<td class="num ' + signCls(gain) + '">' + (gain != null ? gainTxt(gain) : '—') + '</td>' +
            '<td class="num ' + signCls(gain) + '">' + (gain != null && l.totalCost ? fmt(gain / l.totalCost * 100) + '%' : '—') + '</td>' +
            '<td class="num">' + fmt(value) + '</td>';
          tb.appendChild(ltr);
        });
      }
    });

    setStatus(state.live
      ? (state.devApi && !apiUrl() ? 'Dev · ' : 'Live · ') + fmtTime(state.fetchedAt)
      : (state.fetchedAt ? 'Cached · ' + fmtTime(state.fetchedAt) : 'Not connected'));
  }

  function card(label, big, cls, sub, id) {
    return '<div class="card' + (id ? ' clickable' : '') + '"' + (id ? ' id="' + id + '"' : '') + '>' +
      '<div class="label">' + label + '</div>' +
      '<div class="big ' + (cls || '') + '">' + big + '</div>' +
      (sub ? '<div class="sub ' + (cls || '') + '">' + sub + '</div>' : '') + '</div>';
  }

  const PALETTE = ['#6172f3', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4',
    '#a855f7', '#eab308', '#10b981', '#f97316', '#3b82f6', '#94a3b8'];

  function allocationCard(gs, totalValue) {
    const total = gs.reduce((s, g) => s + (g.value ?? g.cost), 0);
    if (!total) return '';
    const shares = gs
      .map((g, i) => ({ symbol: g.symbol, v: g.value ?? g.cost }))
      .sort((a, b) => b.v - a.v);
    // donut segments via stroke-dasharray on circles
    const R = 15.9155; // circumference ≈ 100 for easy percentages
    let offset = 25;   // start at 12 o'clock
    const segs = shares.map(function (s, i) {
      const pct = s.v / total * 100;
      const seg = '<circle r="' + R + '" cx="18" cy="18" fill="none" ' +
        'stroke="' + PALETTE[i % PALETTE.length] + '" stroke-width="4.5" ' +
        'stroke-dasharray="' + Math.max(pct - 0.4, 0.1).toFixed(2) + ' ' +
        (100 - Math.max(pct - 0.4, 0.1)).toFixed(2) + '" ' +
        'stroke-dashoffset="' + offset.toFixed(2) + '"></circle>';
      offset -= pct;
      return seg;
    }).join('');
    const top = shares.slice(0, 3).map(function (s, i) {
      return '<span class="alloc-item"><span class="alloc-dot" style="background:' +
        PALETTE[i % PALETTE.length] + '"></span>' + s.symbol + ' ' +
        (s.v / total * 100).toFixed(0) + '%</span>';
    }).join('');
    return '<div class="card alloc-card"><div class="label">Allocation</div>' +
      '<div class="alloc-body"><svg viewBox="0 0 36 36" class="alloc-donut">' + segs + '</svg>' +
      '<div class="alloc-list">' + top + '</div></div></div>';
  }

  const gainTxt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));

  /* ---------- symbol detail / chart ---------- */

  async function openDetail(symbol) {
    state.detailSymbol = symbol;
    if (symbol === PORTFOLIO) {
      $('detailTitle').textContent = 'Portfolio';
    } else {
      $('detailTitle').textContent = symbol +
        (state.quotes[symbol] && state.quotes[symbol].price != null
          ? ' — $' + fmt(state.quotes[symbol].price) : '');
    }
    toggle($('detail'), true);
    renderDetailLots(symbol);
    await loadChart();
  }

  // Fetch (or serve cached) price history for one symbol.
  async function fetchHistory(symbol, range) {
    const key = LS.history + symbol + '_' + range;
    try {
      const hist = await api({ action: 'history', symbol: symbol, range: range });
      localStorage.setItem(key, JSON.stringify({ data: hist, fetchedAt: Date.now() }));
      return { hist: hist, fromCache: false };
    } catch (err) {
      const c = localStorage.getItem(key);
      if (c) return { hist: JSON.parse(c).data, fromCache: true };
      return { hist: null, fromCache: false };
    }
  }

  // Total portfolio value over time: for each date, sum qty × price over the
  // lots already bought by that date (so contributions show as step-ups).
  async function portfolioHistory(range) {
    const symbols = [...new Set(state.holdings.map(r => r.symbol))];
    const results = await Promise.all(symbols.map(s => fetchHistory(s, range)));
    const bySym = {};
    let fromCache = false, missing = [];
    symbols.forEach(function (s, i) {
      const h = results[i].hist;
      if (h && h.timestamps && h.timestamps.length > 1) {
        bySym[s] = { ts: h.timestamps, cl: h.closes, ptr: 0 };
        fromCache = fromCache || results[i].fromCache;
      } else {
        missing.push(s);
      }
    });
    let base = null;
    Object.keys(bySym).forEach(function (s) {
      if (!base || bySym[s].ts.length > base.ts.length) base = bySym[s];
    });
    if (!base) return { hist: null, fromCache: false, missing: missing };

    const lots = state.holdings.map(r => ({
      symbol: r.symbol, qty: r.qty, buyT: parseDate(r.dateAcquired), pricePaid: r.pricePaid
    }));
    const closes = base.ts.map(function (t) {
      let total = 0;
      lots.forEach(function (l) {
        if (l.buyT != null && l.buyT > t) return; // not owned yet
        const h = bySym[l.symbol];
        let px = null;
        if (h) {
          while (h.ptr < h.ts.length - 1 && h.ts[h.ptr + 1] <= t) h.ptr++;
          px = h.cl[h.ptr];
          for (let j = h.ptr; px == null && j > 0; j--) px = h.cl[j - 1];
        }
        if (px == null) px = l.pricePaid; // no data (e.g. money market) — flat at cost
        total += px * l.qty;
      });
      return total;
    });
    return {
      hist: { symbol: PORTFOLIO, range: range, timestamps: base.ts, closes: closes },
      fromCache: fromCache,
      missing: missing
    };
  }

  async function loadChart() {
    const symbol = state.detailSymbol, range = state.detailRange;
    const msg = $('chartMsg');
    msg.textContent = 'Loading…';
    msg.classList.remove('hidden');

    const res = symbol === PORTFOLIO
      ? await portfolioHistory(range)
      : await fetchHistory(symbol, range);
    if (state.detailSymbol !== symbol || state.detailRange !== range) return; // stale response
    const hist = res.hist, fromCache = res.fromCache;

    if (!hist || !hist.timestamps || hist.timestamps.length < 2) {
      msg.textContent = apiBase() ? 'No history available for ' + (symbol === PORTFOLIO ? 'the portfolio' : symbol) + '.'
        : 'Price history needs the backend — open Settings to connect.';
      state.chart.setData({ timestamps: [], closes: [], markers: [] });
      return;
    }
    msg.classList.add('hidden');

    const lots = symbol === PORTFOLIO ? state.holdings : state.holdings.filter(r => r.symbol === symbol);
    const markers = lots.map(function (r) {
      return {
        t: parseDate(r.dateAcquired),
        // on the portfolio chart the marker sits on the curve (price: null)
        price: symbol === PORTFOLIO ? null : r.pricePaid,
        label: 'Bought ' + fmt(r.qty, r.qty % 1 ? 2 : 0) + ' ' + r.symbol +
          ' @ $' + fmt(r.pricePaid) + ' (' + r.dateAcquired + ')'
      };
    }).filter(m => m.t);

    state.chart.setData({ timestamps: hist.timestamps, closes: hist.closes, markers: markers });

    const clipped = state.chart._clippedMarkers;
    const notes = [];
    if (clipped) notes.push(clipped + ' buy' + (clipped > 1 ? 's' : '') + ' before this range');
    if (fromCache) notes.push('history from cache (offline)');
    if (res.missing && res.missing.length) notes.push('no history for ' + res.missing.join(', ') + ' — held flat at cost');
    let legend = document.querySelector('.legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'legend';
      $('detailLots').before(legend);
    }
    legend.innerHTML = '<span class="buy-dot">▲</span> buy points' +
      (notes.length ? ' · ' + notes.join(' · ') : '');
  }

  function renderDetailLots(symbol) {
    const all = symbol === PORTFOLIO;
    const lots = all
      ? [...state.holdings].sort((a, b) => (parseDate(a.dateAcquired) || 0) - (parseDate(b.dateAcquired) || 0))
      : state.holdings.filter(r => r.symbol === symbol);
    const rows = lots.map(function (l) {
      const q = state.quotes[l.symbol];
      const value = q && q.price != null ? q.price * l.qty : null;
      const gain = value != null ? value - l.totalCost : null;
      return '<tr>' +
        '<td class="sym">' + l.dateAcquired + '</td>' +
        (all ? '<td class="sym">' + l.symbol + '</td>' : '') +
        '<td class="sym">' + (l.bank || '—') + '</td>' +
        '<td class="num">' + fmt(l.qty, l.qty % 1 ? 2 : 0) + '</td>' +
        '<td class="num">' + fmt(l.pricePaid) + '</td>' +
        '<td class="num">' + fmt(l.totalCost) + '</td>' +
        '<td class="num ' + signCls(gain) + '">' + (gain != null ? gainTxt(gain) : '—') + '</td>' +
        '<td class="num">' + fmt(value) + '</td></tr>';
    }).join('');
    $('detailLots').innerHTML =
      '<table><thead><tr><th class="sym">Acquired</th>' +
      (all ? '<th class="sym">Symbol</th>' : '') +
      '<th class="sym">Bank</th>' +
      '<th class="num">Qty</th><th class="num">Price Paid $</th><th class="num">Cost $</th>' +
      '<th class="num">Gain $</th><th class="num">Value $</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  /* ---------- settings ---------- */

  function toggle(el, show) { el.classList.toggle('hidden', !show); }

  function bindUI() {
    $('refreshBtn').onclick = () => refresh(true);
    $('settingsBtn').onclick = function () {
      $('apiUrlInput').value = apiUrl();
      $('testResult').textContent = '';
      $('copySetupBtn').style.display = apiUrl() ? '' : 'none';
      toggle($('settings'), true);
    };
    $('copySetupBtn').onclick = function () {
      const link = location.origin + location.pathname + '?api=' + encodeURIComponent(apiUrl());
      navigator.clipboard.writeText(link).then(function () {
        $('testResult').textContent = '✓ Setup link copied — open it once on the new device.';
        $('testResult').style.color = 'var(--green)';
      }, function () {
        $('testResult').textContent = '✗ Could not copy — copy the URL field manually.';
        $('testResult').style.color = 'var(--red)';
      });
    };
    $('settingsClose').onclick = () => toggle($('settings'), false);
    $('detailClose').onclick = () => toggle($('detail'), false);
    [$('settings'), $('detail')].forEach(function (ov) {
      ov.addEventListener('click', function (e) { if (e.target === ov) toggle(ov, false); });
    });

    $('saveApiBtn').onclick = function () {
      localStorage.setItem(LS.api, $('apiUrlInput').value.trim());
      toggle($('settings'), false);
      refresh(true);
    };
    $('testApiBtn').onclick = async function () {
      const el = $('testResult');
      el.textContent = 'Testing…';
      try {
        const url = $('apiUrlInput').value.trim();
        const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=ping');
        const j = await res.json();
        el.textContent = j.ok ? '✓ Connected — sheet "' + j.data.sheet + '"' : '✗ ' + j.error;
        el.style.color = j.ok ? 'var(--green)' : 'var(--red)';
      } catch (err) {
        el.textContent = '✗ ' + err.message;
        el.style.color = 'var(--red)';
      }
    };

    $('portfolioHead').addEventListener('click', function (e) {
      const th = e.target.closest('th');
      if (!th || !th.dataset.key) return;
      if (state.sort.key === th.dataset.key) state.sort.dir = -state.sort.dir;
      else state.sort = { key: th.dataset.key, dir: th.dataset.key === 'symbol' ? 1 : -1 };
      render();
    });

    $('rangeBtns').addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      document.querySelectorAll('#rangeBtns button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.detailRange = btn.dataset.range;
      loadChart();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { toggle($('detail'), false); toggle($('settings'), false); }
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    // One-tap setup: opening the app as ...?api=<exec-url> saves the backend
    // URL and cleans the address bar (handy for first run on a phone).
    const apiParam = new URLSearchParams(location.search).get('api');
    if (apiParam && /^https:\/\/script\.google\.com\//.test(apiParam)) {
      localStorage.setItem(LS.api, apiParam);
      history.replaceState(null, '', location.pathname);
    }

    state.chart = new PriceChart($('chartCanvas'), $('chartTip'));
    bindUI();
    loadCache();
    render();                              // instant paint from cache
    probeDevApi().then(() => refresh(false)); // then go live

    setInterval(function () {
      if (!document.hidden && navigator.onLine && apiBase()) refresh(false);
    }, REFRESH_MS);
    window.addEventListener('online', () => refresh(false));

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('SW registration failed:', e);
      });
    }
  }

  boot();
})();
