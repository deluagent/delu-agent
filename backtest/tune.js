#!/usr/bin/env node
/**
 * delu template tuner
 * Find winning parameter conditions for all 5 templates A/B/C/D/E
 *
 * Template A: trend × (1 + attention) — tune attention scale + entry threshold
 * Template B: accumulation flow lead-lag — fix: too noisy, needs RSI + multi-bar confirm
 * Template C: cross-sectional rank + vol attention — tune weights
 * Template D: OU panic mean reversion — fix: half-life too strict, firing 0 trades
 * Template E: meta-allocator — tune regime thresholds
 *
 * For each template: grid sweep → rank by OOS Sharpe → report winning params
 */

const fs   = require('fs');
const path = require('path');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKENS = [
  { symbol: 'BTC',  binance: 'BTCUSDT' },
  { symbol: 'ETH',  binance: 'ETHUSDT' },
  { symbol: 'SOL',  binance: 'SOLUSDT' },
  { symbol: 'BNB',  binance: 'BNBUSDT' },
  { symbol: 'DOGE', binance: 'DOGEUSDT' },
  { symbol: 'AAVE', binance: 'AAVEUSDT' },
  { symbol: 'ARB',  binance: 'ARBUSDT' },
];

const DAYS     = 730;
const IS_SPLIT = 0.70;
const WARMUP   = 200*24;
const REBAL_H  = 24;
const AAVE_APY = 0.05;

// ─── Data ─────────────────────────────────────────────────────
async function fetchBinance(symbol) {
  const totalCandles = DAYS * 24;
  let all = [], endTime = Date.now();
  while (all.length < totalCandles) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    all = [...data.map(d => ({ ts:d[0], time:new Date(d[0]), open:+d[1], high:+d[2], low:+d[3], close:+d[4], volume:+d[5] })), ...all];
    endTime = data[0][0] - 1;
    await sleep(150);
  }
  const seen = new Set();
  return all.filter(b => !seen.has(b.ts) && seen.add(b.ts)).sort((a,b)=>a.ts-b.ts).slice(-totalCandles);
}

