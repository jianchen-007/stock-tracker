#!/usr/bin/env python3
"""Local dev server for Stock Tracker.

Serves the static app AND mimics the Apps Script backend at /api, so the full
app (live quotes, history charts) works locally before the Apps Script is
deployed. Holdings come from holdings.csv; quotes/history are proxied from
Yahoo Finance. POST write-backs are acknowledged but only logged — the real
Google Sheet is only written by the Apps Script backend.

Usage:  python3 dev-server.py [port]     (default 8765)
"""
import csv
import json
import os
import sys
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


def yahoo_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def yahoo_symbol(s):
    return s.replace(".", "-")


def get_holdings():
    rows = []
    with open(os.path.join(ROOT, "holdings.csv"), newline="") as f:
        for i, rec in enumerate(csv.DictReader(f)):
            if not rec.get("Symbol"):
                continue
            qty = float(rec["Qty"])
            price_paid = float(rec["Price Paid $"])
            rows.append({
                "row": i + 2,
                "symbol": rec["Symbol"].strip().upper(),
                "qty": qty,
                "pricePaid": price_paid,
                "dateAcquired": rec["Date Acquired"],
                "totalCost": float(rec.get("Total Cost $") or 0) or qty * price_paid,
                "bank": rec.get("Bank", ""),
            })
    return {"rows": rows}


def get_quotes(symbols):
    out = {}
    for s in symbols:
        try:
            meta = yahoo_json(
                "https://query1.finance.yahoo.com/v8/finance/chart/"
                + urllib.parse.quote(yahoo_symbol(s)) + "?range=1d&interval=1d"
            )["chart"]["result"][0]["meta"]
            out[s] = {
                "price": meta.get("regularMarketPrice"),
                "prevClose": meta.get("chartPreviousClose", meta.get("previousClose")),
                "currency": meta.get("currency"),
                "marketTime": meta.get("regularMarketTime"),
            }
        except Exception as e:  # symbol Yahoo doesn't know, network blip, ...
            out[s] = {"error": str(e)}
    return out


def get_history(symbol, rng):
    interval = "1wk" if rng in ("5y", "max") else "1d"
    res = yahoo_json(
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(yahoo_symbol(symbol))
        + "?range=" + urllib.parse.quote(rng) + "&interval=" + interval
    )["chart"]["result"][0]
    quote = res["indicators"]["quote"][0]
    adj = (res["indicators"].get("adjclose") or [{}])[0].get("adjclose")
    return {
        "symbol": symbol,
        "range": rng,
        "timestamps": res.get("timestamp", []),
        "closes": adj or quote.get("close", []),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _json(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.rstrip("/") != "/api":
            return super().do_GET()
        q = dict(urllib.parse.parse_qsl(u.query))
        try:
            action = q.get("action", "holdings")
            if action == "ping":
                data = {"pong": True, "sheet": "holdings.csv (local dev)"}
            elif action == "holdings":
                data = get_holdings()
            elif action == "quotes":
                data = get_quotes([s for s in q.get("symbols", "").split(",") if s])
            elif action == "history":
                data = get_history(q["symbol"], q.get("range", "1y"))
            else:
                raise ValueError("Unknown action: " + action)
            self._json({"ok": True, "data": data})
        except Exception as e:
            self._json({"ok": False, "error": str(e)})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
            print("[dev] write-back received (NOT persisted locally):",
                  body.get("action"), len(body.get("rows", [])), "rows")
            self._json({"ok": True, "written": 0, "dev": True,
                        "note": "dev server does not write to the Google Sheet"})
        except Exception as e:
            self._json({"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write("[dev] %s\n" % (fmt % args))


if __name__ == "__main__":
    print(f"Stock Tracker dev server: http://localhost:{PORT}  (api at /api)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
