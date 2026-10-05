// Presentation rules are deterministic and deliberately separate from OPRA
// trade classification in the gateway. Unknown premium is never directional.
export const flowStates = {
 'connecting': ['CONNECTING', 'Opening the selected stock’s options feed'],
 'collecting': ['BUILDING FLOW', 'Waiting for a complete, liquid 15s sample'],
 'not-configured': ['CONNECT OPTIONS', 'Configure the local options gateway to receive trades + quotes'],
 'not-entitled': ['OPTIONS ACCESS', 'Real-time options trades and quotes are not authorized'],
 'gateway-upgrade': ['UPDATE GATEWAY', 'The connected gateway does not yet serve options flow'],
 'gateway-offline': ['OPTIONS OFFLINE', 'Waiting for the options gateway to reconnect'],
 'delayed': ['DELAYED FEED', 'Delayed options data cannot confirm a scalp'],
 'market-closed': ['OPTIONS CLOSED', 'Options flow is available during regular market hours'],
 'waiting-tape': ['WAITING FOR TAPE', 'Fresh stock trades are required for comparison'],
 'no-options': ['NO OPTIONS', 'No standard near-dated contracts in the selected range'],
 'stale': ['FLOW STALE', 'Directional readings cleared until fresh trades and quotes arrive'],
 'replay-unavailable': ['NO FLOW REPLAY', 'This replay has no recorded transaction-flow timeline'],
 'live-only': ['LIVE OPTIONS ONLY', 'Demo data is not presented as real options flow'],
 'context-changed': ['SYMBOL CHANGED', 'Starting a fresh options window'],
 'invalid-data': ['FLOW UNAVAILABLE', 'The gateway response did not pass validation'],
 'refreshing': ['REFRESHING CHAIN', 'Updating the contract selection; windows restart']
};
export function premium(v, signed = false) {
 if (!Number.isFinite(v)) return '—';
 const n = Math.abs(v), amount = n >= 1e6 ? `${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `${(n/1e3).toFixed(n>=100e3?0:1)}K` : `${Math.round(n)}`;
 return `${v<0?'−':signed&&v>0?'+':''}$${amount}`;
}
export function direction(w) {
 if (!w?.ready || !Number.isFinite(w.net) || !(w.bull+w.bear>0)) return 0;
 const imbalance=w.net/(w.bull+w.bear);
 return Math.abs(imbalance)<.2 ? 0 : Math.sign(imbalance);
}
export function flowView(reply, nowMS, tape) {
 if (!reply || reply.schemaVersion!==1) return {status:'connecting'};
 if (nowMS-reply.asOfMS>5000 || reply.asOfMS>nowMS+2000) return {status:'stale'};
 if (!['ready','collecting'].includes(reply.status)) return {status:reply.status};
 const windows=reply.windows;
 if (!Array.isArray(windows)||windows.length!==3) return {status:'invalid-data'};
 if (reply.lastTradeMS && (nowMS-reply.lastTradeMS>20000 || nowMS-reply.lastQuoteMS>20000)) return {status:'stale'};
 const w=windows[0], side=direction(w), prior=reply.previous15;
 const classified=w.bull+w.bear;
 const eligible = w.ready && reply.lastTradeMS>0 && reply.lastQuoteMS>0;
 const tapeSide = tape?.ready ? tape.side : 0;
 const divergence = eligible && side!==0 && tapeSide!==0 && side!==tapeSide;
 const aligned = eligible && side!==0 && side===tapeSide;
 let pace='PACE BUILDING';
 if (eligible && prior?.ready) {
  // Compare same-side premium per second in adjacent, equal-duration windows.
  const a=side>0?w.bull:side<0?w.bear:0, b=side>0?prior.bull:side<0?prior.bear:0;
  pace=side===0?'PACE MIXED':b<=0?'PACE NEW':a/b>=1.25?'ACCELERATING':a/b<=.75?'SLOWING':'STEADY';
 }
 return {status:eligible?'ready':'collecting', windows, side, divergence, aligned, pace,
  coverage:Math.round(w.coverage*100), imbalance:classified>0?Math.round(w.net/classified*100):0,
  title:!eligible?'BUILDING FLOW':divergence?'FLOW DIVERGENCE':aligned?'TAPE + FLOW ALIGN':side>0?'BULLISH FLOW':side<0?'BEARISH FLOW':'TWO-WAY FLOW',
  tapeLabel:!tape?.ready?'TAPE BUILDING':tapeSide>0?'TAPE BUY':tapeSide<0?'TAPE SELL':'TAPE MIXED'};
}