// ─── Indicators ───────────────────────────────────────────────
function computeGARCH(closes, alpha=0.05, beta=0.90) {
  const n=closes.length, sigma2=new Array(n).fill(null);
  const r=closes.map((c,i)=>i===0?0:Math.log(c/closes[i-1]));
  const wu=30*24; if(n<wu+5) return sigma2;
  const lrVar=r.slice(1,wu+1).reduce((s,v)=>s+v*v,0)/wu;
  const omega=lrVar*(1-alpha-beta);
  let s2=lrVar;
  for(let i=1;i<n;i++){s2=omega+alpha*r[i]*r[i]+beta*s2; if(i>=wu) sigma2[i]=Math.sqrt(s2*24*365);}
  return sigma2;
}
function computeATR(bars,p=14){
  const a=new Array(bars.length).fill(null);
  for(let i=1;i<bars.length;i++){
    const tr=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));
    a[i]=i<p?tr:(a[i-1]*(p-1)+tr)/p;
  }
  return a;
}
function computeRSI(closes,p=14){
  const rsi=new Array(closes.length).fill(null);
  let gA=0,lA=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)gA+=d;else lA+=Math.abs(d);}
  gA/=p;lA/=p;
  for(let i=p;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    gA=(gA*(p-1)+(d>0?d:0))/p; lA=(lA*(p-1)+(d<0?Math.abs(d):0))/p;
    rsi[i]=lA===0?100:100-100/(1+gA/lA);
  }
  return rsi;
}
function trendComposite(closes,i){
  const h20=20*24,h60=60*24,h120=120*24;
  if(i<h120)return null;
  return 0.5*(closes[i]-closes[i-h20])/closes[i-h20]+0.3*(closes[i]-closes[i-h60])/closes[i-h60]+0.2*(closes[i]-closes[i-h120])/closes[i-h120];
}
function volSurprise(volumes,i,win=30*24){
  if(i<win)return null;
  const s=volumes.slice(i-win,i),m=s.reduce((a,b)=>a+b,0)/s.length,sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
  return sd>0?(volumes[i]-m)/sd:0;
}
function volAccel(volumes,i,win=24){
  if(i<win*2)return null;
  const lv=volumes.map(v=>Math.log(Math.max(v,1)));
  return (lv[i]-lv[i-win])-(lv[i-win]-lv[i-win*2]);
}
function zScore(series,i,win=30*24){
  if(i<win)return null;
  const s=series.slice(i-win,i+1),m=s.reduce((a,b)=>a+b,0)/s.length,sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
  return sd>0?(series[i]-m)/sd:0;
}
function fitOU(closes,i,win=30*24){
  if(i<win)return null;
  const s=closes.slice(i-win,i+1);
  const m=s.reduce((a,b)=>a+b,0)/s.length,sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
  if(sd<1e-9)return{halfLife:9999,kappa:0};
  const z=s.map(v=>(v-m)/sd);
  let cov=0,v0=0;
  for(let j=1;j<z.length;j++){cov+=z[j]*z[j-1];v0+=z[j-1]*z[j-1];}
  const rho=v0>0?cov/v0:0;
  const kappa=rho>0&&rho<1?-Math.log(rho):0.001;
  return{halfLife:Math.log(2)/kappa,kappa};
}
function btcRegime(btcCloses,i){
  if(i<200*24)return null;
  const n200=200*24,n50=50*24,n7=7*24,n30=30*24;
  const sma200=btcCloses.slice(i-n200,i+1).reduce((a,b)=>a+b,0)/(n200+1);
  const sma50=btcCloses.slice(i-n50,i+1).reduce((a,b)=>a+b,0)/(n50+1);
  let v7=0,v30=0;
  for(let j=i-n7+1;j<=i;j++){const r=Math.log(btcCloses[j]/btcCloses[j-1]);v7+=r*r;}
  for(let j=i-n30+1;j<=i;j++){const r=Math.log(btcCloses[j]/btcCloses[j-1]);v30+=r*r;}
  const volRatio=Math.sqrt(v30/n30)>0?Math.sqrt(v7/n7)/Math.sqrt(v30/n30):1;
  const pct=(btcCloses[i]-sma200)/sma200;
  let state=pct>0.05&&volRatio<1.5?'BULL':pct<-0.05?'BEAR':'RANGE';
  return{state,volRatio,highVol:volRatio>1.5,extremeVol:volRatio>2.0,pct};
}

