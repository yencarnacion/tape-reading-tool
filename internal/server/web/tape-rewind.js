// The Live Rewind buffer: a time-bounded, fixed-capacity columnar ring over the
// trade events the browser has already been handed, plus the EventSource that
// reads it. Nothing here touches the live feed, the live history, or audio.
//
// Retention is bounded by receipt time rather than print count. The server ring
// is count-bounded, which is about 100 seconds at 500 prints/s but only 25 at
// the 2000 prints/s a halt resume produces: it collapses exactly when a rewind
// is worth having.
//
// Columns instead of objects. One plain object per event costs roughly 200 bytes
// in a modern engine, so a 180-second worst case would reserve about 65MB; the
// ten Float64 columns plus two byte columns below cost 82 bytes per event, and
// they are allocated once and never grow:
//
//   180s x 2000 prints/s x 82B = 29.5MB
//
// Absolute print counts are not a column: prints advance by exactly one per
// event, so the count at logical index i is printsAtHead + i.

import { priceTickSize } from './tape-model.js';

// Index 0 is the wire default, so a zeroed slot decodes as 'mid'.
export const CLASS_NAMES = ['mid', 'below', 'bid', 'ask', 'above'];
const CLASS_INDEX = new Map(CLASS_NAMES.map((name, index) => [name, index]));
const EMPTY_TOTALS = { volume: 0, buyer: 0, seller: 0, prints: 0 };
const MINUTE_US = 6e7;

export class RewindBuffer {
  constructor({ bufferSeconds = 180, maxPrintsPerSecond = 2000 } = {}) {
    this.bufferSeconds = Math.max(1, Number(bufferSeconds) || 1);
    this.bufferUS = this.bufferSeconds * 1e6;
    this.capacity = Math.max(1024, Math.round(this.bufferSeconds * (Number(maxPrintsPerSecond) || 1)));
    this.allocate(this.capacity);
    this.reset();
  }

  allocate(capacity) {
    this.seq = new Float64Array(capacity);
    this.receivedUS = new Float64Array(capacity);
    this.exchangeMS = new Float64Array(capacity);
    this.price = new Float64Array(capacity);
    this.size = new Float64Array(capacity);
    this.bid = new Float64Array(capacity);
    this.ask = new Float64Array(capacity);
    this.prefixVolume = new Float64Array(capacity);
    this.prefixBuyer = new Float64Array(capacity);
    this.prefixSeller = new Float64Array(capacity);
    this.side = new Int8Array(capacity);
    this.klass = new Uint8Array(capacity);
  }

  reset() {
    this.head = 0;
    this.count = 0;
    this.printsAtHead = 1;
    this.gapList = [];
    this.evictedByCapacity = false;
    // A single reused accessor. Visitors must not retain it.
    this.cursor = { s: 0, r: 0, t: 0, p: 0, z: 0, d: 0, c: 'mid', b: 0, a: 0 };
  }

  get bytes() {
    return this.capacity * 82;
  }

  slotAt(index) {
    return (this.head + index) % this.capacity;
  }

  // Appends one delivered trade in wire shape. Constant time: no allocation, no
  // search, and no interaction with the live history the tape renders from.
  push(trade) {
    const seq = Number(trade.s) || 0;
    const receipt = Number(trade.r) || 0;
    if (!seq || !receipt) return;
    if (this.count > 0) {
      const previousSeq = this.seq[this.slotAt(this.count - 1)];
      if (seq <= previousSeq) return;
      // A client that fell behind the server ring reports LAGGED, which leaves a
      // hole here. Record it so a window crossing it can be backfilled instead
      // of quietly understating volume.
      if (seq > previousSeq + 1) this.noteGap(previousSeq + 1, seq - 1);
    }
    if (this.count === this.capacity) {
      this.evictedByCapacity = true;
      this.evictOldest();
    }
    const index = this.count;
    const slot = this.slotAt(index);
    const size = Math.max(0, Number(trade.z) || 0);
    const side = Number(trade.d) || 0;
    const previous = index > 0 ? this.slotAt(index - 1) : -1;
    const baseVolume = previous >= 0 ? this.prefixVolume[previous] : this.prefixBase().volume;
    const baseBuyer = previous >= 0 ? this.prefixBuyer[previous] : this.prefixBase().buyer;
    const baseSeller = previous >= 0 ? this.prefixSeller[previous] : this.prefixBase().seller;

    this.seq[slot] = seq;
    this.receivedUS[slot] = receipt;
    this.exchangeMS[slot] = Number(trade.t) || 0;
    this.price[slot] = Number(trade.p) || 0;
    this.size[slot] = size;
    this.bid[slot] = Number(trade.b) || 0;
    this.ask[slot] = Number(trade.a) || 0;
    this.side[slot] = side;
    this.klass[slot] = CLASS_INDEX.get(trade.c) ?? 0;
    this.prefixVolume[slot] = baseVolume + size;
    this.prefixBuyer[slot] = baseBuyer + (side > 0 ? size : 0);
    this.prefixSeller[slot] = baseSeller + (side < 0 ? size : 0);
    this.count++;
    this.evictExpired(receipt);
  }

