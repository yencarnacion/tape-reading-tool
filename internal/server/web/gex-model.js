import { classifyRTH } from './adr-rth-extension-model.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
export const GEX_STATES = Object.freeze({
  loading: ['GEX LOADING', 'Waiting for a complete chain snapshot'],
  unavailable: ['GEX UNAVAILABLE', 'No usable chain snapshot'],
  'not-configured': ['GEX NOT SET UP', 'Uses the configured local options gateway'],
  'gateway-config': ['GATEWAY CONFIG', 'The options gateway must be local'],
  'gateway-offline': ['GEX OFFLINE', 'Local options gateway unavailable'],
  'gateway-unavailable': ['GEX UNAVAILABLE', 'The gateway could not supply this chain'],
  'access-denied': ['OPTIONS ACCESS', 'Options snapshots are not available on this connection'],
  'rate-limited': ['GEX RETRYING', 'Provider pacing; waiting before another request'],
  busy: ['GEX RETRYING', 'Snapshot capacity is busy'],
  'waiting-tape': ['WAITING FOR STOCK', 'A fresh selected-stock price is required'],
  'market-closed': ['GEX MARKET CLOSED', 'Live chain snapshots during regular trading hours'],
  'live-only': ['LIVE GEX ONLY', 'Synthetic feeds do not provide options positioning'],
  'no-options': ['NO OPTIONS CHAIN', 'No contracts returned in this expiry window'],
  insufficient: ['GEX INPUTS MISSING', 'Gamma, open interest or standard contract size unavailable'],
  'poor-coverage': ['PARTIAL • NO BIAS', 'Too much gamma or open interest is missing'],
  'freshness-unknown': ['AGE UNKNOWN • NO BIAS', 'The provider did not supply usable underlying freshness'],
  stale: ['GEX STALE • NO BIAS', 'Snapshot inputs are too old'],
  delayed: ['DELAYED • NO BIAS', 'Delayed data is not used for a current regime cue'],
  'price-moved': ['STOCK MOVED • REFRESH', 'Stock moved at least 1% from the snapshot; waiting for a new chain'],
  'chain-too-large': ['CHAIN PARTIAL • NO BIAS', 'Pagination limit reached; no partial-chain directional total'],
  'replay-unavailable': ['NO RECORDED GEX', 'This replay has no GEX snapshot at this time'],
  'replay-gap': ['GEX REPLAY GAP', 'Last recorded snapshot is more than 90 seconds old'],
  'archive-too-large': ['GEX ARCHIVE LARGE', 'Recorded file exceeds the bounded replay limit'],
  'archive-invalid': ['GEX ARCHIVE INVALID', 'Recorded snapshot could not be read safely'],
  'context-changed': ['GEX SWITCHING', 'Selected stock or timeline changed'],
  'invalid-data': ['GEX INPUTS INVALID', 'Snapshot identity, timing or exposure totals do not reconcile']
});

export function gexMoney(value, signed = true) {
  if (!finite(value)) return '—';
  const abs = Math.abs(value), scale = abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1;
  const suffix = scale === 1e9 ? 'B' : scale === 1e6 ? 'M' : scale === 1e3 ? 'K' : '';
  return `${value < 0 ? '−' : signed && value > 0 ? '+' : ''}$${(abs / scale).toLocaleString('en-US', {maximumFractionDigits: scale > 1 ? 1 : 0})}${suffix}`;
}

export function validGEXPayload(reply) {
  if (!reply || reply.schemaVersion !== 1 || reply.model !== 'calls-positive-puts-negative' ||
      !reply.complete || ![reply.net,reply.gross,reply.call,reply.put,reply.spot,reply.asOfMS].every(finite) ||
      reply.spot <= 0 || reply.asOfMS <= 0 || reply.gross < 0 || reply.call < 0 || reply.put > 0) return false;
  const close = (a,b) => Math.abs(a-b) <= Math.max(.0001,Math.abs(b)*1e-9);
  if (!close(reply.net,reply.call+reply.put) || !close(reply.gross,reply.call-reply.put)) return false;
  const c = reply.coverage;
  if (!c || !Number.isInteger(c.seen) || !Number.isInteger(c.included) || c.seen < 1 || c.included < 1 || c.included > c.seen ||
      ![c.knownOI,c.includedOI,c.oiFraction].every(finite) || c.knownOI < 0 || c.includedOI < 0 || c.includedOI > c.knownOI || c.oiFraction < 0 || c.oiFraction > 1) return false;
  if ([c.missingGamma,c.missingOI,c.nonstandard,c.invalid].some(value => !Number.isInteger(value) || value < 0 || value > c.seen)) return false;
  if (c.knownOI > 0 && !close(c.oiFraction,c.includedOI/c.knownOI)) return false;
  for (const group of [reply.strikes,reply.expiries]) {
    if (!Array.isArray(group) || !group.length) return false;
    let calls=0,puts=0; const identities=new Set();
    for (const bucket of group) {
      const key=group===reply.strikes?bucket.strike:bucket.expiry;
      if (identities.has(key)) return false; identities.add(key);
      if (group===reply.expiries && (typeof key!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(key) || key>reply.throughExpiry)) return false;
      if (![bucket.call,bucket.put,bucket.net].every(finite) || bucket.call < 0 || bucket.put > 0 || !close(bucket.net,bucket.call+bucket.put)) return false;
      calls+=bucket.call; puts+=bucket.put;
    }
    if (!close(calls,reply.call) || !close(puts,reply.put)) return false;
  }
  return reply.strikes.every(bucket => finite(bucket.strike) && bucket.strike > 0);
}