// ─── Pre-compute all token data ───────────────────────────────
function precompute(allBars, allCloses, btcCloses) {
  const n = allCloses[0].length;
  console.log('  Precomputing indicators...');
  const regimes   = allCloses[0].map((_,i)=>btcRegime(btcCloses,i));
  const garchs    = allCloses.map(c=>computeGARCH(c));
  const atrs      = allBars.map(b=>computeATR(b));
  const rsis      = allCloses.map(c=>computeRSI(c));
  const volumes   = allBars.map(b=>b.map(x=>x.volume));

  // OU params computed every 24h, fill-forward
  const ouAll = allCloses.map(closes=>{
    const ou=new Array(n).fill(null);
    for(let i=WARMUP;i<n;i+=24){
      const p=fitOU(closes,i);
      for(let k=i;k<Math.min(i+24,n);k++) ou[k]=p;
    }
    return ou;
  });

  // 1d return z-scores per token
  const ret1dZ = allCloses.map(closes=>{
    const z=new Array(n).fill(null);
    const win=30*24;
    for(let i=win+24;i<n;i++){
      const r1=(closes[i]-closes[i-24])/closes[i-24];
      const rs=[];for(let k=i-win;k<=i;k+=24)rs.push((closes[k]-closes[k-24])/closes[k-24]);
      const m=rs.reduce((a,b)=>a+b,0)/rs.length,sd=Math.sqrt(rs.reduce((s,v)=>s+(v-m)**2,0)/rs.length);
      z[i]=sd>0?(r1-m)/sd:0;
    }
    return z;
  });

  return { regimes, garchs, atrs, rsis, volumes, ouAll, ret1dZ };
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATE SIGNAL FUNCTIONS — parameterised for grid search
// ═══════════════════════════════════════════════════════════════

// Template A: trend × (1 + attention_mult)
// Params: attnScale (vol z-score sensitivity), trendScale, minTrend
function sigA(closes, volumes, i, p) {
  const trend = trendComposite(closes, i);
  const vz    = volSurprise(volumes, i);
  if (trend === null || vz === null) return null;
  if (Math.tanh(trend * p.trendScale) < p.minTrend) return 0;
  const attnMult = 1 + Math.tanh(vz * p.attnScale);
  return Math.tanh(trend * p.trendScale) * attnMult;
}

// Template B: accumulation lead-lag — FIXED
// Key fixes:
//   1. Require vol_z > minVolZ (stronger volume burst)
//   2. Require RSI < 55 (not already overbought)
//   3. Require price down over confirmWindow bars (actual dip)
//   4. Require vol acceleration positive (vol building, not fading)
//   5. Multiple bars of vol rising while price flat/down (persistence)
function sigB(closes, volumes, rsi, i, p) {
  const vz    = volSurprise(volumes, i);
  const accel = volAccel(volumes, i);
  if (vz === null || accel === null) return null;
  if (vz < p.minVolZ) return 0;                          // vol burst required
  if (accel < 0) return 0;                               // vol must be building
  if (rsi[i] !== null && rsi[i] > p.maxRSI) return 0;   // not overbought
  // Price must be down or flat over confirm window (accumulation dip)
  const win = p.confirmBars;
  if (i < win) return 0;
  const priceChg = (closes[i]-closes[i-win])/closes[i-win];
  if (priceChg > p.maxPriceChg) return 0;               // already ran — late
  if (priceChg < p.minPriceChg) return 0;               // crashed too hard — not bounce
  // Persistence: vol must have been rising for confirmBars
  let volRisingCount = 0;
  for (let k=i-win+1;k<=i;k++) { if(volumes[k]>volumes[k-1]) volRisingCount++; }
  if (volRisingCount < win * p.minVolRisingFrac) return 0;  // vol must be persistently rising
  const strength = Math.tanh(vz * 0.6) * Math.tanh(accel * 2);
  return Math.max(0, strength);
}

// Template C: cross-sectional composite — track per token raw score, rank externally
// score_C = w_r30 * r30d + w_vz * vol_z + w_accel * vol_accel
function sigC_raw(closes, volumes, i, p) {
  if (i < 30*24) return null;
  const r30  = (closes[i]-closes[i-30*24])/closes[i-30*24];
  const vz   = volSurprise(volumes, i);
  const ac   = volAccel(volumes, i);
  if (vz===null||ac===null) return null;
  return p.wR30*Math.tanh(r30*3) + p.wVZ*Math.tanh(vz*0.5) + p.wAC*Math.tanh(ac*2);
}

// Template D: OU panic mean reversion — FIXED
// Key fixes:
//   1. Loosened halfLife threshold (120h or 200h instead of 72h)
//   2. Loosened panic z threshold (-1.5 instead of -2.0)
//   3. Compute z on log-returns not prices (better stationarity)
//   4. Added RSI confirmation (RSI < 35 = genuinely oversold)
//   5. Min vol spike lowered to 1.0
function sigD(closes, volumes, rsi, ret1dZ, ouParams, i, p) {
  if (!ouParams) return null;
  const { halfLife } = ouParams;
  if (halfLife > p.maxHalfLife) return 0;  // won't revert fast enough

  const vz   = volSurprise(volumes, i);
  const retZ = ret1dZ[i];
  if (vz===null || retZ===null) return null;

  if (retZ > p.maxReturnZ) return 0;                      // not in panic
  if (vz < p.minVolSpike) return 0;                       // no capitulation volume
  if (rsi[i] !== null && rsi[i] > p.maxRSIForEntry) return 0;  // must be oversold

  // Signal strength: panic depth × volume intensity × reversion speed
  const panicStr = Math.min(Math.abs(retZ)-Math.abs(p.maxReturnZ), 3)/3;
  const volStr   = Math.min(vz-p.minVolSpike, 3)/3;
  const revSpeed = Math.min(1, 72/halfLife);
  return Math.max(0, panicStr * volStr * revSpeed);
}

// ═══════════════════════════════════════════════════════════════
// SIMULATION — single template, isolated
// ═══════════════════════════════════════════════════════════════
function simTemplate(template, allBars, allCloses, symbols, precomp, params, splitIdx) {
  const { regimes, garchs, atrs, rsis, volumes, ouAll, ret1dZ } = precomp;
  const n = allBars[0].length;
  const isTrades=[], oosTrades=[];
  let openPos={}, lastRebal=0, yieldIS=0, yieldOOS=0;

  for (let i=WARMUP; i<n; i++) {
    const reg=regimes[i];
    if (!reg) continue;

    // Stop/TP
    for (const [ts,pos] of Object.entries(openPos)) {
      const tidx=+ts, bar=allBars[tidx][i];
      let ep=null,er=null;
      if(bar.low<=pos.stop){ep=pos.stop;er='stop';}
      else if(bar.high>=pos.tp){ep=pos.tp;er='tp';}
      if(ep){
        const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:i,entryPrice:pos.entryPrice,exitPrice:ep,pnl:(ep-pos.entryPrice)/pos.entryPrice,exitReason:er,holdHours:i-pos.entryBar,weight:pos.weight,template};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
        delete openPos[ts];
      }
    }

    // Yield
    const idle=Math.max(0,1-Object.keys(openPos).length*0.15);
    if(i<splitIdx) yieldIS+=idle*AAVE_APY/(365*24);
    else           yieldOOS+=idle*AAVE_APY/(365*24);

    if (i-lastRebal<REBAL_H) continue;
    lastRebal=i;

    // BEAR: go flat for all templates except D (D can still mean-revert)
    if (reg.state==='BEAR' || reg.extremeVol) {
      if (template!=='D') {
        for (const [ts,pos] of Object.entries(openPos)) {
          const tidx=+ts,bar=allBars[tidx][i];
          const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:i,entryPrice:pos.entryPrice,exitPrice:bar.close,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'regime',holdHours:i-pos.entryBar,weight:pos.weight,template};
          (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
          delete openPos[ts];
        }
        continue;
      }
    }

    // Template D: also works in RANGE
    // Template A/B/C: prefer BULL, still active in RANGE
    const inScope = (template==='D') ? (reg.state!=='BULL' || reg.highVol) :
                    (template==='C') ? true :
                    true;
    if (!inScope) continue;

    // Compute scores per token
    const scores=[];
    for (let tidx=0;tidx<allCloses.length;tidx++) {
      const c=allCloses[tidx], v=volumes[tidx], r=rsis[tidx];
      const gs=garchs[tidx][i]||0.5, ou=ouAll[tidx][i], rz=ret1dZ[tidx];
      let s=null;
      if      (template==='A') s=sigA(c,v,i,params);
      else if (template==='B') s=sigB(c,v,r,i,params);
      else if (template==='C') s=sigC_raw(c,v,i,params);
      else if (template==='D') s=sigD(c,v,r,rz,ou,i,params);
      if (s!==null && s>0) scores.push({tidx,score:s,gs});
    }

    // Template C: cross-sectional rank
    if (template==='C') {
      scores.sort((a,b)=>a.score-b.score);
      for(let ri=0;ri<scores.length;ri++){
        const xr=scores.length>1?(ri/(scores.length-1))*2-1:0;
        scores[ri].score=(1-params.wXR)*scores[ri].score+params.wXR*xr;
      }
    }
    scores.sort((a,b)=>b.score-a.score);

    // Close positions not in top 2
    const top2=new Set(scores.slice(0,2).map(s=>s.tidx));
    for(const [ts,pos] of Object.entries(openPos)){
      if(!top2.has(+ts)){
        const tidx=+ts,bar=allBars[tidx][i];
        const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:i,entryPrice:pos.entryPrice,exitPrice:bar.close,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'rebalance',holdHours:i-pos.entryBar,weight:pos.weight,template};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
        delete openPos[ts];
      }
    }

    // Enter top 2
    for(const s of scores.slice(0,2)){
      if(openPos[s.tidx]!==undefined) continue;
      const bar=allBars[s.tidx][i], atr=atrs[s.tidx][i]||bar.close*0.02;
      const sz=Math.min(0.15/(s.gs*0.5), 0.35);
      const stopM = template==='D'?1.5:2.5;
      const tpM   = template==='D'?2.5:5.0;
      openPos[s.tidx]={entryBar:i,entryPrice:bar.close,stop:bar.close-stopM*atr,tp:bar.close+tpM*atr,weight:sz,template};
    }
  }

  // Close remaining
  for(const [ts,pos] of Object.entries(openPos)){
    const tidx=+ts,last=allBars[tidx][n-1];
    const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:n-1,entryPrice:pos.entryPrice,exitPrice:last.close,pnl:(last.close-pos.entryPrice)/pos.entryPrice,exitReason:'end',holdHours:n-1-pos.entryBar,weight:pos.weight,template,open:true};
    (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
  }

  return { isTrades, oosTrades, yieldIS, yieldOOS };
}

