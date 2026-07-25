// EventSource: a read-only, seekable view over an ordered stream of delivered
// trade events. Two implementations back the same aggregation and drawing code:
//
//   createStreamSource  the WebSocket stream, which is the live tape and also
//                       historical replay, because replay is server-driven and
//                       arrives as identical `trades` messages
//   RewindSource        the client-side rewind buffer plus /api/tape/range
//                       backfill (see tape-rewind.js)
//
// The contract is:
//
//   kind()                        'stream' | 'rewind'
//   firstSeq() lastSeq()          inclusive extent, 0 when empty
//   firstReceivedUS()             receipt time of the oldest retained event
//   lastReceivedUS()
//   seqAtOrBefore(receivedUS)     receipt time -> sequence, 0 when before the floor
//   receivedUSAt(seq)             sequence -> receipt time, 0 when absent
//   at(seq)                       one event in wire shape, or null
//   each(fromSeq, toSeq, visit)   ordered iteration, no allocation per event
//   totalsBetween(a, b, incl)     {volume, buyer, seller, prints} over receipt time
//   oldestReceiptUS()             floor used by baseline availability tests
//   midpointTicks(a, b)           midpoint movement in ticks across the window
//   gaps(fromSeq, toSeq)          [] for 'stream'
//   ensure(fromSeq, toSeq)        Promise<boolean>, resolves true when contiguous
//
// A visitor must not retain the event object it receives: the rewind source
// hands out a single reused accessor.

import { lowerBound, upperBound, priceTickSize } from './tape-model.js';

const RECEIPT = (trade) => Number(trade?.r) || 0;
const SEQUENCE = (trade) => Number(trade?.s) || 0;
const EMPTY_TOTALS = { volume: 0, buyer: 0, seller: 0, prints: 0 };

export function prefixFromTrade(trade) {
  return {
    volume: Number(trade?._volume) || 0,
    buyer: Number(trade?._buyer) || 0,
    seller: Number(trade?._seller) || 0,
    prints: Number(trade?._prints) || 0
  };
}

// The live stream keeps running prefix sums on the trade objects themselves and
// binary-searches them, so a horizon costs a search rather than a rescan. This
// wraps that existing store without copying it.
export function createStreamSource(state) {
  const trades = () => state.trades;
  return {
    kind: () => 'stream',
    firstSeq: () => SEQUENCE(trades()[0]),
    lastSeq: () => SEQUENCE(trades()[trades().length - 1]),
    firstReceivedUS: () => RECEIPT(trades()[0]),
    lastReceivedUS: () => RECEIPT(trades()[trades().length - 1]),
    oldestReceiptUS: () => RECEIPT(trades()[0]) || Infinity,

    at(seq) {
      const items = trades();
      const index = lowerBound(items, seq, SEQUENCE);
      const trade = items[index];
      return trade && SEQUENCE(trade) === seq ? trade : null;
    },

    seqAtOrBefore(receivedUS) {
      const items = trades();
      const index = upperBound(items, receivedUS, RECEIPT) - 1;
      return index >= 0 ? SEQUENCE(items[index]) : 0;
    },

    receivedUSAt(seq) {
      const trade = this.at(seq);
      return trade ? RECEIPT(trade) : 0;
    },

    each(fromSeq, toSeq, visit) {
      const items = trades();
      for (let index = lowerBound(items, fromSeq, SEQUENCE); index < items.length; index++) {
        const trade = items[index];
        if (SEQUENCE(trade) > toSeq) break;
        visit(trade);
      }
    },

    totalsBetween(startUS, endUS, includeEnd = true) {
      const items = trades();
      const start = lowerBound(items, startUS, RECEIPT);
      const end = (includeEnd ? upperBound : lowerBound)(items, endUS, RECEIPT) - 1;
      if (start > end || end < 0 || start >= items.length) return { ...EMPTY_TOTALS };
      const after = prefixFromTrade(items[end]);
      const before = start > 0 ? prefixFromTrade(items[start - 1]) : state.prefixBase;
      return {
        volume: Math.max(0, after.volume - before.volume),
        buyer: Math.max(0, after.buyer - before.buyer),
        seller: Math.max(0, after.seller - before.seller),
        prints: Math.max(0, after.prints - before.prints)
      };
    },

    midpointTicks(startUS, endUS) {
      const midpoints = state.midpoints;
      const first = lowerBound(midpoints, startUS, RECEIPT);
      const afterLast = upperBound(midpoints, endUS, RECEIPT);
      if (first >= afterLast) return 0;
      const firstTrade = midpoints[first];
      const lastTrade = midpoints[afterLast - 1];
      const firstMidpoint = (Number(firstTrade.b) + Number(firstTrade.a)) / 2;
      const lastMidpoint = (Number(lastTrade.b) + Number(lastTrade.a)) / 2;
      return (lastMidpoint - firstMidpoint) / priceTickSize(lastMidpoint);
    },

    gaps: () => [],
    ensure: () => Promise.resolve(true)
  };
}
