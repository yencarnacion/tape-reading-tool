#!/usr/bin/env python3
"""Prepare quote-derived IV replay through a local options gateway only; never reads a provider key.

Historical option quotes contain no historical vendor IV/Greeks. This uses an
explicit European Black-Scholes approximation with zero rates/dividend yield,
calendar time to 16:00 ET expiry, and bid/ask midpoint. American exercise and
carry are not modeled. No future quote or underlying print enters a sample.
"""
import argparse
import bisect
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import statistics
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')


def stock_index(times_us, as_of_ms):
    # Retain microseconds until the comparison: rounding receipt timestamps down
    # to milliseconds could admit a print just after the sample boundary.
    return bisect.bisect_right(times_us, as_of_ms * 1000) - 1


def price_delta(spot, strike, years, iv, kind):
    width = iv * math.sqrt(years)
    d1 = (math.log(spot / strike) + .5 * iv * iv * years) / width
    d2 = d1 - width
    cdf = lambda x: .5 * (1 + math.erf(x / math.sqrt(2)))
    if kind == 'call':
        return spot * cdf(d1) - strike * cdf(d2), cdf(d1)
    return strike * cdf(-d2) - spot * cdf(-d1), cdf(d1) - 1


def implied(spot, strike, years, mid, kind):
    intrinsic = max(0, spot - strike if kind == 'call' else strike - spot)
    if years <= 0 or mid <= intrinsic or mid >= (spot if kind == 'call' else strike):
        return None
    lo, hi = .0001, 10.
    if price_delta(spot, strike, years, hi, kind)[0] < mid:
        return None
    for _ in range(45):
        x = (lo + hi) / 2
        if price_delta(spot, strike, years, x, kind)[0] < mid:
            lo = x
        else:
            hi = x
    iv = (lo + hi) / 2
    return iv, price_delta(spot, strike, years, iv, kind)[1]