  // Retention is by receipt time. The capacity bound is secondary and is
  // reported through retainedSeconds so a shortfall is visible rather than
  // silently guaranteeing less than the configuration asked for.
  evictExpired(newestReceiptUS) {
    const floor = newestReceiptUS - this.bufferUS;
    while (this.count > 0 && this.receivedUS[this.head] < floor) this.evictOldest();
  }

  evictOldest() {
    if (this.count === 0) return;
    const slot = this.head;
    this.pendingBase = {
      volume: this.prefixVolume[slot], buyer: this.prefixBuyer[slot],
      seller: this.prefixSeller[slot], prints: this.printsAtHead
    };
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    this.printsAtHead++;
    const evictedSeq = this.seq[slot];
    // A gap entirely below the floor can never be rewound into again.
    this.gapList = this.gapList.filter((gap) => gap[1] > evictedSeq);
  }

  // Prefix totals for the event immediately before the oldest retained one,
  // matching how the live pane rebases its own prefix sums when it prunes.
  prefixBase() {
    return this.pendingBase || { ...EMPTY_TOTALS, prints: 0 };
  }

  noteGap(from, to) {
    const last = this.gapList[this.gapList.length - 1];
    if (last && last[1] + 1 === from) {
      last[1] = to;
      return;
    }
    this.gapList.push([from, to]);
    // Bounded: a pathological stream cannot grow this without limit.
    if (this.gapList.length > 64) this.gapList.splice(0, this.gapList.length - 64);
  }

  firstSeq() {
    return this.count ? this.seq[this.head] : 0;
  }

  lastSeq() {
    return this.count ? this.seq[this.slotAt(this.count - 1)] : 0;
  }

  firstReceivedUS() {
    return this.count ? this.receivedUS[this.head] : 0;
  }

  lastReceivedUS() {
    return this.count ? this.receivedUS[this.slotAt(this.count - 1)] : 0;
  }

  retainedSeconds() {
    return this.count ? (this.lastReceivedUS() - this.firstReceivedUS()) / 1e6 : 0;
  }