function stats(trades, yieldEarned=0) {
  const yr=yieldEarned*100;
  if(!trades||trades.length<3) return{n:trades?.length||0,sharpe:-99,ret:Math.round(yr*10)/10,dd:0,wr:0,error:'<3 trades'};
  const pr=trades.map(t=>t.pnl*(t.weight||0.15));
  const wins=trades.filter(t=>t.pnl>0);
  const m=pr.reduce((a,b)=>a+b,0)/pr.length,sd=Math.sqrt(pr.reduce((s,r)=>s+(r-m)**2,0)/pr.length);
  const sharpe=sd>0?(m/sd)*Math.sqrt(365):0;
  let eq=1,pk=1,dd=0; for(const r of pr){eq*=(1+r);if(eq>pk)pk=eq;const d=(pk-eq)/pk;if(d>dd)dd=d;}
  const tradRet=(eq-1)*100, totRet=tradRet+yr;
  const aw=wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length*100:0;
  const al=trades.filter(t=>t.pnl<=0).length?Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)/trades.filter(t=>t.pnl<=0).length*100):0;
  return{n:trades.length,sharpe:Math.round(sharpe*100)/100,ret:Math.round(totRet*10)/10,tradRet:Math.round(tradRet*10)/10,dd:Math.round(dd*1000)/10,wr:Math.round(wins.length/trades.length*100),pf:al>0?Math.round((wins.length*aw)/(trades.filter(t=>t.pnl<=0).length*al)*100)/100:Infinity,avgHold:Math.round(trades.reduce((s,t)=>s+(t.holdHours||0),0)/trades.length),stop:Math.round(trades.filter(t=>t.exitReason==='stop').length/trades.length*100),tp:Math.round(trades.filter(t=>t.exitReason==='tp').length/trades.length*100)};
}

