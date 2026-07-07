/* Stock Tracker — main app logic (vanilla JS, no dependencies). */
(function () {
  'use strict';

  const LS = {
    api: 'st_apiUrl',
    cache: 'st_cache',        // {holdings, quotes, fetchedAt}
    history: 'st_hist_',      // + SYMBOL_range -> {data, fetchedAt}
    lastWrite: 'st_lastWriteback',
    dispMode: 'st_dispMode',  // '%' | '$'
    sortKey: 'st_sortKey'
  };
  const LONG_TERM_S = 365 * 86400; // held ≥ 1 year
  const WRITEBACK_MIN_MS = 5 * 60 * 1000;
  const REFRESH_MS = 60 * 1000;
  const PORTFOLIO = '__PORTFOLIO__'; // pseudo-symbol for the combined chart

  const $ = (id) => document.getElementById(id);

  const state = {
    holdings: [],   // taxable lots from the main sheet
    retirement: [], // lots from the Retirement tab (401k etc.)
    rsu: [],        // RSU grants from the sheet's RSU tab
    quotes: {},     // symbol -> {price, prevClose, ...}
    fetchedAt: null,
    live: false,    // last fetch succeeded
    devApi: false,  // same-origin dev-server.py API detected
    openGroups: new Set(),
    // default: biggest movers of the day (by |day %|) on top
    sort: {
      key: localStorage.getItem(LS.sortKey) || 'mover',
      dir: (localStorage.getItem(LS.sortKey) || 'mover') === 'symbol' ? 1 : -1
    },
    dispMode: localStorage.getItem(LS.dispMode) || '%',
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

  // Accept either a bare Apps Script /exec URL or a full "?api=..." setup
  // link (as produced by "Copy phone setup link"); returns '' if neither.
  function normalizeApiInput(text) {
    text = (text || '').trim();
    if (text.includes('?api=') || text.includes('&api=')) {
      try {
        const v = new URL(text).searchParams.get('api');
        if (v) text = v;
      } catch (e) { /* fall through */ }
    }
    return /^https:\/\/script\.google\.com\//.test(text) ? text : '';
  }
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
        state.retirement = c.retirement || [];
        state.rsu = c.rsu || [];
        state.quotes = c.quotes || {};
        state.fetchedAt = c.fetchedAt;
      }
    } catch (e) { /* corrupt cache — ignore */ }
  }

  function saveCache() {
    localStorage.setItem(LS.cache, JSON.stringify({
      holdings: state.holdings, retirement: state.retirement, rsu: state.rsu,
      quotes: state.quotes, fetchedAt: state.fetchedAt
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
      state.retirement = h.retirement || [];
      state.rsu = h.rsu || [];
      const symbols = [...new Set(
        state.holdings.map(r => r.symbol)
          .concat(state.retirement.map(r => r.symbol))
          .concat(state.rsu.map(r => r.symbol)))]
        .filter(s => s !== 'CASH'); // CASH is a constant, not a ticker
      state.quotes = await api({ action: 'quotes', symbols: symbols.join(',') });
      state.quotes.CASH = { price: 1, prevClose: 1, currency: 'USD' };
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
        showSetupBanner('No backend configured — showing holdings without live prices.');
      } else {
        render();
        showBanner('Offline or backend unreachable — showing cached data' +
          (state.fetchedAt ? ' from ' + fmtTime(state.fetchedAt) : '') + '.');
        if (manual) console.warn('refresh failed:', err);
      }
    }
  }

  /* ---------- write gains back to the sheet ---------- */

  function gainRows(lots) {
    return lots.map(function (r) {
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
  }

  async function writeBack() {
    const last = +localStorage.getItem(LS.lastWrite) || 0;
    if (Date.now() - last < WRITEBACK_MIN_MS) return;
    const rows = gainRows(state.holdings);
    const retRows = gainRows(state.retirement);
    const rsuRows = state.rsu.map(function (r) {
      const q = state.quotes[r.symbol];
      if (!q || q.price == null) return null;
      return { row: r.row, estValue: +((r.sellable + r.unvested) * q.price).toFixed(2) };
    }).filter(Boolean);
    if (!rows.length && !rsuRows.length && !retRows.length) return;
    try {
      await apiPost({ action: 'writeGains', rows: rows, rsuRows: rsuRows, retRows: retRows, updatedAt: new Date().toLocaleString('en-US') });
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

  // Unconfigured-state banner with the two setup actions. "Paste setup link"
  // is the phone-friendly path (esp. iOS home-screen apps, whose storage is
  // separate from Safari's): copy the link from a configured device, tap once.
  function showSetupBanner(message) {
    showBanner(message + ' <a id="bannerPaste">Paste setup link</a> (copied from a configured device) or ' +
      '<a id="bannerSetup">open Settings</a>.');
    $('bannerSetup').onclick = () => toggle($('settings'), true);
    $('bannerPaste').onclick = async function () {
      let url = '';
      try {
        url = normalizeApiInput(await navigator.clipboard.readText());
      } catch (err) {
        showSetupBanner('Couldn\'t read the clipboard — use Settings and paste into the URL field instead.');
        return;
      }
      if (!url) {
        showSetupBanner('Clipboard doesn\'t hold a setup link. On a configured device use Settings → "Copy phone setup link", send it here, copy it, then retry.');
        return;
      }
      localStorage.setItem(LS.api, url);
      refresh(true);
    };
  }

  // true = long-term, false = short-term, null = acquisition date unknown
  const isLong = (lot) => {
    const t = parseDate(lot.dateAcquired);
    if (t == null) return null;
    return (Date.now() / 1000 - t) >= LONG_TERM_S;
  };

  // every lot the user owns, across taxable + retirement accounts
  const allLots = () => state.holdings.concat(state.retirement);

  function groups(lotList) {
    const map = new Map();
    (lotList || state.holdings).forEach(function (r) {
      if (!map.has(r.symbol)) map.set(r.symbol, []);
      map.get(r.symbol).push(r);
    });
    return [...map.entries()].map(function ([symbol, lots]) {
      const qty = lots.reduce((s, l) => s + l.qty, 0);
      const cost = lots.reduce((s, l) => s + l.totalCost, 0);
      const q = state.quotes[symbol];
      const price = q && q.price != null ? q.price : null;
      const value = price != null ? price * qty : null;
      const terms = lots.map(isLong).filter(t => t !== null);
      const longCount = terms.filter(Boolean).length;
      return {
        symbol, lots, qty, cost,
        avgCost: qty ? cost / qty : null,
        price,
        value,
        gain: value != null ? value - cost : null,
        gainPct: value != null && cost ? (value - cost) / cost * 100 : null,
        dayGain: (q && price != null && q.prevClose != null) ? (price - q.prevClose) * qty : null,
        dayPct: (q && price != null && q.prevClose) ? (price - q.prevClose) / q.prevClose * 100 : null,
        term: !terms.length ? 'na'
          : longCount === terms.length ? 'long' : longCount === 0 ? 'short' : 'mixed'
      };
    }).sort(function (a, b) {
      const { key, dir } = state.sort;
      const sortVal = function (g) {
        if (key === 'mover') return g.dayPct == null ? null : Math.abs(g.dayPct);
        if (key === 'value') return g.value ?? g.cost; // useful order even with no quotes
        return g[key];
      };
      const av = sortVal(a), bv = sortVal(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls last, either direction
      if (bv == null) return -1;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }

  // RSU aggregates. Value convention matches the broker: a grant's market
  // value is (sellable + unvested) × price; vested-but-not-sellable shares
  // were sold/withheld and are gone. "Current" = sellable only.
  function rsuTotals() {
    const t = { current: 0, potential: 0, day: 0, sellable: 0, unvested: 0, anyValue: false };
    state.rsu.forEach(function (r) {
      const q = state.quotes[r.symbol];
      t.sellable += r.sellable;
      t.unvested += r.unvested;
      if (q && q.price != null) {
        t.anyValue = true;
        t.current += r.sellable * q.price;
        t.potential += r.unvested * q.price;
        if (q.prevClose != null) t.day += r.sellable * (q.price - q.prevClose);
      }
    });
    return t;
  }

  function render() {
    hideBanner();
    const gs = groups();
    const retGs = groups(state.retirement);
    renderRsu();

    // summary cards (bottom of page): stocks + retirement + sellable RSU shares
    const rsuT = rsuTotals();
    const tot = { cost: 0, value: 0, day: 0, anyValue: false, anyDay: false };
    gs.concat(retGs).forEach(function (g) {
      tot.cost += g.cost;
      if (g.value != null) { tot.value += g.value; tot.anyValue = true; }
      else tot.value += g.cost; // fall back to cost so the total is still meaningful
      if (g.dayGain != null) { tot.day += g.dayGain; tot.anyDay = true; }
    });
    const totGain = tot.anyValue ? tot.value - tot.cost : null;
    const hasRsu = state.rsu.length > 0;
    const grandValue = tot.value + rsuT.current;
    const grandDay = tot.day + rsuT.day;
    $('summary').innerHTML = [
      card('Total Value', '$' + fmt(tot.anyValue || rsuT.anyValue ? grandValue : null), '',
        (hasRsu ? 'incl. sellable RSUs · ' : '') + 'view history →', 'portfolioCard'),
      card("Day's Gain", tot.anyDay || rsuT.anyValue ? gainTxt(grandDay) : '—',
        signCls(grandDay)),
      card('Total Gain', totGain != null ? gainTxt(totGain) : '—', totGain != null ? signCls(totGain) : '',
        (totGain != null && tot.cost ? fmt(totGain / tot.cost * 100) + '%' : '') + (hasRsu ? ' · excl. RSUs' : '')),
      card('Cost Basis', '$' + fmt(tot.cost), '', hasRsu ? 'excl. RSUs' : ''),
      hasRsu ? card('RSU Potential', rsuT.anyValue ? '$' + fmt(rsuT.potential) : '—', '',
        fmt(rsuT.unvested, 0) + ' unvested shares') : '',
      allocationCard(gs.concat(retGs), tot.value)
    ].join('');
    const pc = $('portfolioCard');
    if (pc) pc.onclick = () => openDetail(PORTFOLIO);

    // header sort indicators (Day/Total map to %- or $-keys per display mode)
    document.querySelectorAll('#portfolioHead th').forEach(function (th) {
      if (!th.dataset.label) th.dataset.label = th.textContent;
      th.textContent = th.dataset.label +
        (headerSortKey(th.dataset.key) === state.sort.key ? (state.sort.dir === -1 ? ' ▼' : ' ▲') : '');
    });
    const sel = $('sortSel');
    if (sel) sel.value = [...sel.options].some(o => o.value === state.sort.key) ? state.sort.key : 'mover';
    $('modeToggle').textContent = state.dispMode === '%' ? 'Show $' : 'Show %';

    const pct = state.dispMode === '%';
    const dayCell = (dPct, dGain) => {
      const v = pct ? dPct : dGain;
      return '<td class="num ' + signCls(v) + '">' +
        (v == null ? '—' : (pct ? pctTxt(v) : gainTxt(v))) + '</td>';
    };
    const totalCell = (gPct, gGain) => {
      const v = pct ? gPct : gGain;
      if (v == null) return '<td class="num">—</td>';
      return pct
        ? '<td class="num"><span class="pill ' + signCls(v) + '">' + pctTxt(v) + '</span></td>'
        : '<td class="num ' + signCls(v) + '">' + gainTxt(v) + '</td>';
    };

    // shared row builder for the stocks and retirement tables
    function renderTable(list, tb, opts) {
      tb.innerHTML = '';
      list.forEach(function (g) {
        const openKey = opts.keyPrefix + g.symbol;
        const open = state.openGroups.has(openKey);
        const tr = document.createElement('tr');
        tr.className = 'group' + (opts.stripes ? ' term-' + g.term : '') + (open ? ' open' : '');
        tr.innerHTML =
          '<td class="sym"><span class="caret">▶</span>' + g.symbol +
          (g.lots.length > 1 ? ' <span class="dim">×' + g.lots.length + '</span>' : '') + '</td>' +
          dayCell(g.dayPct, g.dayGain) +
          totalCell(g.gainPct, g.gain) +
          '<td class="num">' + fmt(g.value) + '</td>';
        tr.addEventListener('click', function (ev) {
          // caret area toggles lots; anywhere else opens the chart
          if (ev.target.classList.contains('caret')) {
            state.openGroups.has(openKey) ? state.openGroups.delete(openKey) : state.openGroups.add(openKey);
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
            const lotDayGain = (q && q.price != null && q.prevClose != null) ? (q.price - q.prevClose) * l.qty : null;
            const lt = opts.stripes ? isLong(l) : null;
            const ltr = document.createElement('tr');
            ltr.className = 'lot' + (lt === null ? '' : lt ? ' term-long' : ' term-short');
            ltr.innerHTML =
              '<td class="sym">' + (l.dateAcquired || '—') + (l.bank ? ' · ' + l.bank : '') +
              ' · ' + fmt(l.qty, l.qty % 1 ? 2 : 0) + ' @ ' + fmt(l.pricePaid) + '</td>' +
              dayCell(g.dayPct, lotDayGain) +
              totalCell(gain != null && l.totalCost ? gain / l.totalCost * 100 : null, gain) +
              '<td class="num">' + fmt(value) + '</td>';
            tb.appendChild(ltr);
          });
        }
      });
    }

    renderTable(gs, $('portfolioBody'), { stripes: true, keyPrefix: '' });

    // retirement section
    const retSec = $('retSection');
    if (state.retirement.length) {
      retSec.hidden = false;
      renderTable(retGs, $('retBody'), { stripes: false, keyPrefix: 'ret:' });
      const rv = retGs.reduce((s, g) => s + (g.value ?? g.cost), 0);
      const rc = retGs.reduce((s, g) => s + g.cost, 0);
      const rd = retGs.reduce((s, g) => s + (g.dayGain || 0), 0);
      $('retNumbers').innerHTML =
        '<span>Value <strong>$' + fmt(rv) + '</strong></span>' +
        '<span>Gain <strong class="' + signCls(rv - rc) + '">' + gainTxt(rv - rc) + '</strong></span>' +
        '<span>Day <strong class="' + signCls(rd) + '">' + gainTxt(rd) + '</strong></span>';
    } else {
      retSec.hidden = true;
    }

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
    // holdings merged by symbol (taxable + retirement) + RSU value as its own slice
    const bySym = {};
    gs.forEach(g => { bySym[g.symbol] = (bySym[g.symbol] || 0) + (g.value ?? g.cost); });
    const items = Object.keys(bySym).map(s => ({ symbol: s, v: bySym[s] }));
    const rsuBySym = {};
    state.rsu.forEach(function (r) {
      const q = state.quotes[r.symbol];
      if (q && q.price != null) rsuBySym[r.symbol] = (rsuBySym[r.symbol] || 0) + r.sellable * q.price;
    });
    Object.keys(rsuBySym).forEach(s => items.push({ symbol: s + ' RSU', v: rsuBySym[s] }));
    const total = items.reduce((s, it) => s + it.v, 0);
    if (!total) return '';
    const shares = items.sort((a, b) => b.v - a.v);
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
  const pctTxt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v)) + '%';

  function renderRsu() {
    const sec = $('rsuSection');
    if (!state.rsu.length) { sec.hidden = true; return; }
    sec.hidden = false;

    const syms = [...new Set(state.rsu.map(r => r.symbol))];
    const q0 = syms.length === 1 ? state.quotes[syms[0]] : null;
    $('rsuTitle').innerHTML = 'RSUs — ' + syms.join(', ') +
      (q0 && q0.price != null
        ? ' <span class="dim">$' + fmt(q0.price) + '</span>' +
          (q0.prevClose ? ' <span class="' + signCls(q0.price - q0.prevClose) + '">' +
            pctTxt((q0.price - q0.prevClose) / q0.prevClose * 100) + '</span>' : '')
        : '');
    const t = rsuTotals();
    $('rsuNumbers').innerHTML =
      '<span>Current <strong>' + (t.anyValue ? '$' + fmt(t.current) : '—') + '</strong></span>' +
      '<span>Potential <strong>' + (t.anyValue ? '$' + fmt(t.potential) : '—') + '</strong></span>';

    const tb = $('rsuBody');
    tb.innerHTML = '';
    const sums = { granted: 0, vested: 0, unvested: 0, sellable: 0, value: 0, anyV: false };
    state.rsu.forEach(function (r) {
      const q = state.quotes[r.symbol];
      const value = q && q.price != null ? (r.sellable + r.unvested) * q.price : null;
      sums.granted += r.granted; sums.vested += r.vested;
      sums.unvested += r.unvested; sums.sellable += r.sellable;
      if (value != null) { sums.value += value; sums.anyV = true; }
      const tr = document.createElement('tr');
      tr.className = 'rsu-row';
      tr.innerHTML =
        '<td class="sym">' + r.grantDate + (syms.length > 1 ? ' · ' + r.symbol : '') + '</td>' +
        '<td class="num">' + fmt(r.granted, 0) + '</td>' +
        '<td class="num">' + fmt(r.vested, 0) + '</td>' +
        '<td class="num">' + fmt(r.unvested, 0) + '</td>' +
        '<td class="num">' + fmt(r.sellable, 0) + '</td>' +
        '<td class="num">' + fmt(value) + '</td>';
      tr.addEventListener('click', () => openDetail(r.symbol));
      tb.appendChild(tr);
    });
    const trTot = document.createElement('tr');
    trTot.className = 'rsu-total';
    trTot.innerHTML =
      '<td class="sym">Totals</td>' +
      '<td class="num">' + fmt(sums.granted, 0) + '</td>' +
      '<td class="num">' + fmt(sums.vested, 0) + '</td>' +
      '<td class="num">' + fmt(sums.unvested, 0) + '</td>' +
      '<td class="num">' + fmt(sums.sellable, 0) + '</td>' +
      '<td class="num">' + (sums.anyV ? fmt(sums.value) : '—') + '</td>';
    tb.appendChild(trTot);
  }

  // Day/Total column headers sort by the field currently displayed
  function headerSortKey(k) {
    if (k === 'day') return state.dispMode === '%' ? 'dayPct' : 'dayGain';
    if (k === 'total') return state.dispMode === '%' ? 'gainPct' : 'gain';
    return k;
  }

  function setSort(key, dir) {
    state.sort = { key: key, dir: dir != null ? dir : (key === 'symbol' ? 1 : -1) };
    localStorage.setItem(LS.sortKey, key);
    render();
  }

  /* ---------- symbol detail / chart ---------- */

  async function openDetail(symbol) {
    state.detailSymbol = symbol;
    $('detailTitle').textContent = symbol === PORTFOLIO ? 'Portfolio' : symbol;
    toggle($('detail'), true);
    renderDetailStats(symbol);
    renderDetailLots(symbol);
    await loadChart();
  }

  function renderDetailStats(symbol) {
    const stat = (label, val, cls, sub) =>
      '<div class="stat"><div class="label">' + label + '</div>' +
      '<div class="val ' + (cls || '') + '">' + val + '</div>' +
      (sub ? '<div class="sub ' + (cls || '') + '">' + sub + '</div>' : '') + '</div>';
    let items;
    if (symbol === PORTFOLIO) {
      const gs = groups();
      const cost = gs.reduce((s, g) => s + g.cost, 0);
      const anyValue = gs.some(g => g.value != null);
      const value = gs.reduce((s, g) => s + (g.value ?? g.cost), 0);
      const day = gs.reduce((s, g) => s + (g.dayGain || 0), 0);
      const gain = anyValue ? value - cost : null;
      items =
        stat('Value', '$' + fmt(anyValue ? value : null)) +
        stat('Cost Basis', '$' + fmt(cost)) +
        stat("Day's Gain", gainTxt(day), signCls(day)) +
        stat('Total Gain', gain != null ? gainTxt(gain) : '—', signCls(gain),
          gain != null && cost ? pctTxt(gain / cost * 100) : '') +
        stat('Positions', gs.length, '', state.holdings.length + ' lots');
    } else if (!allLots().some(x => x.symbol === symbol) && state.rsu.some(r => r.symbol === symbol)) {
      // RSU-only symbol
      const grants = state.rsu.filter(r => r.symbol === symbol);
      const q = state.quotes[symbol] || {};
      const sellable = grants.reduce((s, r) => s + r.sellable, 0);
      const unvested = grants.reduce((s, r) => s + r.unvested, 0);
      const dayPct = (q.price != null && q.prevClose) ? (q.price - q.prevClose) / q.prevClose * 100 : null;
      items =
        stat('Last Price', q.price != null ? '$' + fmt(q.price) : '—',
          signCls(dayPct), dayPct != null ? pctTxt(dayPct) + ' today' : '') +
        stat('Prev Close', q.prevClose != null ? '$' + fmt(q.prevClose) : '—') +
        stat('Sellable', fmt(sellable, 0)) +
        stat('Unvested', fmt(unvested, 0)) +
        stat('Current Value', q.price != null ? '$' + fmt(sellable * q.price) : '—') +
        stat('Potential', q.price != null ? '$' + fmt(unvested * q.price) : '—') +
        stat("Day's Gain", (q.price != null && q.prevClose != null)
          ? gainTxt(sellable * (q.price - q.prevClose)) : '—',
          signCls(dayPct), 'sellable shares') +
        stat('Grants', grants.length);
    } else {
      const g = groups(allLots()).find(x => x.symbol === symbol);
      if (!g) { $('detailStats').innerHTML = ''; return; }
      const q = state.quotes[symbol] || {};
      const termTxt = { long: 'Long-term', short: 'Short-term', mixed: 'Mixed lots', na: 'Unknown' }[g.term];
      items =
        stat('Last Price', g.price != null ? '$' + fmt(g.price) : '—',
          signCls(g.dayPct), g.dayPct != null ? pctTxt(g.dayPct) + ' today' : '') +
        stat('Prev Close', q.prevClose != null ? '$' + fmt(q.prevClose) : '—') +
        stat('Qty', fmt(g.qty, g.qty % 1 ? 2 : 0)) +
        stat('Avg Cost', g.avgCost != null ? '$' + fmt(g.avgCost) : '—') +
        stat('Cost Basis', '$' + fmt(g.cost)) +
        stat('Value', g.value != null ? '$' + fmt(g.value) : '—') +
        stat("Day's Gain", g.dayGain != null ? gainTxt(g.dayGain) : '—', signCls(g.dayGain),
          g.dayPct != null ? pctTxt(g.dayPct) : '') +
        stat('Total Gain', g.gain != null ? gainTxt(g.gain) : '—', signCls(g.gain),
          g.gainPct != null ? pctTxt(g.gainPct) : '') +
        stat('Held', (g.term === 'na' ? '' :
          '<span class="term-dot ' + (g.term === 'short' ? 'short' : 'long') + '"></span>') + termTxt,
          '', g.lots.length > 1 ? g.lots.length + ' lots' : '');
    }
    $('detailStats').innerHTML = items;
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
    const symbols = [...new Set(allLots().map(r => r.symbol))].filter(s => s !== 'CASH');
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

    const lots = allLots().map(r => ({
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

    const lots = symbol === PORTFOLIO ? allLots() : allLots().filter(r => r.symbol === symbol);
    let markers = lots.map(function (r) {
      return {
        t: parseDate(r.dateAcquired),
        // on the portfolio chart the marker sits on the curve (price: null)
        price: symbol === PORTFOLIO ? null : r.pricePaid,
        label: 'Bought ' + fmt(r.qty, r.qty % 1 ? 2 : 0) + ' ' + r.symbol +
          ' @ $' + fmt(r.pricePaid) + ' (' + r.dateAcquired + ')'
      };
    }).filter(m => m.t);
    // RSU-only symbol: mark grant dates instead of buys
    if (symbol !== PORTFOLIO && !markers.length) {
      markers = state.rsu.filter(r => r.symbol === symbol).map(function (r) {
        return {
          t: parseDate(r.grantDate),
          price: null,
          label: 'Granted ' + fmt(r.granted, 0) + ' (' + r.grantDate + ')'
        };
      }).filter(m => m.t);
    }

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
      ? [...allLots()].sort((a, b) => (parseDate(a.dateAcquired) || 0) - (parseDate(b.dateAcquired) || 0))
      : allLots().filter(r => r.symbol === symbol);
    if (!lots.length) { $('detailLots').innerHTML = ''; return; } // e.g. RSU-only symbol
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
      const raw = $('apiUrlInput').value.trim();
      const url = normalizeApiInput(raw);
      if (raw && !url) {
        $('testResult').textContent = '✗ Not a valid backend URL or setup link.';
        $('testResult').style.color = 'var(--red)';
        return;
      }
      localStorage.setItem(LS.api, url);
      toggle($('settings'), false);
      refresh(true);
    };
    $('testApiBtn').onclick = async function () {
      const el = $('testResult');
      el.textContent = 'Testing…';
      try {
        const url = normalizeApiInput($('apiUrlInput').value);
        if (!url) throw new Error('not a valid backend URL or setup link');
        $('apiUrlInput').value = url;
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
      const key = headerSortKey(th.dataset.key);
      if (state.sort.key === key) setSort(key, -state.sort.dir);
      else setSort(key);
    });

    $('sortSel').addEventListener('change', function () {
      setSort(this.value);
    });

    $('modeToggle').onclick = function () {
      state.dispMode = state.dispMode === '%' ? '$' : '%';
      localStorage.setItem(LS.dispMode, state.dispMode);
      // keep the sort on the same column when it tracks the display mode
      const swap = { dayPct: 'dayGain', dayGain: 'dayPct', gainPct: 'gain', gain: 'gainPct' };
      if (swap[state.sort.key]) state.sort.key = swap[state.sort.key];
      localStorage.setItem(LS.sortKey, state.sort.key);
      render();
    };

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