def select_basket(chain, spot, previous):
    pairs = []
    for strike in sorted({c['strike'] for c in chain}):
        call = next((c for c in chain if c['strike'] == strike and c['kind'] == 'call' and .3 <= c['delta'] <= .7), None)
        put = next((c for c in chain if c['strike'] == strike and c['kind'] == 'put' and -.7 <= c['delta'] <= -.3), None)
        if call and put and abs(strike / spot - 1) <= .1:
            pairs.append((call, put))
    pairs.sort(key=lambda p: abs(p[0]['strike'] - spot))
    retained = [p for p in pairs if all(c['ticker'] in previous for c in p)]
    pairs = retained if len(retained) >= 2 and len(retained) * 2 == len(previous) else pairs[:3]
    if len(pairs) < 2:
        return [], set()
    basket = [c for p in pairs for c in p]
    iv = statistics.median(c['iv'] for c in basket)
    if any(abs(c['iv'] / iv - 1) > .25 for c in basket):
        return [], set()
    basis = {c['ticker'] for c in basket}
    for kind, delta in [('call', .25), ('put', -.25)]:
        wing = sorted((c for c in chain if c['kind'] == kind and abs(c['delta'] - delta) <= .08), key=lambda c: (abs(c['delta'] - delta), c['ticker']))
        if wing and wing[0]['ticker'] not in basis:
            basket.append(wing[0])
    return basket, basis


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--symbol', required=True)
    ap.add_argument('--date', required=True)
    ap.add_argument('--db', required=True, help='Recorded stock tape; opened read-only')
    ap.add_argument('--stock-source', choices=['live', 'historical'], default='live')
    ap.add_argument('--stock-provider', choices=['ibkr', 'massive'], default='ibkr')
    ap.add_argument('--out', default='data/options-replay')
    ap.add_argument('--start', default='09:30')
    ap.add_argument('--end', default='10:30')
    ap.add_argument('--expiry', help='Defaults to nearest expiry after replay date, avoiding 0DTE model sensitivity')
    ap.add_argument('--gateway', default=os.environ.get('TAPE_OPTIONS_GATEWAY_URL', ''))
    args = ap.parse_args()
    if not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,15}', args.symbol):
        ap.error('invalid stock symbol')
    u = urllib.parse.urlsplit(args.gateway)
    if u.scheme not in ('http', 'https') or u.hostname not in ('localhost', '127.0.0.1', '::1') or u.username or u.password or u.query or u.fragment:
        ap.error('set --gateway or TAPE_OPTIONS_GATEWAY_URL to a loopback gateway base URL')
    day = dt.date.fromisoformat(args.date)
    start = dt.datetime.fromisoformat(f'{day}T{args.start}').replace(tzinfo=ET)
    end = dt.datetime.fromisoformat(f'{day}T{args.end}').replace(tzinfo=ET)
    if not (start.time() >= dt.time(9, 30) and end.time() <= dt.time(16) and end > start):
        ap.error('choose an increasing same-day RTH window')
    start_ms, end_ms = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    out = Path(args.out)
    cache = out / '.quote-cache'
    cache.mkdir(parents=True, exist_ok=True)
    token = os.environ.get('TAPE_OPTIONS_GATEWAY_TOKEN', '')
    opener = urllib.request.build_opener(type('NoRedirect', (urllib.request.HTTPRedirectHandler,), {'redirect_request': lambda *a, **k: None})())

    def get(path, params=None):
        url = args.gateway.rstrip('/') + '/rest' + path if path.startswith('/v') else urllib.parse.urlunsplit((u.scheme, u.netloc, path, '', ''))
        if params:
            url += '?' + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token} if token else {})
        with opener.open(request, timeout=40) as response:
            result = json.load(response)
        if result.get('status') not in ('OK', 'DELAYED'):
            raise RuntimeError('Historical options data unavailable: ' + str(result.get('status')))
        return result

    def pages(path, params, max_pages=30):
        rows = []
        for _ in range(max_pages):
            data = get(path, params)
            rows.extend(data.get('results', []))
            nxt = data.get('next_url')
            if not nxt:
                return rows
            n = urllib.parse.urlsplit(nxt)
            expected = u.path.rstrip('/') + '/rest' + original_path
            if n.scheme or n.netloc or n.path != expected:
                raise RuntimeError('Nonlocal or unexpected gateway pagination refused')
            path = original_path
            params = dict(urllib.parse.parse_qsl(n.query))
        raise RuntimeError('Historical quote page limit reached; narrow the window')

    db_uri = Path(args.db).resolve().as_uri() + '?mode=ro&immutable=1'
    with sqlite3.connect(db_uri, uri=True) as db:
        stock = db.execute('SELECT event_us,price,exchange_time_ms FROM trades WHERE symbol=? AND source=? AND provider=? AND chart_eligible=1 AND event_us>=? AND event_us<=? ORDER BY event_us,id',
                           (args.symbol, args.stock_source, args.stock_provider, (start_ms - 60000) * 1000, end_ms * 1000)).fetchall()
    stock = [(us, p) for us, p, exchange in stock if p > 0 and exchange <= us // 1000]
    if not stock:
        raise RuntimeError('No recorded underlying trades in requested window')
    times = [s[0] for s in stock]
    first = stock_index(times, start_ms)
    if first < 0 or start_ms * 1000 - times[first] > 20000000:
        raise RuntimeError('A fresh stock print at the start is required')
    spot = stock[first][1]
    original_path = '/v3/reference/options/contracts'
    reference = pages(original_path, {'underlying_ticker': args.symbol, 'as_of': str(day), 'expiration_date.gte': args.expiry or str(day + dt.timedelta(days=1)),
                     'expiration_date.lte': args.expiry or str(day + dt.timedelta(days=21)), 'strike_price.gte': f'{spot*.88:.2f}', 'strike_price.lte': f'{spot*1.12:.2f}',
                     'limit': 1000, 'sort': 'expiration_date', 'order': 'asc'}, 5)
    reference = [c for c in reference if c.get('shares_per_contract') == 100 and not c.get('additional_underlyings') and c.get('contract_type') in ('call', 'put')]
    expiry = args.expiry or min(c['expiration_date'] for c in reference)
    contracts = [c for c in reference if c['expiration_date'] == expiry]
    if not contracts or len(contracts) > 160:
        raise RuntimeError('Need 1–160 standard contracts in the chosen expiry')
    print(f'{args.symbol} {day}: {len(contracts)} contracts expiring {expiry}; underlying at start ${spot:.2f}', flush=True)
    expiry_ms = int(dt.datetime.fromisoformat(expiry + 'T16:00').replace(tzinfo=ET).timestamp() * 1000)

    def download(contract):
        path = '/v3/quotes/' + contract['ticker']
        params = {'timestamp.gte': (start_ms - 20000) * 1000000, 'timestamp.lte': end_ms * 1000000, 'limit': 50000, 'sort': 'timestamp', 'order': 'asc'}
        fingerprint = hashlib.sha256(json.dumps([path, params], sort_keys=True).encode()).hexdigest()[:20]
        dest = cache / (contract['ticker'].replace(':', '-') + '-' + fingerprint + '.json.gz')
        if dest.exists():
            with gzip.open(dest, 'rt') as f:
                rows = json.load(f)
        else:
            rows = []
            for page in range(30):
                for retry in range(4):
                    try:
                        data = get(path, params)
                        break
                    except Exception:
                        if retry == 3:
                            raise
                        time.sleep(2 ** retry)
                rows.extend(data.get('results', []))
                nxt = data.get('next_url')
                if not nxt:
                    break
                n = urllib.parse.urlsplit(nxt)
                if n.scheme or n.netloc or n.path != u.path.rstrip('/') + '/rest' + path:
                    raise RuntimeError('Unexpected historical quote pagination')
                params = dict(urllib.parse.parse_qsl(n.query))
            else:
                raise RuntimeError('Quote pagination exceeded safe bound')
            temp = dest.with_suffix('.tmp')
            with gzip.open(temp, 'wt') as f:
                json.dump(rows, f, separators=(',', ':'))
            temp.replace(dest)
        rows.sort(key=lambda q: (q['sip_timestamp'], q.get('sequence_number', 0)))
        return contract, rows, [q['sip_timestamp'] for q in rows]

    series = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(download, c) for c in contracts]
        for future in concurrent.futures.as_completed(futures):
            item = future.result()
            series.append(item)
            print(f'Quotes {len(series)}/{len(contracts)}: {item[0]["ticker"]} ({len(item[1])})', flush=True)
    series.sort(key=lambda x: x[0]['ticker'])
    samples, previous = [], set()
    for at in range(start_ms, end_ms + 1, 5000):
        index = stock_index(times, at)
        chain = []
        current_spot = stock[index][1] if index >= 0 else 0
        if index >= 0 and at * 1000 - times[index] <= 20000000:
            for c, rows, stamps in series:
                j = bisect.bisect_right(stamps, at * 1000000) - 1
                if j < 0:
                    continue
                q = rows[j]
                bid, ask = q.get('bid_price', 0), q.get('ask_price', 0)
                quote_ms = q['sip_timestamp'] // 1000000
                if not (at - quote_ms <= 20000 and bid > 0 and ask >= bid and q.get('bid_size', 0) > 0 and q.get('ask_size', 0) > 0 and (ask - bid) / ((ask + bid) / 2) <= 1):
                    continue
                solution = implied(current_spot, c['strike_price'], (expiry_ms - at) / (365 * 86400000), (bid + ask) / 2, c['contract_type'])
                if solution:
                    chain.append({'ticker': c['ticker'], 'expiry': expiry, 'kind': c['contract_type'], 'strike': c['strike_price'], 'iv': solution[0], 'delta': solution[1],
                                  'bid': bid, 'ask': ask, 'quoteMS': quote_ms, 'timeframe': 'HISTORICAL', 'bidSize': q['bid_size'], 'askSize': q['ask_size']})
        narrow = [c for c in chain if (c['ask'] - c['bid']) / ((c['ask'] + c['bid']) / 2) <= .2]
        basket, previous = select_basket(narrow, current_spot, previous)
        sample = {'schemaVersion': 1, 'symbol': args.symbol, 'source': 'Historical options quotes', 'status': 'ready' if basket else 'poor-quality',
                  'asOfMS': at, 'spot': current_spot, 'estimated': True, 'contracts': basket}
        if not basket:
            diagnostic, ids = select_basket(chain, current_spot, set())
            atm = [c for c in diagnostic if c['ticker'] in ids]
            intervals = [(implied(current_spot, c['strike'], (expiry_ms - at) / (365 * 86400000), c['bid'], c['kind']),
                          implied(current_spot, c['strike'], (expiry_ms - at) / (365 * 86400000), c['ask'], c['kind'])) for c in atm]
            if len(atm) >= 4 and all(lo and hi for lo, hi in intervals):
                sample['quality'] = {'ivBid': statistics.median(lo[0] for lo, hi in intervals), 'ivAsk': statistics.median(hi[0] for lo, hi in intervals),
                                     'maxSpread': max((c['ask'] - c['bid']) / ((c['ask'] + c['bid']) / 2) for c in atm), 'contracts': len(atm)}
        samples.append(sample)
    artifact = {'schemaVersion': 1, 'symbol': args.symbol, 'date': str(day), 'expiry': expiry, 'startMS': start_ms, 'endMS': end_ms,
                'underlyingSource': args.stock_source, 'underlyingProvider': args.stock_provider,
                'method': 'European Black-Scholes midpoint IV; r=0, q=0; ACT/365; 16:00 ET expiry; American exercise/carry not modeled',
                'source': 'Historical SIP quotes + recorded underlying prints', 'samples': samples}
    target = out / f'{args.symbol}-{day}.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(artifact, separators=(',', ':')))
    temp.replace(target)
    print(f'Prepared {target}: {sum(s["status"] == "ready" for s in samples)}/{len(samples)} usable 5-second samples; {target.stat().st_size} bytes', flush=True)


if __name__ == '__main__':
    main()
