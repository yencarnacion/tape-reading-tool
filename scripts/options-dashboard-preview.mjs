// Full-page local preview with a clearly fabricated feed and model.
// No private network, market provider, GPU, or trading endpoint is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { mockForecast } from './kronos-model-check.mjs';
const root = resolve('internal/server/web');
const start = Date.parse('2026-09-18T14:17:02Z');
let mode = 'replay', symbol = 'TEST', generation = 1, responseState = 'forecast', scenario = 'ready';
const peers = new Set();
function frame(value) {
  const data=Buffer.from(JSON.stringify(value));
  const header=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);
  return Buffer.concat([header,data]);
}
const historyStart=start-310000;
const trade = (i=0) => {
 const buy=scenario.startsWith('buy'), mixed=scenario==='mixed', faster=scenario.endsWith('faster'), steady=scenario.endsWith('steady');
 const side=mixed?(i%2?1:-1):buy?1:-1;
 return {s:i+1,t:historyStart+i*1000,r:(historyStart+i*1000)*1000,p:600-i*.002,z:i<280||steady?100:faster?200:30,c:side===1?'at_ask':'at_bid',d:side,b:600-i*.002,a:600-i*.002+.01};
};
function snapshot() { return {type:'snapshot',symbol,server_time_ms:start,market_chart:true,xtra:true,
  snapshot:{symbol,generation,quote:{bid:599.38,ask:599.39,bid_size:100,ask_size:100,previous_close:598},trades:Array.from({length:scenario==='stale'?290:scenario==='building'?20:311},(_,i)=>trade(scenario==='building'?i+291:i)),history:[symbol],status:{mode,state:'paused',connected:true}},
  display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}}; }
function options() {
 const samples=[];
 for(let i=0;i<=310;i+=5) {
  const stamp=historyStart+i*1000,iv=i<180?.6+i*.001:.78-(i-180)*.001,skew=i<180?.1:.1-(i-180)*.0003;
  const contracts=[599,600,601].flatMap(strike=>['call','put'].map(kind=>({ticker:'O:TEST-'+strike+'-'+kind,expiry:'2026-09-25',kind,strike,iv,delta:kind==='call'?.5:-.5,bid:2,ask:2.1,quoteMS:stamp,timeframe:'HISTORICAL',bidSize:10,askSize:10}))).concat([{ticker:'O:PUT25',kind:'put',delta:-.25,strike:595,iv:iv+skew},{ticker:'O:CALL25',kind:'call',delta:.25,strike:605,iv}].map(c=>({...c,expiry:'2026-09-25',bid:2,ask:2.1,quoteMS:stamp,timeframe:'HISTORICAL',bidSize:10,askSize:10})));
  samples.push({schemaVersion:1,symbol,generation,status:scenario==='wide'?'poor-quality':'ready',replay:true,estimated:true,asOfMS:stamp,spot:600-i*.002,contracts:scenario==='wide'?[]:contracts,...(scenario==='wide'?{quality:{ivBid:.5,ivAsk:.86,maxSpread:.65,contracts:6}}:{})});
 }
 return {...samples.at(-1),method:'Synthetic fixture, not historical market data',samples};
}
function json(w,data,status=200){w.writeHead(status,{'Content-Type':'application/json'});w.end(JSON.stringify(data));}
const server=createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/preview/')) {
      const requested=new URL(req.url,'http://localhost').pathname.slice('/preview/'.length);
      scenario=['wide','partial','buy-faster','buy-slower','buy-steady','sell-faster','sell-slower','sell-steady','mixed','building','stale','offline','running'].includes(requested)?requested:'ready'; responseState=['offline','running'].includes(scenario)?scenario:'forecast'; generation++;
    }
    if(req.url.startsWith('/api/panel-data/options')) {json(res,options());return;}
    if(req.url.startsWith('/api/panel-data/daily-bars')) {json(res,{bars:Array.from({length:20},(_,i)=>({sessionDateET:'2026-08-'+String(i+1).padStart(2,'0'),open:100,high:105,low:100,close:102,complete:true}))});return;}
    if(req.url.startsWith('/api/panel-data/rth-context')) {json(res,{schemaVersion:1,symbol,sessionDateET:'2026-09-18',status:'ready',open:602,low:599.38,high:605,last:599.38,completeFromRTHOpen:true});return;}
    if(req.url==='/api/forecast'){
      let text='';for await(const c of req)text+=c;
      assert.equal(req.headers['x-tape-forecast'],'1');assert.equal(req.headers.authorization,undefined);
      const sent=JSON.parse(text);assert.equal(sent.symbol,symbol);assert.deepEqual(Object.keys(sent),['symbol']);
      const body={state:responseState,message:responseState==='forecast'?'Fabricated UI test result':'Tape backend forecast endpoint is unavailable; retrying automatically',symbol,generation,origin_us:(start-2000)*1000,clock_us:start*1000};
      if(responseState==='forecast')body.result={...mockForecast(symbol,start-2000),mode};
      if(scenario==='partial') {
        body.result.input_bar_count=64;
        for(const h of Object.values(body.result.horizons)) {
          h.paths_price_valid=24;h.paths_price_unknown=8;
          for(const [key,yes] of [['close_above_reference',18],['close_below_reference',6],['close_equal_reference',0]]) Object.assign(h[key],{count_true:yes,count_false:24-yes,count_unknown:8,probability:null,identified_bounds:[yes/32,(yes+8)/32]});
        }
      }
      json(res,body);return;
    }
    if(req.url.startsWith('/api/rvol-history')){json(res,{symbol,through_us:(start-2000)*1000,bars:[]});return;}
    if(req.url.startsWith('/api/panel-data/')){json(res,{schemaVersion:1,status:'unavailable',bars:[],symbol});return;}
    if(req.url.startsWith('/api/')){json(res,{});return;}
    const path=resolve(root,(req.url==='/' || req.url.startsWith('/preview/'))?'index.html':'.'+new URL(req.url,'http://localhost').pathname);
    if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return;}
    const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[extname(path)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self'; worker-src 'self' blob:"});const bytes=await readFile(path);res.end(path.endsWith('index.html')?bytes.toString().replace('<title>Tape Reading Tool</title>','<title>Synthetic dashboard preview</title>'):bytes);
  }catch(e){res.writeHead(500);res.end(String(e));}
});
server.on('upgrade',(req,socket)=>{
 const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
 peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>peers.delete(socket));socket.write(frame(snapshot()));
});
await new Promise(r=>server.listen(18098,'127.0.0.1',r));
console.log('Synthetic dashboard: http://127.0.0.1:18098/preview/ready, /preview/wide, or /preview/partial');