  // First logical index whose receipt time is at or after target, or past the
  // end when there is none. `after` searches strictly greater instead.
  indexAtReceipt(target, after = false) {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const value = this.receivedUS[this.slotAt(middle)];
      if (after ? value <= target : value < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  indexOfSeq(seq) {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.seq[this.slotAt(middle)] < seq) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  read(index) {
    const slot = this.slotAt(index);
    const cursor = this.cursor;
    cursor.s = this.seq[slot];
    cursor.r = this.receivedUS[slot];
    cursor.t = this.exchangeMS[slot];
    cursor.p = this.price[slot];
    cursor.z = this.size[slot];
    cursor.d = this.side[slot];
    cursor.c = CLASS_NAMES[this.klass[slot]];
    cursor.b = this.bid[slot];
    cursor.a = this.ask[slot];
    return cursor;
  }

  prefixAt(index) {
    const slot = this.slotAt(index);
    return {
      volume: this.prefixVolume[slot], buyer: this.prefixBuyer[slot],
      seller: this.prefixSeller[slot], prints: this.printsAtHead + index
    };
  }

  // Rebuilds the ring with backfilled events merged in sequence order. Inserting
  // into the middle of a ring is not a constant-time operation, so this pays a
  // full rebuild; it runs only after a LAGGED hole is actually rewound into.
  merge(events) {
    const incoming = events
      .map((trade) => ({ ...trade, s: Number(trade.s) || 0, r: Number(trade.r) || 0 }))
      .filter((trade) => trade.s > 0 && trade.r > 0)
      .sort((left, right) => left.s - right.s);
    if (!incoming.length) return 0;
    const existing = [];
    for (let index = 0; index < this.count; index++) {
      const event = this.read(index);
      existing.push({ s: event.s, r: event.r, t: event.t, p: event.p, z: event.z, d: event.d, c: event.c, b: event.b, a: event.a });
    }
    const base = this.prefixBase();
    const merged = [];
    let left = 0;
    let right = 0;
    while (left < existing.length || right < incoming.length) {
      if (right >= incoming.length || (left < existing.length && existing[left].s <= incoming[right].s)) {
        merged.push(existing[left++]);
      } else {
        const candidate = incoming[right++];
        if (merged.length && merged[merged.length - 1].s === candidate.s) continue;
        merged.push(candidate);
      }
    }
    const filled = merged.length - existing.length;
    const printsAtHead = this.printsAtHead - filled;
    this.reset();
    this.printsAtHead = Math.max(1, printsAtHead);
    this.pendingBase = { ...base, prints: this.printsAtHead - 1 };
    // The rebuild re-derives the gap list from the merged history, so a hole the
    // server could only partly fill stays recorded and a filled one disappears
    // without any bookkeeping. Anything that no longer fits is evicted by push
    // itself, which keeps the prefix base consistent.
    for (const event of merged) this.push(event);
    return filled;
  }

  gapsBetween(fromSeq, toSeq) {
    return this.gapList
      .filter((gap) => gap[1] >= fromSeq && gap[0] <= toSeq)
      .map((gap) => [Math.max(gap[0], fromSeq), Math.min(gap[1], toSeq)]);
  }

}

// The rewind EventSource. `fetchRange(symbol, fromSeq, toSeq)` is injected so a
// test can drive backfill without a server, and it must resolve to an array of
// wire-shape trades.
export function createRewindSource(buffer, { symbol = () => '', fetchRange = null } = {}) {
  const unfillable = new Set();
  const source = {
    kind: () => 'rewind',
    buffer,
    firstSeq: () => buffer.firstSeq(),
    lastSeq: () => buffer.lastSeq(),
    firstReceivedUS: () => buffer.firstReceivedUS(),
    lastReceivedUS: () => buffer.lastReceivedUS(),
    oldestReceiptUS: () => buffer.firstReceivedUS() || Infinity,
    retainedSeconds: () => buffer.retainedSeconds(),

    at(seq) {
      const index = buffer.indexOfSeq(seq);
      if (index >= buffer.count) return null;
      const event = buffer.read(index);
      return event.s === seq ? event : null;
    },

    seqAtOrBefore(receivedUS) {
      const index = buffer.indexAtReceipt(receivedUS, true) - 1;
      return index >= 0 ? buffer.read(index).s : 0;
    },

    receivedUSAt(seq) {
      const index = buffer.indexOfSeq(seq);
      if (index >= buffer.count) return 0;
      const event = buffer.read(index);
      return event.s === seq ? event.r : 0;
    },

    each(fromSeq, toSeq, visit) {
      for (let index = buffer.indexOfSeq(fromSeq); index < buffer.count; index++) {
        const event = buffer.read(index);
        if (event.s > toSeq) break;
        visit(event);
      }
    },

    // Deliberately identical in form to the stream source: same bounds, same
    // prefix differences, same clamping. Anything else would make a rewound
    // panel disagree with the live panel it is meant to reproduce.
    totalsBetween(startUS, endUS, includeEnd = true) {
      const start = buffer.indexAtReceipt(startUS);
      const end = buffer.indexAtReceipt(endUS, includeEnd) - 1;
      if (start > end || end < 0 || start >= buffer.count) return { ...EMPTY_TOTALS };
      const after = buffer.prefixAt(end);
      const before = start > 0 ? buffer.prefixAt(start - 1) : buffer.prefixBase();
      return {
        volume: Math.max(0, after.volume - before.volume),
        buyer: Math.max(0, after.buyer - before.buyer),
        seller: Math.max(0, after.seller - before.seller),
        prints: Math.max(0, after.prints - before.prints)
      };
    },

    midpointTicks(startUS, endUS) {
      const start = buffer.indexAtReceipt(startUS);
      const end = buffer.indexAtReceipt(endUS, true) - 1;
      if (start > end || end < 0) return 0;
      let firstMidpoint = null;
      for (let index = start; index <= end; index++) {
        const event = buffer.read(index);
        if (event.b > 0 && event.a >= event.b) {
          firstMidpoint = (event.b + event.a) / 2;
          break;
        }
      }
      if (firstMidpoint === null) return 0;
      let lastMidpoint = null;
      for (let index = end; index >= start; index--) {
        const event = buffer.read(index);
        if (event.b > 0 && event.a >= event.b) {
          lastMidpoint = (event.b + event.a) / 2;
          break;
        }
      }
      return (lastMidpoint - firstMidpoint) / priceTickSize(lastMidpoint);
    },

    // The quote at a rewound instant is the quote the server saw when that print
    // arrived. Quote-only ticks are not sequenced on the wire, so between prints
    // this is the last print's book rather than the instantaneous one.
    quoteAt(seq) {
      let index = Math.min(buffer.indexOfSeq(seq), buffer.count - 1);
      for (; index >= 0; index--) {
        const event = buffer.read(index);
        if (event.s <= seq && event.b > 0 && event.a >= event.b) {
          return { bid: event.b, ask: event.a };
        }
      }
      return { bid: 0, ask: 0 };
    },

    // Volume of the one-minute candle that is forming at the target, recomputed
    // from buffered prints. `complete` is false when the buffer floor falls
    // inside that minute, in which case the caller must not show RVOL.
    formingMinuteAt(seq) {
      const index = Math.min(buffer.indexOfSeq(seq), buffer.count - 1);
      if (index < 0) return null;
      // read() hands back one reused accessor, so the target's values have to be
      // copied out before walking back over it.
      const cursor = buffer.read(index);
      const closePrice = cursor.p;
      const timeUS = Math.floor(cursor.t * 1000 / MINUTE_US) * MINUTE_US;
      let volume = 0;
      let dollarVolume = 0;
      let open = closePrice;
      let high = closePrice;
      let low = closePrice;
      let walked = index;
      for (; walked >= 0; walked--) {
        const event = buffer.read(walked);
        if (Math.floor(event.t * 1000 / MINUTE_US) * MINUTE_US !== timeUS) break;
        volume += event.z;
        dollarVolume += event.p * event.z;
        open = event.p;
        high = Math.max(high, event.p);
        low = Math.min(low, event.p);
      }
      return {
        bar: { timeUS, open, high, low, close: closePrice, volume, dollarVolume },
        complete: walked >= 0
      };
    },

    gaps(fromSeq, toSeq) {
      return buffer.gapsBetween(fromSeq, toSeq);
    },

    // Fills every hole overlapping the window, paging until the server reports
    // the range complete. Resolves false when the range is still discontinuous,
    // so the caller can refuse to display metrics rather than understate them.
    async ensure(fromSeq, toSeq) {
      const holes = buffer.gapsBetween(fromSeq, toSeq);
      if (!holes.length) return true;
      if (!fetchRange) return false;
      for (const [from, to] of holes) {
        // A hole the server has already declined to fill is not requested again;
        // the pane reports the range as unavailable instead of retrying per frame.
        const key = `${from}-${to}`;
        if (unfillable.has(key)) continue;
        const collected = [];
        let cursor = from;
        for (let page = 0; page < 32 && cursor <= to; page++) {
          const result = await fetchRange(symbol(), cursor, to);
          const trades = Array.isArray(result?.trades) ? result.trades : [];
          if (!trades.length) break;
          collected.push(...trades);
          const next = Number(result.next_seq_from) || 0;
          if (result.complete || !next || next <= cursor) break;
          cursor = next;
        }
        if (!collected.length) {
          unfillable.add(key);
          continue;
        }
        buffer.merge(collected);
      }
      return buffer.gapsBetween(fromSeq, toSeq).length === 0;
    }
  };
  return source;
}

// Exported for the Node check so it can assert the documented footprint.
export function rewindBufferBytes(bufferSeconds, maxPrintsPerSecond) {
  return Math.max(1024, Math.round(bufferSeconds * maxPrintsPerSecond)) * 82;
}