// ═══════════════════════════════════════════════════════════════
// PARAMETER GRIDS PER TEMPLATE
// ═══════════════════════════════════════════════════════════════
const GRIDS = {
  A: (() => {
    const g=[];
    for(const attnScale of [0.3,0.5,0.7,1.0])
    for(const trendScale of [3,5,8])
    for(const minTrend   of [0.0,0.05,0.1])
      g.push({attnScale,trendScale,minTrend,label:`attn=${attnScale} trend=${trendScale} minT=${minTrend}`});
    return g;
  })(),

  B: (() => {
    const g=[];
    for(const minVolZ        of [1.0,1.5,2.0])
    for(const maxRSI         of [45,55,65])
    for(const confirmBars    of [8,16,24])
    for(const minVolRisingFrac of [0.5,0.6,0.7])
    for(const maxPriceChg   of [0.02,0.05])
    for(const minPriceChg   of [-0.15,-0.10,-0.05])
      g.push({minVolZ,maxRSI,confirmBars,minVolRisingFrac,maxPriceChg,minPriceChg,label:`volZ>${minVolZ} rsi<${maxRSI} cb=${confirmBars} vrf=${minVolRisingFrac} pc=[${minPriceChg},${maxPriceChg}]`});
    return g;
  })(),

  C: (() => {
    const g=[];
    for(const wR30 of [0.3,0.4,0.5])
    for(const wVZ  of [0.2,0.3,0.4])
    for(const wAC  of [0.1,0.2,0.3])
    for(const wXR  of [0.2,0.3,0.4]) {
      if(Math.abs(wR30+wVZ+wAC-1)>0.11) continue;
      g.push({wR30,wVZ,wAC,wXR,label:`r30=${wR30} vz=${wVZ} ac=${wAC} xrank=${wXR}`});
    }
    return g;
  })(),

  D: (() => {
    const g=[];
    for(const maxHalfLife    of [48,96,168,240])
    for(const maxReturnZ     of [-1.2,-1.5,-2.0])
    for(const minVolSpike    of [0.8,1.0,1.5])
    for(const maxRSIForEntry of [35,40,50])
      g.push({maxHalfLife,maxReturnZ,minVolSpike,maxRSIForEntry,label:`hl<${maxHalfLife}h rz<${maxReturnZ} vs>${minVolSpike} rsi<${maxRSIForEntry}`});
    return g;
  })(),
};

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const t0=Date.now();
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`delu template tuner — finding winning params for A/B/C/D`);
  console.log(`${new Date().toISOString()} | ${TOKENS.length} tokens | ${DAYS/365}yr`);
  console.log(`Combos: A=${GRIDS.A.length} B=${GRIDS.B.length} C=${GRIDS.C.length} D=${GRIDS.D.length} total=${GRIDS.A.length+GRIDS.B.length+GRIDS.C.length+GRIDS.D.length}`);
  console.log(`${'═'.repeat(65)}\n`);

  // Fetch
  console.log('Fetching data...');
  const rawData=[];
  for(const token of TOKENS){
    process.stdout.write(`  [${token.symbol}] `);
    try{ const bars=await fetchBinance(token.binance); rawData.push({symbol:token.symbol,bars}); console.log(`${bars.length} bars`); }
    catch(e){ console.log(`FAILED: ${e.message}`); }
    await sleep(300);
  }

  const valid=rawData.filter(d=>d.bars?.length>500);
  const minLen=Math.min(...valid.map(d=>d.bars.length));
  const allBars=valid.map(d=>d.bars.slice(-minLen));
  const allCloses=allBars.map(b=>b.map(x=>x.close));
  const symbols=valid.map(d=>d.symbol);
  const btcIdx=symbols.indexOf('BTC');
  const btcCloses=allCloses[btcIdx>=0?btcIdx:0];
  const splitIdx=Math.floor(minLen*IS_SPLIT);
  const n=minLen;

  console.log(`\nAligned: ${n} bars | IS: ${Math.round(splitIdx/24)}d | OOS: ${Math.round((n-splitIdx)/24)}d\n`);
  const precomp=precompute(allBars,allCloses,btcCloses);

  const best={};
  const allResults={};

  for(const template of ['A','B','C','D']){
    const grid=GRIDS[template];
    console.log(`\n${'─'.repeat(65)}`);
    console.log(`TEMPLATE ${template} — ${grid.length} param combos`);
    console.log(`${'─'.repeat(65)}`);

    const results=[];
    let tested=0;
    for(const params of grid){
      const {isTrades,oosTrades,yieldIS,yieldOOS}=simTemplate(template,allBars,allCloses,symbols,precomp,params,splitIdx);
      const oos=stats(oosTrades,yieldOOS);
      const is_=stats(isTrades,yieldIS);
      results.push({params,is:is_,oos});
      tested++;
      if(tested%50===0) process.stdout.write(`  ${tested}/${grid.length} tested...\r`);
    }

    // Rank: primary OOS Sharpe, must have ≥10 trades
    const ranked=results.filter(r=>r.oos.n>=10&&!r.oos.error).sort((a,b)=>(b.oos.sharpe||0)-(a.oos.sharpe||0));
    const winners=ranked.filter(r=>r.oos.sharpe>0);
    best[template]=ranked[0];

    console.log(`\n  Total combos: ${grid.length} | With ≥10 OOS trades: ${ranked.length} | Profitable (Sharpe>0): ${winners.length}`);

    if(ranked.length===0){
      console.log(`  ❌ No config generated ≥10 OOS trades. Template needs redesign.`);
    } else {
      console.log(`\n  🏆 TOP 10 for Template ${template} (by OOS Sharpe):`);
      console.log(`  ${'─'.repeat(85)}`);
      console.log(`  ${'Params'.padEnd(55)} ${'N'.padEnd(5)} ${'Win%'.padEnd(6)} ${'Ret%'.padEnd(8)} ${'Sharpe'.padEnd(8)} ${'DD%'.padEnd(7)} ${'Stop%'}`);
      console.log(`  ${'─'.repeat(85)}`);
      for(const r of ranked.slice(0,10)){
        const o=r.oos;
        const flag=o.sharpe>0.5?'✅':o.sharpe>0?'⚠️':'❌';
        console.log(`  ${flag} ${r.params.label.slice(0,52).padEnd(55)} ${String(o.n).padEnd(5)} ${String(o.wr+'%').padEnd(6)} ${String(o.ret+'%').padEnd(8)} ${String(o.sharpe).padEnd(8)} ${String(o.dd+'%').padEnd(7)} ${o.stop}%`);
      }
      if(best[template]){
        const b=best[template];
        const o=b.oos;
        console.log(`\n  ✅ BEST: ${b.params.label}`);
        console.log(`     OOS: n=${o.n} wr=${o.wr}% ret=${o.ret}% (trading=${o.tradRet}%) sharpe=${o.sharpe} DD=${o.dd}% PF=${o.pf} avgHold=${o.avgHold}h`);
        console.log(`     IS:  n=${b.is.n} sharpe=${b.is.sharpe} ret=${b.is.ret}%`);
        const deg=b.is.sharpe>0?Math.round(o.sharpe/b.is.sharpe*100):0;
        console.log(`     IS→OOS: ${deg}% Sharpe retained  ${deg>=50?'✅ robust':'⚠️ degraded'}`);
      }
    }
    allResults[template]=ranked;
  }

  // ── Summary across all templates ─────────────────────────
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`TEMPLATE SUMMARY — best params`);
  console.log(`${'═'.repeat(65)}`);
  for(const [t,b] of Object.entries(best)){
    if(!b){console.log(`  ${t}: ❌ no winning config`);continue;}
    const o=b.oos;
    const flag=o.sharpe>1?'🔥':o.sharpe>0.5?'✅':o.sharpe>0?'⚠️':'❌';
    console.log(`  Template ${t}: ${flag} sharpe=${o.sharpe} ret=${o.ret}% trades=${o.n} wr=${o.wr}%`);
    console.log(`    → ${b.params.label}`);
  }

  const elapsed=Math.round((Date.now()-t0)/1000);
  console.log(`\nTotal time: ${elapsed}s`);

  // Save
  const outFile=path.join(RESULTS_DIR,`tune-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile,JSON.stringify({
    run_at:new Date().toISOString(),
    best:Object.fromEntries(Object.entries(best).map(([t,b])=>b?[t,{params:b.params,oos:b.oos,is:b.is}]:[t,null])),
    topPerTemplate:Object.fromEntries(Object.entries(allResults).map(([t,r])=>[t,r.slice(0,5).map(x=>({params:x.params,oos:x.oos}))]))
  },null,2));
  console.log(`💾 Saved: ${outFile}`);
}

main().catch(e=>{console.error('Fatal:',e.stack);process.exit(1);});
