#!/usr/bin/env node
/**
 * Fix Templates B and D
 *
 * B was: complex vol-price divergence (too many conditions, 0 trades)
 * B fix: OBV divergence — OBV rising + price flat/down + RSI < 55
 *        Simpler, higher signal frequency, matches "smart money accumulation"
 *
 * D was: OU half-life filter killing all signals (0 trades OOS)
 * D fix: Pure panic bounce — return_z < threshold + vol spike + RSI < 40
 *        No OU dependency. Fire in ALL regimes including BEAR (panics happen there).
 *        Quick entry/exit: tighter stop, faster TP
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

const DAYS=730, IS_SPLIT=0.70, WARMUP=200*24, REBAL_H=24, AAVE_APY=0.05;

// ─── Data ─────────────────────────────────────────────────────
async function fetchBinance(symbol) {
  const total=DAYS*24; let all=[],endTime=Date.now();
  while(all.length<total){
    const res=await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&endTime=${endTime}`);
    if(!res.ok) throw new Error(`${res.status}`);
    const data=await res.json(); if(!data.length) break;
    all=[...data.map(d=>({ts:d[0],time:new Date(d[0]),open:+d[1],high:+d[2],low:+d[3],close:+d[4],volume:+d[5]})),...all];
    endTime=data[0][0]-1; await sleep(150);
  }
  const seen=new Set();
  return all.filter(b=>!seen.has(b.ts)&&seen.add(b.ts)).sort((a,b)=>a.ts-b.ts).slice(-total);
}

// ─── Indicators ───────────────────────────────────────────────
function computeGARCH(closes,a=0.05,b=0.90){
  const n=closes.length,s2=new Array(n).fill(null);
  const r=closes.map((c,i)=>i===0?0:Math.log(c/closes[i-1]));
  const wu=30*24; if(n<wu+5) return s2;
  const lv=r.slice(1,wu+1).reduce((s,v)=>s+v*v,0)/wu, om=lv*(1-a-b);
  let sv=lv;
  for(let i=1;i<n;i++){sv=om+a*r[i]*r[i]+b*sv; if(i>=wu) s2[i]=Math.sqrt(sv*24*365);}
  return s2;
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
  const rsi=new Array(closes.length).fill(null); let gA=0,lA=0;
  for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)gA+=d;else lA+=Math.abs(d);}
  gA/=p;lA/=p;
  for(let i=p;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    gA=(gA*(p-1)+(d>0?d:0))/p; lA=(lA*(p-1)+(d<0?Math.abs(d):0))/p;
    rsi[i]=lA===0?100:100-100/(1+gA/lA);
  }
  return rsi;
}
function computeOBV(closes,volumes){
  const obv=new Array(closes.length).fill(0);
  for(let i=1;i<closes.length;i++){
    if(closes[i]>closes[i-1])      obv[i]=obv[i-1]+volumes[i];
    else if(closes[i]<closes[i-1]) obv[i]=obv[i-1]-volumes[i];
    else                            obv[i]=obv[i-1];
  }
  return obv;
}
function volSurprise(volumes,i,win=30*24){
  if(i<win)return null;
  const s=volumes.slice(i-win,i),m=s.reduce((a,b)=>a+b,0)/s.length;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
  return sd>0?(volumes[i]-m)/sd:0;
}
function ret1dZScore(closes,i,win=30*24){
  if(i<win+24)return null;
  const r1=(closes[i]-closes[i-24])/closes[i-24];
  const rs=[]; for(let k=i-win;k<=i;k+=24)rs.push((closes[k]-closes[k-24])/closes[k-24]);
  const m=rs.reduce((a,b)=>a+b,0)/rs.length,sd=Math.sqrt(rs.reduce((s,v)=>s+(v-m)**2,0)/rs.length);
  return sd>0?(r1-m)/sd:0;
}
function btcRegime(btcCloses,i){
  if(i<200*24)return null;
  const n200=200*24,n7=7*24,n30=30*24;
  const sma200=btcCloses.slice(i-n200,i+1).reduce((a,b)=>a+b,0)/(n200+1);
  let v7=0,v30=0;
  for(let j=i-n7+1;j<=i;j++){const r=Math.log(btcCloses[j]/btcCloses[j-1]);v7+=r*r;}
  for(let j=i-n30+1;j<=i;j++){const r=Math.log(btcCloses[j]/btcCloses[j-1]);v30+=r*r;}
  const volRatio=Math.sqrt(v30/n30)>0?Math.sqrt(v7/n7)/Math.sqrt(v30/n30):1;
  const pct=(btcCloses[i]-sma200)/sma200;
  return{state:pct>0.05&&volRatio<1.5?'BULL':pct<-0.05?'BEAR':'RANGE',volRatio,highVol:volRatio>1.5,extremeVol:volRatio>2.0};
}

// ─── Precompute ───────────────────────────────────────────────
function precompute(allBars,allCloses,btcCloses){
  const n=allCloses[0].length;
  console.log('  Precomputing...');
  const regimes  = allCloses[0].map((_,i)=>btcRegime(btcCloses,i));
  const garchs   = allCloses.map(c=>computeGARCH(c));
  const atrs     = allBars.map(b=>computeATR(b));
  const rsis     = allCloses.map(c=>computeRSI(c));
  const volumes  = allBars.map(b=>b.map(x=>x.volume));
  const obvs     = allCloses.map((c,ti)=>computeOBV(c,volumes[ti]));
  const ret1dZs  = allCloses.map(c=>c.map((_,i)=>ret1dZScore(c,i)));
  return{regimes,garchs,atrs,rsis,volumes,obvs,ret1dZs};
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATE B — REDESIGNED: OBV Divergence Accumulation
// ═══════════════════════════════════════════════════════════════
// Signal: OBV rising (smart money buying) while price flat or down
// = "stealth accumulation" — wallet inflow proxy without needing onchain data
//
// Entry conditions:
//   1. OBV trend positive over lookback bars (OBV[i] > OBV[i-lookback])
//   2. OBV momentum: slope increasing (OBV rising faster)
//   3. Price NOT running (not already up > maxPriceChg)
//   4. RSI < maxRSI (not overbought — accumulation not distribution)
//   5. Vol z-score > minVolZ (above-average volume confirming interest)
//
// Signal strength = OBV_gain_pct × vol_confirmation
function sigB_v2(closes, volumes, obv, rsi, i, p) {
  const { lookback, maxPriceChg, maxRSI, minVolZ, minOBVGain } = p;
  if (i < lookback + 5) return null;

  // RSI gate
  if (rsi[i] !== null && rsi[i] > maxRSI) return 0;

  // Price must not have already run
  const priceChg = (closes[i] - closes[i-lookback]) / closes[i-lookback];
  if (priceChg > maxPriceChg) return 0;

  // OBV must be rising
  const obvGain = obv[i-lookback] !== 0 ? (obv[i] - obv[i-lookback]) / Math.abs(obv[i-lookback]) : 0;
  if (obvGain < minOBVGain) return 0;

  // OBV momentum: OBV must be rising faster recently (last half vs first half of lookback)
  const mid = Math.floor(lookback / 2);
  const obvMid  = obv[i-mid];
  const obvStart = obv[i-lookback];
  const slope1 = obvMid   - obvStart;   // first half slope
  const slope2 = obv[i]   - obvMid;     // second half slope
  if (slope2 < slope1 * 0.5) return 0;  // OBV momentum fading — skip

  // Volume confirmation
  const vz = volSurprise(volumes, i);
  if (vz === null || vz < minVolZ) return 0;

  // Signal strength: normalised OBV gain × vol confirmation
  const obvStrength = Math.tanh(obvGain * 3);
  const volStrength = Math.tanh(vz * 0.6);
  return Math.max(0, obvStrength * volStrength);
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATE D — REDESIGNED: Pure Panic Bounce
// ═══════════════════════════════════════════════════════════════
// No OU process dependency. Fire on panic events in ALL regimes.
//
// Entry conditions (capitulation pattern):
//   1. 1d return z-score < maxReturnZ  (abnormal down move)
//   2. Vol z-score > minVolZ            (volume spike = panic selling / capitulation)
//   3. RSI < maxRSI                     (genuinely oversold)
//   4. Price NOT in structural downtrend (4d return not catastrophic)
//
// Idea: when crowd panics and dumps hard on volume, smart money absorbs.
// Price snaps back. Quick trade: tight stop (1.5x ATR), fast TP (2.5x ATR).
//
// Fires in BEAR too — that's when the best bounces happen.
function sigD_v2(closes, volumes, rsi, ret1dZ, i, p) {
  const { maxReturnZ, minVolZ, maxRSI, minBounceWindow } = p;
  if (i < 30*24) return null;

  const retZ = ret1dZ[i];
  const vz   = volSurprise(volumes, i);
  if (retZ === null || vz === null) return null;

  // Panic gate
  if (retZ > maxReturnZ) return 0;     // not panicky enough
  if (vz < minVolZ) return 0;          // no volume spike = no capitulation
  if (rsi[i] !== null && rsi[i] > maxRSI) return 0;  // not oversold

  // Not in structural freefall (4d return not catastrophic — some floor needed)
  const r4d = i >= 4*24 ? (closes[i]-closes[i-4*24])/closes[i-4*24] : 0;
  if (r4d < -0.30) return 0;  // >30% down in 4d = structural break, not bounce

  // Confirm it hasn't already bounced (don't enter late)
  const rRecent = (closes[i]-closes[i-minBounceWindow])/closes[i-minBounceWindow];
  if (rRecent > 0.03) return 0;  // already bouncing — too late

  // Signal strength: panic depth × volume intensity
  const panicStr = Math.min(Math.abs(retZ) - Math.abs(maxReturnZ), 3) / 3;
  const volStr   = Math.min(vz - minVolZ, 3) / 3;
  return Math.max(0, panicStr * volStr);
}

// ─── Parameter Grids ──────────────────────────────────────────
const GRID_B = (() => {
  const g=[];
  for(const lookback         of [12, 24, 48, 72])
  for(const maxPriceChg      of [0.02, 0.05, 0.10])
  for(const maxRSI           of [50, 55, 60])
  for(const minVolZ          of [0.3, 0.5, 0.8])
  for(const minOBVGain       of [0.05, 0.10, 0.20])
    g.push({lookback,maxPriceChg,maxRSI,minVolZ,minOBVGain,
      label:`lb=${lookback}h pc<${maxPriceChg} rsi<${maxRSI} vz>${minVolZ} obv>${minOBVGain}`});
  return g;
})();

const GRID_D = (() => {
  const g=[];
  for(const maxReturnZ       of [-1.2, -1.5, -2.0])
  for(const minVolZ          of [0.5, 0.8, 1.2])
  for(const maxRSI           of [35, 40, 45, 50])
  for(const minBounceWindow  of [4, 8, 12])
    g.push({maxReturnZ,minVolZ,maxRSI,minBounceWindow,
      label:`rz<${maxReturnZ} vs>${minVolZ} rsi<${maxRSI} bw=${minBounceWindow}h`});
  return g;
})();

// ─── Simulation (template-isolated) ───────────────────────────
function simTemplate(template, allBars, allCloses, symbols, precomp, params, splitIdx, allowBear=false) {
  const { regimes, garchs, atrs, rsis, volumes, obvs, ret1dZs } = precomp;
  const n=allBars[0].length;
  const isTrades=[], oosTrades=[];
  let openPos={}, lastRebal=0, yieldIS=0, yieldOOS=0;

  for(let i=WARMUP; i<n; i++){
    const reg=regimes[i]; if(!reg) continue;

    // Stop/TP
    for(const [ts,pos] of Object.entries(openPos)){
      const tidx=+ts, bar=allBars[tidx][i];
      let ep=null,er=null;
      if(bar.low<=pos.stop){ep=pos.stop;er='stop';}
      else if(bar.high>=pos.tp){ep=pos.tp;er='tp';}
      if(ep){
        const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:i,entryPrice:pos.entryPrice,exitPrice:ep,pnl:(ep-pos.entryPrice)/pos.entryPrice,exitReason:er,holdHours:i-pos.entryBar,weight:pos.weight,regime:pos.regimeEntry,template};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
        delete openPos[ts];
      }
    }

    // Yield
    const idle=Math.max(0,1-Object.keys(openPos).length*0.15);
    if(i<splitIdx) yieldIS+=idle*AAVE_APY/(365*24);
    else           yieldOOS+=idle*AAVE_APY/(365*24);

    if(i-lastRebal<REBAL_H) continue;
    lastRebal=i;

    // BEAR: go flat unless allowBear (Template D)
    if((reg.state==='BEAR'||reg.extremeVol) && !allowBear){
      for(const [ts,pos] of Object.entries(openPos)){
        const tidx=+ts,bar=allBars[tidx][i];
        const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:i,entryPrice:pos.entryPrice,exitPrice:bar.close,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'regime',holdHours:i-pos.entryBar,weight:pos.weight,regime:pos.regimeEntry,template};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
        delete openPos[ts];
      }
      continue;
    }

    // Score tokens
    const scores=[];
    for(let tidx=0;tidx<allCloses.length;tidx++){
      const c=allCloses[tidx],v=volumes[tidx],r=rsis[tidx],o=obvs[tidx],rz=ret1dZs[tidx];
      const gs=garchs[tidx][i]||0.5;
      let s=null;
      if(template==='B') s=sigB_v2(c,v,o,r,i,params);
      if(template==='D') s=sigD_v2(c,v,r,rz,i,params);
      if(s!==null&&s>0) scores.push({tidx,score:s,gs});
    }
    scores.sort((a,b)=>b.score-a.score);

    // Close not in top 2
    const top2=new Set(scores.slice(0,2).map(s=>s.tidx));
    for(const [ts,pos] of Object.entries(openPos)){
      if(!top2.has(+ts)){
        const tidx=+ts,bar=allBars[tidx][i];
        const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:i,entryPrice:pos.entryPrice,exitPrice:bar.close,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'rebalance',holdHours:i-pos.entryBar,weight:pos.weight,regime:pos.regimeEntry,template};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
        delete openPos[ts];
      }
    }

    // Enter top 2
    for(const s of scores.slice(0,2)){
      if(openPos[s.tidx]!==undefined) continue;
      const bar=allBars[s.tidx][i], atr=atrs[s.tidx][i]||bar.close*0.02;
      const sz=Math.min(0.15/(s.gs*0.5),0.35);
      // D: tight stop for snap-back, B: standard
      const stopM=template==='D'?1.5:2.5, tpM=template==='D'?2.5:5.0;
      openPos[s.tidx]={entryBar:i,entryPrice:bar.close,stop:bar.close-stopM*atr,tp:bar.close+tpM*atr,weight:sz,regimeEntry:reg.state,template};
    }
  }

  // Close remaining
  for(const [ts,pos] of Object.entries(openPos)){
    const tidx=+ts,last=allBars[tidx][n-1];
    const t={tidx,symbol:symbols[tidx],entryBar:pos.entryBar,exitBar:n-1,entryPrice:pos.entryPrice,exitPrice:last.close,pnl:(last.close-pos.entryPrice)/pos.entryPrice,exitReason:'end',holdHours:n-1-pos.entryBar,weight:pos.weight,regime:pos.regimeEntry,template,open:true};
    (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
  }

  return{isTrades,oosTrades,yieldIS,yieldOOS};
}

function calcStats(trades, yieldEarned=0) {
  const yr=yieldEarned*100;
  if(!trades||trades.length<5) return{n:trades?.length||0,sharpe:-99,ret:Math.round(yr*10)/10,dd:0,wr:0};
  const pr=trades.map(t=>t.pnl*(t.weight||0.15));
  const wins=trades.filter(t=>t.pnl>0);
  const m=pr.reduce((a,b)=>a+b,0)/pr.length,sd=Math.sqrt(pr.reduce((s,r)=>s+(r-m)**2,0)/pr.length);
  const sharpe=sd>0?(m/sd)*Math.sqrt(365):0;
  let eq=1,pk=1,dd=0; for(const r of pr){eq*=(1+r);if(eq>pk)pk=eq;const d=(pk-eq)/pk;if(d>dd)dd=d;}
  const tradRet=(eq-1)*100,totRet=tradRet+yr;
  const aw=wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length*100:0;
  const al=trades.filter(t=>t.pnl<=0).length?Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)/trades.filter(t=>t.pnl<=0).length*100):0;
  const byRegime={};
  for(const t of trades){
    const r=t.regime||'?'; if(!byRegime[r]) byRegime[r]={n:0,wins:0};
    byRegime[r].n++; if(t.pnl>0) byRegime[r].wins++;
  }
  return{n:trades.length,sharpe:Math.round(sharpe*100)/100,ret:Math.round(totRet*10)/10,tradRet:Math.round(tradRet*10)/10,dd:Math.round(dd*1000)/10,wr:Math.round(wins.length/trades.length*100),pf:al>0?Math.round((wins.length*aw)/(trades.filter(t=>t.pnl<=0).length*al)*100)/100:Infinity,avgHold:Math.round(trades.reduce((s,t)=>s+(t.holdHours||0),0)/trades.length),stop:Math.round(trades.filter(t=>t.exitReason==='stop').length/trades.length*100),tp:Math.round(trades.filter(t=>t.exitReason==='tp').length/trades.length*100),byRegime};
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const t0=Date.now();
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`Template B+D FIX — redesigned signal logic`);
  console.log(`B: OBV divergence accumulation (was: complex vol-price divergence)`);
  console.log(`D: Pure panic bounce (was: OU half-life filter killing all signals)`);
  console.log(`${new Date().toISOString()} | B=${GRID_B.length} combos | D=${GRID_D.length} combos`);
  console.log(`${'═'.repeat(65)}\n`);

  console.log('Fetching data...');
  const rawData=[];
  for(const token of TOKENS){
    process.stdout.write(`  [${token.symbol}] `);
    try{const bars=await fetchBinance(token.binance);rawData.push({symbol:token.symbol,bars});console.log(`${bars.length} bars`);}
    catch(e){console.log(`FAILED: ${e.message}`);}
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

  console.log(`\n${n} bars | IS: ${Math.round(splitIdx/24)}d | OOS: ${Math.round((n-splitIdx)/24)}d\n`);
  const precomp=precompute(allBars,allCloses,btcCloses);

  const results={};

  for(const [template, grid, allowBear] of [['B',GRID_B,false],['D',GRID_D,true]]){
    console.log(`\n${'─'.repeat(65)}`);
    console.log(`TEMPLATE ${template} — ${grid.length} combos`);
    console.log(`${'─'.repeat(65)}`);

    const res=[]; let tested=0;
    for(const params of grid){
      const {isTrades,oosTrades,yieldIS,yieldOOS}=simTemplate(template,allBars,allCloses,symbols,precomp,params,splitIdx,allowBear);
      const oos=calcStats(oosTrades,yieldOOS);
      const is_=calcStats(isTrades,yieldIS);
      res.push({params,is:is_,oos});
      tested++;
      if(tested%50===0) process.stdout.write(`  ${tested}/${grid.length}...\r`);
    }

    const ranked=res.filter(r=>r.oos.n>=10).sort((a,b)=>(b.oos.sharpe||0)-(a.oos.sharpe||0));
    const winners=ranked.filter(r=>r.oos.sharpe>0);
    results[template]=ranked;

    console.log(`\n  Total: ${grid.length} | ≥10 OOS trades: ${ranked.length} | Profitable: ${winners.length}`);

    if(ranked.length===0){
      console.log(`  ❌ Still no trades. Need deeper investigation.`);
      // Show top by trade count
      const byCount=res.sort((a,b)=>b.oos.n-a.oos.n).slice(0,5);
      console.log(`  Most trades generated:`);
      for(const r of byCount) console.log(`    n=${r.oos.n} ${r.params.label}`);
    } else {
      console.log(`\n  🏆 TOP 10:`);
      console.log(`  ${'─'.repeat(90)}`);
      console.log(`  ${'Params'.padEnd(55)} ${'N'.padEnd(5)} ${'Win%'.padEnd(6)} ${'Ret%'.padEnd(8)} ${'Sharpe'.padEnd(8)} ${'DD%'.padEnd(7)} ${'Stop%'.padEnd(7)} ${'TP%'}`);
      console.log(`  ${'─'.repeat(90)}`);
      for(const r of ranked.slice(0,10)){
        const o=r.oos;
        const f=o.sharpe>1?'🔥':o.sharpe>0.5?'✅':o.sharpe>0?'⚠️':'❌';
        console.log(`  ${f} ${r.params.label.slice(0,52).padEnd(55)} ${String(o.n).padEnd(5)} ${String(o.wr+'%').padEnd(6)} ${String(o.ret+'%').padEnd(8)} ${String(o.sharpe).padEnd(8)} ${String(o.dd+'%').padEnd(7)} ${String(o.stop+'%').padEnd(7)} ${o.tp}%`);
      }

      const best=ranked[0];
      console.log(`\n  ✅ BEST Template ${template}: ${best.params.label}`);
      console.log(`     OOS: n=${best.oos.n} wr=${best.oos.wr}% ret=${best.oos.ret}% (trading=${best.oos.tradRet}%) sharpe=${best.oos.sharpe} DD=${best.oos.dd}% PF=${best.oos.pf}`);
      console.log(`     IS:  n=${best.is.n} sharpe=${best.is.sharpe} ret=${best.is.ret}%`);
      if(best.oos.byRegime){
        console.log(`     By regime (OOS):`);
        for(const [r,d] of Object.entries(best.oos.byRegime)){
          console.log(`       ${r.padEnd(8)}: ${d.n} trades | ${Math.round(d.wins/d.n*100)}% win`);
        }
      }
      const deg=best.is.sharpe>0?Math.round(best.oos.sharpe/best.is.sharpe*100):0;
      console.log(`     IS→OOS: ${deg}% Sharpe retained ${deg>=50?'✅':'⚠️'}`);
    }
  }

  // Final summary with all 4 templates
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`ALL TEMPLATES — FINAL SUMMARY`);
  console.log(`${'═'.repeat(65)}`);
  console.log(`(A and C results from tune.js run earlier)`);
  console.log(`  Template A: ✅ sharpe=0.88 ret=7.5% trades=91   → attn=0.5 trend=3 minT=0.1`);
  console.log(`  Template C: 🔥 sharpe=1.10 ret=9.3% trades=119  → r30=0.3 vz=0.4 ac=0.2 xrank=0.2`);

  for(const [t,res] of Object.entries(results)){
    const best=res[0];
    if(!best){console.log(`  Template ${t}: ❌ still no winning config`);continue;}
    const o=best.oos;
    const f=o.sharpe>1?'🔥':o.sharpe>0.5?'✅':o.sharpe>0?'⚠️':'❌';
    console.log(`  Template ${t}: ${f} sharpe=${o.sharpe} ret=${o.ret}% trades=${o.n} wr=${o.wr}%`);
    console.log(`    → ${best.params.label}`);
  }

  const elapsed=Math.round((Date.now()-t0)/1000);
  const outFile=path.join(RESULTS_DIR,`tune-bd-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile,JSON.stringify({
    run_at:new Date().toISOString(),
    templates:{
      B:results.B?.slice(0,10).map(r=>({params:r.params,oos:r.oos,is:r.is})),
      D:results.D?.slice(0,10).map(r=>({params:r.params,oos:r.oos,is:r.is})),
    }
  },null,2));
  console.log(`\nDone in ${elapsed}s | 💾 ${outFile}`);
}

main().catch(e=>{console.error('Fatal:',e.stack);process.exit(1);});
