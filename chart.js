/* Minimal dependency-free canvas line chart with buy markers and hover tooltip. */
(function () {
  'use strict';

  function niceStep(rough) {
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const frac = rough / pow;
    let nice;
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
    return nice * pow;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function fmtDate(ts, withYear) {
    const d = new Date(ts * 1000);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + (withYear ? ' ' + d.getFullYear() : '');
  }

  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * PriceChart(canvas, tipEl)
   *   .setData({timestamps:[unix s], closes:[num], markers:[{t: unix s, price, label}]})
   */
  function PriceChart(canvas, tipEl) {
    this.canvas = canvas;
    this.tip = tipEl;
    this.data = null;
    this.pad = { l: 56, r: 14, t: 14, b: 28 };
    this._bindHover();
    const self = this;
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { self.draw(); }).observe(canvas);
    } else {
      window.addEventListener('resize', function () { self.draw(); });
    }
  }

  PriceChart.prototype.setData = function (data) {
    // keep only points that have a close value
    const ts = [], cl = [];
    (data.timestamps || []).forEach(function (t, i) {
      const c = data.closes[i];
      if (c != null && !isNaN(c)) { ts.push(t); cl.push(c); }
    });
    this.data = { timestamps: ts, closes: cl, markers: data.markers || [] };
    this.draw();
  };

  PriceChart.prototype._plot = function () {
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    const d = this.data;
    if (!d || d.closes.length < 2 || w === 0) return null;

    let min = Math.min.apply(null, d.closes);
    let max = Math.max.apply(null, d.closes);
    // include marker prices that fall inside the time range
    const t0 = d.timestamps[0], t1 = d.timestamps[d.timestamps.length - 1];
    d.markers.forEach(function (m) {
      if (m.t >= t0 && m.t <= t1 && m.price != null) {
        min = Math.min(min, m.price);
        max = Math.max(max, m.price);
      }
    });
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    min -= span * 0.06;
    max += span * 0.06;

    const pad = this.pad;
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    return {
      w: w, h: h, iw: iw, ih: ih, min: min, max: max, t0: t0, t1: t1,
      x: function (t) { return pad.l + (t - t0) / (t1 - t0 || 1) * iw; },
      y: function (v) { return pad.t + (1 - (v - min) / (max - min)) * ih; }
    };
  };

  PriceChart.prototype.draw = function () {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const p = this._plot();
    if (!p) return;
    const d = this.data;
    const pad = this.pad;

    ctx.font = '11.5px -apple-system, "Segoe UI", Roboto, sans-serif';

    // y grid + labels
    const step = niceStep((p.max - p.min) / 5);
    ctx.strokeStyle = cssVar('--chart-grid', '#eceef1');
    ctx.fillStyle = cssVar('--chart-label', '#98a2b3');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(p.min / step) * step; v <= p.max; v += step) {
      const y = p.y(v);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(+v.toFixed(2)), pad.l - 8, y);
    }

    // x labels (~6)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const n = d.timestamps.length;
    const withYear = (p.t1 - p.t0) > 300 * 86400;
    for (let i = 0; i < 6; i++) {
      const idx = Math.min(n - 1, Math.round(i * (n - 1) / 5));
      ctx.fillText(fmtDate(d.timestamps[idx], withYear), p.x(d.timestamps[idx]), h - pad.b + 8);
    }

    // area fill + line
    const up = d.closes[n - 1] >= d.closes[0];
    const lineColor = up ? cssVar('--green', '#067647') : cssVar('--red', '#b42318');
    const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    grad.addColorStop(0, up ? cssVar('--green-fill', 'rgba(6,118,71,.18)') : cssVar('--red-fill', 'rgba(180,35,24,.18)'));
    grad.addColorStop(1, 'rgba(128,128,128,0)');

    ctx.beginPath();
    d.timestamps.forEach(function (t, i) {
      const x = p.x(t), y = p.y(d.closes[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineTo(p.x(p.t1), h - pad.b);
    ctx.lineTo(p.x(p.t0), h - pad.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // buy markers
    ctx.textAlign = 'center';
    let clipped = 0;
    const self = this;
    d.markers.forEach(function (m) {
      if (m.t < p.t0 || m.t > p.t1) { clipped++; return; }
      // y position: marker's own price if known, else the series value at that date
      const price = m.price != null ? m.price : d.closes[self._nearestIdx(m.t)];
      const x = p.x(m.t), y = p.y(price);
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x - 5.5, y + 4);
      ctx.lineTo(x + 5.5, y + 4);
      ctx.closePath();
      ctx.fillStyle = cssVar('--accent', '#444ce7');
      ctx.fill();
      ctx.strokeStyle = cssVar('--card', '#fff');
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    this._clippedMarkers = clipped;
    this._plotCache = p;
  };

  PriceChart.prototype._nearestIdx = function (t) {
    const ts = this.data.timestamps;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < ts.length; i++) {
      const dd = Math.abs(ts[i] - t);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best;
  };

  PriceChart.prototype._bindHover = function () {
    const self = this;
    this.canvas.addEventListener('mousemove', function (ev) {
      const p = self._plotCache;
      if (!p || !self.data) return;
      const rect = self.canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const t = p.t0 + (mx - self.pad.l) / (p.iw || 1) * (p.t1 - p.t0);
      const i = self._nearestIdx(t);
      const d = self.data;
      const x = p.x(d.timestamps[i]), y = p.y(d.closes[i]);

      self.draw(); // redraw to clear previous crosshair
      const ctx = self.canvas.getContext('2d');
      ctx.strokeStyle = cssVar('--chart-label', '#98a2b3');
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, self.pad.t);
      ctx.lineTo(x, self.canvas.clientHeight - self.pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = cssVar('--ink', '#101828');
      ctx.fill();

      // nearby buy marker?
      let markerNote = '';
      d.markers.forEach(function (m) {
        if (Math.abs(p.x(m.t) - mx) < 8) {
          markerNote += '\n▲ ' + m.label;
        }
      });

      self.tip.textContent = fmtDate(d.timestamps[i], true) + '  $' + fmtMoney(d.closes[i]) + markerNote;
      self.tip.style.left = x + 'px';
      self.tip.style.top = y + 'px';
      self.tip.classList.remove('hidden');
    });
    this.canvas.addEventListener('mouseleave', function () {
      self.tip.classList.add('hidden');
      self.draw();
    });
  };

  window.PriceChart = PriceChart;
})();