export function gexView(reply, nowMS, context) {
  const blocked = status => ({status, tone:'neutral', usable:false, label:(GEX_STATES[status]||GEX_STATES['invalid-data'])[0], reason:(GEX_STATES[status]||GEX_STATES['invalid-data'])[1]});
  const replay = ['replay','render'].includes(context.mode);
  if (!['live','massive','replay','render'].includes(context.mode)) return blocked('live-only');
  if (!replay && !context.status?.connected) return blocked('waiting-tape');
  if (!replay && classifyRTH(nowMS*1000).phase !== 'open') return blocked('market-closed');
  if (!reply) return blocked('loading');
  if (reply.symbol !== context.symbol || reply.generation !== context.generation || reply.maxDTE !== context.maxDTE) return blocked('context-changed');
  if (replay !== (reply.replay === true)) return blocked('invalid-data');
  if (reply.status !== 'ready') return blocked(GEX_STATES[reply.status] ? reply.status : 'invalid-data');
  if (!validGEXPayload(reply)) return blocked('invalid-data');
  if (reply.asOfMS > nowMS + (replay ? 0 : 2000)) return blocked('invalid-data');
  if (nowMS-reply.asOfMS > 90000) return blocked(replay ? 'replay-gap' : 'stale');
  const c=reply.coverage;
  if (c.oiFraction < .9 || c.included/c.seen < .8 || c.missingOI > 0) return blocked('poor-coverage');
  if (reply.gross > 0 && (!finite(reply.underlyingMS) || reply.underlyingMS <= 0)) return blocked('freshness-unknown');
  if (reply.gross > 0 && (reply.underlyingMS > nowMS+(replay?0:2000) || nowMS-reply.underlyingMS > 90000)) return blocked('stale');
  if (!replay && finite(context.spot) && context.spot > 0 && Math.abs(context.spot/reply.spot-1) >= .01) return blocked('price-moved');
  const balanced = reply.gross === 0 || Math.abs(reply.net)/reply.gross < .1;
  const tone = balanced ? 'neutral' : reply.net > 0 ? 'dampen' : 'amplify';
  const nearby = reply.strikes.filter(bucket => Math.abs(bucket.strike/reply.spot-1) <= .1);
  const largest = sign => nearby.filter(bucket => Math.sign(bucket.net) === sign).sort((a,b) => Math.abs(b.net)-Math.abs(a.net) || a.strike-b.strike)[0] || null;
  const spot = finite(context.spot) && context.spot > 0 ? context.spot : reply.spot;
  const sessionDate = classifyRTH(reply.asOfMS*1000).sessionDateET;
  const throughWeek = new Date(Date.parse(sessionDate+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
  const nearTermGross = reply.expiries.filter(bucket => bucket.expiry >= sessionDate && bucket.expiry <= throughWeek)
    .reduce((sum,bucket) => sum+bucket.call-bucket.put,0);
  const concentrations = [...nearby].sort((a,b) => Math.abs(b.net)-Math.abs(a.net) || a.strike-b.strike)
    .slice(0,12).sort((a,b) => a.strike-b.strike);
  return {status:'ready', usable:true, tone,
    label:balanced?'↔ BALANCED PROXY':tone==='dampen'?'↔ RANGE / FADE BIAS':'⇅ EXPANSION BIAS',
    reason:balanced?'Calls and puts mostly offset; small net relative to gross modeled exposure':tone==='dampen'?'Assumed hedging opposes moves: fades may have more support after a tape turn':'Assumed hedging follows moves: momentum may extend in either direction',
    positive:largest(1),negative:largest(-1), spot, concentrations,
    nearTermGrossFraction:reply.gross>0 ? nearTermGross/reply.gross : null,
    age:Math.max(0,Math.floor((nowMS-reply.asOfMS)/1000))};
}
