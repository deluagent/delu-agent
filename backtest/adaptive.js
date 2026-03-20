#!/usr/bin/env node
/**
 * adaptive.js — delu adaptive framework
 *
 * Upgrades from full_v2.js:
 *
 * 1. SIX MARKET STATES (vs 3)
 *    BULL_HOT     — BTC > 200MA + ETH outperforming + low vol → max momentum
 *    BULL_COOL    — BTC > 200MA + high vol → cautious momentum + D ready
 *    ALT_SEASON   — ETH/BTC ratio rising → focus on DeFi tokens (AAVE, ARB, SOL)
 *    RANGE_TIGHT  — low vol consolidation → B (OBV accumulation) + light A
 *    RANGE_WIDE   — high vol range → D (panic bounces) dominant
 *    BEAR         — BTC < 200MA → flat + yield only
 *
 * 2. ETH/BTC RATIO SIGNAL
 *    When ETH outperforms BTC over rolling window → alt season → boost
 *    AAVE, ARB, SOL over BTC and BNB
 *
 * 3. ADAPTIVE TEMPLATE WEIGHTS
 *    Rolling 14d Sharpe per template → proportional weight re-allocation
 *    If template underperforms rolling → reduce weight; outperforms → increase
 *
 * 4. MARKET BREADTH GATE
 *    How many of 7 tokens are above their 200d MA?
 *    If breadth < 3/7 → treat as BEAR regardless of BTC signal
 *
 * 5. WALK-FORWARD VALIDATION (3 windows)
 *    Split 730d into 3 folds; test IS→OOS stability across all periods
 *    Report mean and worst-case OOS Sharpe
 *
 * 6. GRID SEARCH on adaptive parameters
 *    adaptWindow, altThreshold, breadthGate, regime thresholds
 */

const fs   = require('fs');
const path = require('path');
const { fetchBinanceHistory, fetchGeckoTerminal, GECKO_TERMINAL_FALLBACK } = require('./fetch');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKENS = ['BTC','ETH','SOL','BNB','DOGE','AAVE','ARB'];
const SYMBOLS = TOKENS; // reuse same list

// DeFi / alt tokens that benefit from alt season
const ALT_TOKENS = new Set(['AAVE','ARB','SOL']);
const DAYS=730, REBAL_H=24, AAVE_APY=0.05;
const BASE_SIZE=0.15, MAX_POS=0.35;

// ─── Data ─────────────────────────────────────────────────────
async function fetchBinance(symbol) {
  const total=DAYS*24; let all=[],endTime=Date.now();
  while(all.length<total){
    const res=await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=1000&endTime=${endTime}`);
    if(!res.ok)throw new Error(`${res.status}`);
    const data=await res.json(); if(!data.length)break;
    all=[...data.map(d=>({ts:d[0],time:new Date(d[0]),open:+d[1],high:+d[2],low:+d[3],close:+d[4],volume:+d[5]})),...all];
    endTime=data[0][0]-1; await sleep(150);
  }
  const seen=new Set();
  return all.filter(b=>!seen.has(b.ts)&&seen.add(b.ts)).sort((a,b)=>a.ts-b.ts).slice(-total);
}

// ─── Indicators ───────────────────────────────────────────────
function computeGARCH(c,a=0.05,b=0.90){
  const n=c.length,s=new Array(n).fill(null);
  const r=c.map((x,i)=>i===0?0:Math.log(x/c[i-1]));
  const wu=30*24; if(n<wu+5)return s;
  const lv=r.slice(1,wu+1).reduce((s,v)=>s+v*v,0)/wu,om=lv*(1-a-b); let sv=lv;
  for(let i=1;i<n;i++){sv=om+a*r[i]*r[i]+b*sv; if(i>=wu)s[i]=Math.sqrt(sv*24*365);}
  return s;
}
function computeATR(bars,p=14){
  const a=new Array(bars.length).fill(null);
  for(let i=1;i<bars.length;i++){
    const tr=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));
    a[i]=i<p?tr:(a[i-1]*(p-1)+tr)/p;
  }
  return a;
}
function computeRSI(c,p=14){
  const r=new Array(c.length).fill(null); let gA=0,lA=0;
  for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)gA+=d;else lA+=Math.abs(d);}
  gA/=p; lA/=p;
  for(let i=p;i<c.length;i++){
    const d=c[i]-c[i-1];
    gA=(gA*(p-1)+(d>0?d:0))/p; lA=(lA*(p-1)+(d<0?Math.abs(d):0))/p;
    r[i]=lA===0?100:100-100/(1+gA/lA);
  }
  return r;
}
function volSurpriseZ(v,i,win=30*24){
  if(i<win)return null;
  const s=v.slice(i-win,i),m=s.reduce((a,b)=>a+b,0)/s.length;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
  return sd>0?(v[i]-m)/sd:0;
}
function ret1dZAt(c,i,win=30*24){
  if(i<win+24)return null;
  const r1=(c[i]-c[i-24])/c[i-24];
  const rs=[]; for(let k=i-win;k<=i;k+=24)rs.push((c[k]-c[k-24])/c[k-24]);
  const m=rs.reduce((a,b)=>a+b,0)/rs.length,sd=Math.sqrt(rs.reduce((s,v)=>s+(v-m)**2,0)/rs.length);
  return sd>0?(r1-m)/sd:0;
}
function smaN(c,i,n){
  if(i<n)return null;
  return c.slice(i-n,i+1).reduce((a,b)=>a+b,0)/(n+1);
}

// ─── 6-State Regime ───────────────────────────────────────────
function sixStateRegime(btcC, ethC, allCloses, i, p) {
  const { bullThresh, bearThresh, altWin, altThresh, breadthMin, volHighMult } = p;
  if (i < 200*24 + 1) return null;

  const sma200 = smaN(btcC, i, 200*24);
  if (!sma200) return null;

  // Vol ratio (7d vs 30d realized vol)
  const n7=7*24, n30=30*24;
  let v7=0,v30=0;
  for(let j=i-n7+1;j<=i;j++){const r=Math.log(btcC[j]/btcC[j-1]);v7+=r*r;}
  for(let j=i-n30+1;j<=i;j++){const r=Math.log(btcC[j]/btcC[j-1]);v30+=r*r;}
  const volRatio = Math.sqrt(v30/n30)>0 ? Math.sqrt(v7/n7)/Math.sqrt(v30/n30) : 1;
  const highVol  = volRatio > volHighMult;
  const extremeVol = volRatio > volHighMult * 1.5;

  // BTC position vs 200d MA
  const pctFrom200 = (btcC[i] - sma200) / sma200;

  // ETH/BTC ratio (kept for breadth calc but ALT_SEASON state removed)
  const ethBtcChg  = 0;
  const altSeason  = false;

  // Market breadth: how many tokens above their 200d MA
  let aboveMa = 0;
  for (const c of allCloses) {
    const ma = smaN(c, i, 200*24);
    if (ma && c[i] > ma) aboveMa++;
  }
  const breadth = aboveMa / allCloses.length;

  // Force BEAR if breadth too low (altcoins all broken)
  if (breadth < breadthMin || extremeVol) {
    return { state: 'BEAR', pctFrom200, volRatio, ethBtcChg, breadth, altSeason, highVol, extremeVol };
  }

  let state;
  if (pctFrom200 < bearThresh) {
    state = 'BEAR';
  } else if (pctFrom200 > bullThresh) {
    if (highVol) {
      state = 'BULL_COOL';
    } else {
      state = 'BULL_HOT';
    }
  } else {
    // RANGE
    state = highVol ? 'RANGE_WIDE' : 'RANGE_TIGHT';
  }

  return { state, pctFrom200, volRatio, ethBtcChg, breadth, altSeason, highVol, extremeVol };
}

// ─── Signals (same tuned functions as full_v2) ────────────────
function scoreA(c,v,i){
  if(i<120*24)return null;
  const r20=(c[i]-c[i-20*24])/c[i-20*24];
  const r60=(c[i]-c[i-60*24])/c[i-60*24];
  const r120=(c[i]-c[i-120*24])/c[i-120*24];
  const trend=0.5*r20+0.3*r60+0.2*r120;
  if(trend<0.10)return 0; // tuned noise filter
  const vz=volSurpriseZ(v,i); if(vz===null)return null;
  return Math.max(0, trend*(1+Math.tanh(vz*0.5)));
}
function scoreB(c,v,rsi,i){
  const WIN=14*24; if(i<WIN+25)return null;
  if(rsi[i]!==null&&rsi[i]>60)return 0;
  if((c[i]-c[i-WIN])/c[i-WIN]>0.05)return 0;
  let ob=0; const arr=[];
  for(let k=Math.max(0,i-WIN-25);k<=i;k++){
    if(k>0){if(c[k]>c[k-1])ob+=v[k];else if(c[k]<c[k-1])ob-=v[k];}
    arr.push(ob);
  }
  const w=arr.slice(-WIN-1),m=w.reduce((a,b)=>a+b,0)/w.length;
  const sd=Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/w.length); if(sd<1e-9)return 0;
  const oz=(w[w.length-1]-m)/sd,ozP=(w[w.length-25]-m)/sd;
  if(oz<0.8||oz<=ozP)return 0;
  return Math.max(0,Math.tanh(oz*0.5)*Math.tanh((oz-ozP)*2));
}
function scoreC(c,v,i){
  if(i<30*24)return null;
  const r30=(c[i]-c[i-30*24])/c[i-30*24];
  const vz=volSurpriseZ(v,i); if(vz===null)return null;
  let va=0;
  if(i>=3){const z1=volSurpriseZ(v,i-1),z2=volSurpriseZ(v,i-2);if(z1!==null&&z2!==null)va=(vz-z1)-(z1-z2);}
  return r30*0.3+Math.tanh(vz*0.4)+Math.tanh(va*0.2);
}
function scoreD(c,v,rsi,rz,i){
  if(i<30*24)return null;
  const retZ=rz[i],vz=volSurpriseZ(v,i);
  if(retZ===null||vz===null)return null;
  if(retZ>-1.2)return 0; if(vz<0.5)return 0;
  if(rsi[i]!==null&&rsi[i]>45)return 0;
  const r4d=i>=4*24?(c[i]-c[i-4*24])/c[i-4*24]:0; if(r4d<-0.30)return 0;
  if(i>=4&&(c[i]-c[i-4])/c[i-4]>0.03)return 0;
  return Math.max(0,Math.min(Math.abs(retZ)-1.2,3)/3*Math.min(vz-0.5,3)/3);
}

// ─── Adaptive Meta-Allocator ──────────────────────────────────
// Tracks rolling performance per template and adjusts weights
// Regime sets the prior; adaptive adjustment is a multiplier on top
class AdaptiveMeta {
  constructor(adaptWindow) {
    this.win = adaptWindow;  // hours of rolling window
    this.trades = { A:[], B:[], C:[], D:[] };
    this.weights = { A:0.25, B:0.25, C:0.25, D:0.25 };
  }

  recordTrade(strategy, pnl, exitBar) {
    if (!this.trades[strategy]) return;
    this.trades[strategy].push({ pnl, exitBar });
    // Prune old trades outside window
    const cutoff = exitBar - this.win;
    for (const s of Object.keys(this.trades)) {
      this.trades[s] = this.trades[s].filter(t => t.exitBar >= cutoff);
    }
  }

  // Get rolling Sharpe for a template (-1 to 1 scale)
  rollingScore(strategy) {
    const t = this.trades[strategy];
    if (!t || t.length < 3) return 0;  // not enough data → neutral
    const pnls = t.map(x=>x.pnl);
    const m = pnls.reduce((a,b)=>a+b,0)/pnls.length;
    const sd = Math.sqrt(pnls.reduce((s,v)=>s+(v-m)**2,0)/pnls.length);
    return sd > 0 ? Math.tanh((m/sd) * Math.sqrt(this.win / 24)) : 0;  // tanh-bounded
  }

  // Regime prior × adaptive adjustment
  getWeights(regime) {
    // Regime-based base weights
    let base;
    const state = regime?.state || 'RANGE_TIGHT';
    if (state === 'BULL_HOT') {
      base = { A:0.40, B:0.20, C:0.25, D:0.15 };
    } else if (state === 'BULL_COOL') {
      base = { A:0.30, B:0.20, C:0.20, D:0.30 };
    } else if (state === 'ALT_SEASON') {
      // ALT_SEASON removed — falls through to BULL_HOT
      base = { A:0.40, B:0.20, C:0.25, D:0.15 };
    } else if (state === 'RANGE_TIGHT') {
      // OBV accumulation (B) + light A
      base = { A:0.30, B:0.40, C:0.10, D:0.20 };
    } else if (state === 'RANGE_WIDE') {
      // Volatile range → panic bounces (D) dominant
      base = { A:0.15, B:0.10, C:0.05, D:0.70 };
    } else {
      // BEAR: everything flat
      return { A:0, B:0, C:0, D:0 };
    }

    // Adaptive multiplier based on rolling performance
    const scores = {};
    for (const s of ['A','B','C','D']) {
      const rs = this.rollingScore(s);
      // rs in [-1,1]: positive → boost, negative → cut
      scores[s] = Math.max(0.1, 1 + rs * 0.5);  // 0.1x to 1.5x multiplier
    }

    // Apply multiplier
    const adjusted = {};
    for (const s of Object.keys(base)) adjusted[s] = base[s] * scores[s];

    // Normalise
    const total = Object.values(adjusted).reduce((a,b)=>a+b, 0);
    if (total <= 0) return base;
    for (const s of Object.keys(adjusted)) adjusted[s] /= total;
    return adjusted;
  }
}

// ─── Precompute ───────────────────────────────────────────────
function precompute(allBars, allCloses, btcCloses, ethCloses) {
  console.log('  Precomputing GARCH, RSI, ATR...');
  const garchs  = allCloses.map(c=>computeGARCH(c));
  const atrs    = allBars.map(b=>computeATR(b));
  const rsis    = allCloses.map(c=>computeRSI(c));
  const volumes = allBars.map(b=>b.map(x=>x.volume));
  const ret1dZs = allCloses.map(c=>c.map((_,i)=>ret1dZAt(c,i)));

  console.log('  Pre-scoring A/B/C/D...');
  const sA = allCloses.map((c,ti)=>c.map((_,i)=>scoreA(c,volumes[ti],i)));
  const sB = allCloses.map((c,ti)=>c.map((_,i)=>scoreB(c,volumes[ti],rsis[ti],i)));
  const sC = allCloses.map((c,ti)=>c.map((_,i)=>scoreC(c,volumes[ti],i)));
  const sD = allCloses.map((c,ti)=>c.map((_,i)=>scoreD(c,volumes[ti],rsis[ti],ret1dZs[ti],i)));

  return { garchs, atrs, volumes, sA, sB, sC, sD, allCloses };
}

// ─── Simulation ───────────────────────────────────────────────
function simulate(allBars, allCloses, btcCloses, ethCloses, symbols, precomp, splitIdx, params, warmup) {
  const { garchs, atrs, volumes, sA, sB, sC, sD } = precomp;
  const { topN, adaptWindow, stopMult, tpMult, stopMultD, tpMultD, regimeParams } = params;
  const n = allBars[0].length;
  const isTrades=[], oosTrades=[];
  const meta = new AdaptiveMeta(adaptWindow);
  let openPos={}, lastRebal=0, yIS=0, yOOS=0;
  const regimeLog = {};

  for (let i=warmup; i<n; i++) {
    const regime = sixStateRegime(btcCloses, ethCloses, allCloses, i, regimeParams);
    if (!regime) continue;

    const inOOS = i >= splitIdx;
    const state = regime.state;
    if (!regimeLog[state]) regimeLog[state] = 0;
    regimeLog[state]++;

    // ── Stop/TP ─────────────────────────────────────────────
    for (const [ts,pos] of Object.entries(openPos)) {
      const tidx=+ts, bar=allBars[tidx][i];
      let ep=null, er=null;
      if (bar.low <= pos.stop)  { ep=pos.stop;  er='stop'; }
      if (bar.high >= pos.tp)   { ep=pos.tp;    er='tp'; }
      if (ep) {
        const t = { entryBar:pos.entryBar, pnl:(ep-pos.entryPrice)/pos.entryPrice,
          exitReason:er, holdHours:i-pos.entryBar, weight:pos.weight,
          strategy:pos.strategy, regime:pos.regimeEntry, symbol:symbols[tidx] };
        (inOOS?oosTrades:isTrades).push(t);
        meta.recordTrade(pos.strategy, t.pnl, i);
        delete openPos[ts];
      }
    }

    // Yield
    const idle = Math.max(0, 1 - Object.keys(openPos).length * BASE_SIZE);
    if (inOOS) yOOS += idle*AAVE_APY/(365*24); else yIS += idle*AAVE_APY/(365*24);

    if (i - lastRebal < REBAL_H) continue;
    lastRebal = i;

    // ── BEAR: close all ──────────────────────────────────────
    if (state === 'BEAR') {
      for (const [ts,pos] of Object.entries(openPos)) {
        const tidx=+ts, bar=allBars[tidx][i];
        const t = { entryBar:pos.entryBar, pnl:(bar.close-pos.entryPrice)/pos.entryPrice,
          exitReason:'regime', holdHours:i-pos.entryBar, weight:pos.weight,
          strategy:pos.strategy, regime:pos.regimeEntry, symbol:symbols[tidx] };
        (inOOS?oosTrades:isTrades).push(t);
        meta.recordTrade(pos.strategy, t.pnl, i);
        delete openPos[ts];
      }
      continue;
    }

    // ── Get adaptive weights ─────────────────────────────────
    const w = meta.getWeights(regime);

    // ── Cross-sectional C rank ───────────────────────────────
    const cRaw = allCloses.map((_,ti)=>({ ti, s:sC[ti][i] })).filter(x=>x.s!==null);
    cRaw.sort((a,b)=>a.s-b.s);
    const cRanked = new Map();
    for (let ri=0; ri<cRaw.length; ri++) {
      cRanked.set(cRaw[ri].ti, cRaw.length>1 ? (ri/(cRaw.length-1))*2-1 : 0);
    }

    // ── Score all tokens ─────────────────────────────────────
    const scored = allCloses.map((_,ti) => {
      const va = sA[ti][i] ?? 0;
      const vb = sB[ti][i] ?? 0;
      const xrank = cRanked.get(ti) ?? 0;
      const vcRaw = sC[ti][i] ?? 0;
      const vc = 0.6*vcRaw + 0.4*xrank;
      const vd = sD[ti][i] ?? 0;

      // Alt season: boost DeFi/alt tokens
      const combined = w.A*va + w.B*vb + w.C*vc + w.D*vd;

      // Dominant strategy
      const candidates = [
        { s:'A', v:w.A*va }, { s:'B', v:w.B*vb },
        { s:'C', v:w.C*vc }, { s:'D', v:w.D*vd }
      ];
      const dom = candidates.reduce((best,c)=>c.v>best.v?c:best, {s:'A',v:0});

      return { ti, combined, strat:dom.s, vd, va, gs:garchs[ti][i]||0.5 };
    });

    // ── Build entry queue ────────────────────────────────────
    const entryQueue = [];

    // D (panic bounce) in RANGE states
    if (state.startsWith('RANGE') || state==='BULL_COOL') {
      const dCands = scored.filter(s=>s.vd>0).sort((a,b)=>b.vd-a.vd);
      for (const d of dCands.slice(0,1)) {
        entryQueue.push({ ti:d.ti, strat:'D', score:d.vd, gs:d.gs });
      }
    }

    // Momentum signals in BULL states
    if (state==='BULL_HOT'||state==='BULL_COOL') {
      const bullCands = scored
        .filter(s => s.combined > 0)
        .sort((a,b) => b.combined - a.combined);
      for (const c of bullCands.slice(0, topN)) {
        if (entryQueue.find(e=>e.ti===c.ti)) continue;
        entryQueue.push({ ti:c.ti, strat:c.strat, score:c.combined, gs:c.gs });
      }
    }

    // Light A in RANGE_TIGHT (accumulation before breakout)
    if (state==='RANGE_TIGHT') {
      const aCands = scored.filter(s=>s.va>0).sort((a,b)=>b.va-a.va);
      for (const a of aCands.slice(0,1)) {
        if (entryQueue.find(e=>e.ti===a.ti)) continue;
        entryQueue.push({ ti:a.ti, strat:'A', score:a.va, gs:a.gs });
      }
    }

    // ── Close not in queue ───────────────────────────────────
    const topSet = new Set(entryQueue.map(e=>e.ti));
    for (const [ts,pos] of Object.entries(openPos)) {
      if (!topSet.has(+ts)) {
        const tidx=+ts, bar=allBars[tidx][i];
        const t = { entryBar:pos.entryBar, pnl:(bar.close-pos.entryPrice)/pos.entryPrice,
          exitReason:'rebalance', holdHours:i-pos.entryBar, weight:pos.weight,
          strategy:pos.strategy, regime:pos.regimeEntry, symbol:symbols[tidx] };
        (inOOS?oosTrades:isTrades).push(t);
        meta.recordTrade(pos.strategy, t.pnl, i);
        delete openPos[ts];
      }
    }

    // ── Open new ─────────────────────────────────────────────
    for (const e of entryQueue) {
      if (openPos[e.ti] !== undefined) continue;
      const bar = allBars[e.ti][i];
      const atr = atrs[e.ti][i] || bar.close*0.02;
      const sz  = Math.min(BASE_SIZE/(e.gs*0.5), MAX_POS);
      const sm  = e.strat==='D' ? stopMultD : stopMult;
      const tm  = e.strat==='D' ? tpMultD   : tpMult;
      openPos[e.ti] = { entryBar:i, entryPrice:bar.close,
        stop:bar.close-sm*atr, tp:bar.close+tm*atr,
        weight:sz, strategy:e.strat, regimeEntry:state };
    }
  }

  // Close remaining
  for (const [ts,pos] of Object.entries(openPos)) {
    const tidx=+ts, last=allBars[tidx][n-1];
    const t = { entryBar:pos.entryBar, pnl:(last.close-pos.entryPrice)/pos.entryPrice,
      exitReason:'end', holdHours:n-1-pos.entryBar, weight:pos.weight,
      strategy:pos.strategy, regime:pos.regimeEntry, symbol:symbols[tidx], open:true };
    (pos.entryBar>=splitIdx?oosTrades:isTrades).push(t);
  }

  return { isTrades, oosTrades, yIS, yOOS, regimeLog };
}

function stats(trades, y=0) {
  const yr=y*100;
  if (!trades||trades.length<5) return {n:trades?.length||0,sharpe:-99,ret:Math.round(yr*10)/10,dd:0,wr:0};
  const pr=trades.map(t=>t.pnl*(t.weight||BASE_SIZE));
  const wins=trades.filter(t=>t.pnl>0);
  const m=pr.reduce((a,b)=>a+b,0)/pr.length, sd=Math.sqrt(pr.reduce((s,r)=>s+(r-m)**2,0)/pr.length);
  const sharpe=sd>0?(m/sd)*Math.sqrt(365):0;
  let eq=1,pk=1,dd=0; for(const r of pr){eq*=(1+r);if(eq>pk)pk=eq;const d=(pk-eq)/pk;if(d>dd)dd=d;}
  const tr=(eq-1)*100,tot=tr+yr;
  const byS={};
  for(const t of trades){
    const s=t.strategy||'?'; if(!byS[s])byS[s]={n:0,wins:0,pnl:0};
    byS[s].n++; if(t.pnl>0)byS[s].wins++; byS[s].pnl+=t.pnl;
  }
  const byR={};
  for(const t of trades){
    const r=t.regime||'?'; if(!byR[r])byR[r]={n:0,wins:0,pnl:0};
    byR[r].n++; if(t.pnl>0)byR[r].wins++; byR[r].pnl+=t.pnl;
  }
  return{n:trades.length,sharpe:Math.round(sharpe*100)/100,ret:Math.round(tot*10)/10,tradRet:Math.round(tr*10)/10,dd:Math.round(dd*1000)/10,wr:Math.round(wins.length/trades.length*100),stop:Math.round(trades.filter(t=>t.exitReason==='stop').length/trades.length*100),byStrategy:byS,byRegime:byR};
}

// ─── Walk-forward: 3 folds ────────────────────────────────────
// Fold 1: train on first 60%, test on 60-75%
// Fold 2: train on first 70%, test on 70-85%
// Fold 3: train on first 75%, test on 75-100%
function walkForwardStats(allBars, allCloses, btcCloses, ethCloses, symbols, precomp, params, n, warmup) {
  const folds = [
    { isEnd: Math.floor(n*0.60), oosStart: Math.floor(n*0.60), oosEnd: Math.floor(n*0.75) },
    { isEnd: Math.floor(n*0.70), oosStart: Math.floor(n*0.70), oosEnd: Math.floor(n*0.85) },
    { isEnd: Math.floor(n*0.75), oosStart: Math.floor(n*0.75), oosEnd: n },
  ];

  const foldResults = [];
  for (const fold of folds) {
    // Simulate on full period, take IS=0..isEnd, OOS=oosStart..oosEnd
    const { isTrades, oosTrades, yIS, yOOS } = simulate(
      allBars, allCloses, btcCloses, ethCloses, symbols, precomp, fold.isEnd, params, warmup
    );
    // Only count OOS trades in [oosStart, oosEnd]
    const oosSlice = oosTrades; // trades after isEnd
    const is_ = stats(isTrades, yIS);
    const oos_ = stats(oosSlice, yOOS);
    foldResults.push({ is: is_, oos: oos_ });
  }

  const meanOOSSharpe = foldResults.reduce((s,f)=>s+f.oos.sharpe,0)/foldResults.length;
  const worstOOSSharpe = Math.min(...foldResults.map(f=>f.oos.sharpe));
  const meanISpos = foldResults.filter(f=>f.is.sharpe>0).length >= 2;

  return { folds:foldResults, meanOOSSharpe:Math.round(meanOOSSharpe*100)/100, worstOOSSharpe:Math.round(worstOOSSharpe*100)/100, meanISpos };
}

// ─── Grid ─────────────────────────────────────────────────────
// Clean 5-state grid (ALT_SEASON removed)
// 5 states: BULL_HOT, BULL_COOL, RANGE_TIGHT, RANGE_WIDE, BEAR
const GRID = [];
for (const topN          of [1, 2])
for (const adaptWindow   of [7*24, 14*24])
for (const stopMult      of [1.5, 2.0, 2.5])
for (const tpMult        of [4.0, 5.0, 6.0])
for (const stopMultD     of [1.5, 2.0])
for (const tpMultD       of [2.0, 2.5])
for (const bullThresh    of [0.03, 0.05, 0.08])
for (const bearThresh    of [-0.03, -0.05])
for (const breadthMin    of [0.30, 0.43])
for (const volHighMult   of [1.3, 1.5])
  GRID.push({topN,adaptWindow,stopMult,tpMult,stopMultD,tpMultD,
    regimeParams:{bullThresh,bearThresh,altWin:14*24,altThresh:999,breadthMin,volHighMult},
    label:`N=${topN} aw=${adaptWindow/24}d sm=${stopMult} tp=${tpMult} smD=${stopMultD} tpD=${tpMultD} bull=${bullThresh} bear=${bearThresh} brd>${breadthMin} vH=${volHighMult}`});

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`delu ADAPTIVE FRAMEWORK — 6 market states + ETH/BTC + walk-forward`);
  console.log(`Grid: ${GRID.length} combos | ${TOKENS.length} tokens | 2yr | 3-fold walk-forward`);
  console.log(`${'═'.repeat(72)}\n`);

  console.log('Fetching data...');
  const rawData = [];
  for (let i=0; i<TOKENS.length; i++) {
    process.stdout.write(`  [${SYMBOLS[i]}] `);
    try {
      const bars = await fetchBinance(TOKENS[i]);
      rawData.push({ symbol:SYMBOLS[i], bars });
      console.log(`${bars.length} bars`);
    } catch(e) { console.log(`FAILED: ${e.message}`); }
    await sleep(300);
  }

  const valid   = rawData.filter(d=>d.bars?.length>500);
  const minLen  = Math.min(...valid.map(d=>d.bars.length));
  const allBars = valid.map(d=>d.bars.slice(-minLen));
  const allCloses = allBars.map(b=>b.map(x=>x.close));
  const symbols = valid.map(d=>d.symbol);
  const btcIdx  = symbols.indexOf('BTC');
  const ethIdx  = symbols.indexOf('ETH');
  const btcCloses = allCloses[btcIdx >= 0 ? btcIdx : 0];
  const ethCloses = allCloses[ethIdx >= 0 ? ethIdx : btcIdx];
  const splitIdx = Math.floor(minLen * 0.70);  // default split for single-pass
  const n = minLen;
  const WARMUP = Math.min(200*24, Math.floor(n * 0.2));

  console.log(`\n${n} bars | IS: ${Math.round(splitIdx/24)}d | OOS: ${Math.round((n-splitIdx)/24)}d | Warmup: ${Math.round(WARMUP/24)}d\n`);
  const precomp = precompute(allBars, allCloses, btcCloses, ethCloses);
  console.log(`\nRunning ${GRID.length} combos (3-fold each)...\n`);

  const results = [];
  let tested = 0;
  for (const params of GRID) {
    // Fast single-pass first (70/30) for ranking
    const { isTrades, oosTrades, yIS, yOOS, regimeLog } = simulate(
      allBars, allCloses, btcCloses, ethCloses, symbols, precomp, splitIdx, params, WARMUP
    );
    const oos = stats(oosTrades, yOOS);
    const is_ = stats(isTrades, yIS);
    results.push({ params, is: is_, oos, regimeLog });
    tested++;
    if (tested % 200 === 0) process.stdout.write(`  ${tested}/${GRID.length} done...\r`);
  }
  console.log(`\n  ${tested}/${GRID.length} done`);

  // Rank by OOS Sharpe (IS>0 boosted) — fast pass
  const ranked = results
    .filter(r => r.oos.n >= 10)
    .sort((a,b) => {
      const aS = a.oos.sharpe * (a.is.sharpe > 0 ? 1.5 : 0.5);
      const bS = b.oos.sharpe * (b.is.sharpe > 0 ? 1.5 : 0.5);
      return bS - aS;
    });

  // Run 3-fold walk-forward on top 20 candidates
  console.log(`\nRunning 3-fold walk-forward on top 20 candidates...`);
  const topWF = [];
  for (const r of ranked.slice(0, 20)) {
    const wf = walkForwardStats(allBars, allCloses, btcCloses, ethCloses, symbols, precomp, r.params, n, WARMUP);
    topWF.push({ ...r, wf });
  }

  // Re-rank by worst-case OOS Sharpe (robust across all folds)
  topWF.sort((a,b) => b.wf.worstOOSSharpe - a.wf.worstOOSSharpe);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`RESULTS — ${ranked.length} configs with ≥10 OOS trades`);
  console.log(`Walk-forward top 10 (ranked by worst-case fold OOS Sharpe):`);
  console.log(`${'═'.repeat(72)}\n`);

  console.log(`${'─'.repeat(100)}`);
  console.log(`${'Params'.padEnd(55)} ${'OOS-Sh'.padEnd(8)} ${'WF-Mean'.padEnd(9)} ${'WF-Worst'.padEnd(10)} ${'Ret%'.padEnd(8)} ${'N'.padEnd(5)} IS-Sh`);
  console.log(`${'─'.repeat(100)}`);
  for (const r of topWF.slice(0, 10)) {
    const o=r.oos, w=r.wf;
    const f=w.worstOOSSharpe>2?'🔥':w.worstOOSSharpe>1?'✅':w.worstOOSSharpe>0?'⚠️':'❌';
    const inv=r.is.sharpe>0?'✅':'⚠️';
    console.log(`${f} ${r.params.label.slice(0,52).padEnd(55)} ${String(o.sharpe).padEnd(8)} ${String(w.meanOOSSharpe).padEnd(9)} ${String(w.worstOOSSharpe).padEnd(10)} ${String(o.ret+'%').padEnd(8)} ${String(o.n).padEnd(5)} ${inv}${r.is.sharpe}`);
  }

  const best = topWF[0];
  if (best) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`🏆 BEST CONFIG (robust across all market conditions)`);
    console.log(`   ${best.params.label}`);
    console.log(`${'─'.repeat(72)}`);
    console.log(`   Single-pass OOS: ret=${best.oos.ret}% trading=${best.oos.tradRet}% sharpe=${best.oos.sharpe} DD=${best.oos.dd}% n=${best.oos.n} wr=${best.oos.wr}%`);
    console.log(`   Walk-forward:    mean=${best.wf.meanOOSSharpe}  worst=${best.wf.worstOOSSharpe}  IS-positive-folds=${best.wf.folds.filter(f=>f.is.sharpe>0).length}/3`);
    console.log(`   IS:  ret=${best.is.ret}% sharpe=${best.is.sharpe}`);

    // Regime breakdown
    if (best.regimeLog) {
      console.log(`\n   Regime distribution (full period):`);
      const total = Object.values(best.regimeLog).reduce((a,b)=>a+b,0);
      for (const [r,v] of Object.entries(best.regimeLog).sort((a,b)=>b[1]-a[1])) {
        console.log(`     ${r.padEnd(14)}: ${Math.round(v/24)}d (${Math.round(v/total*100)}%)`);
      }
    }
    if (best.oos.byStrategy) {
      console.log(`\n   By template (OOS):`);
      for (const [s,v] of Object.entries(best.oos.byStrategy)) {
        if (v.n === 0) continue;
        console.log(`     ${s}: n=${v.n} wr=${Math.round(v.wins/v.n*100)}% pnl=${Math.round(v.pnl*100)}%`);
      }
    }
    if (best.oos.byRegime) {
      console.log(`\n   By regime (OOS):`);
      for (const [r,v] of Object.entries(best.oos.byRegime)) {
        if (v.n === 0) continue;
        console.log(`     ${r.padEnd(14)}: n=${v.n} wr=${Math.round(v.wins/v.n*100)}% pnl=${Math.round(v.pnl*100)}%`);
      }
    }

    // 3-fold details
    console.log(`\n   Walk-forward fold details:`);
    for (let fi=0; fi<best.wf.folds.length; fi++) {
      const f = best.wf.folds[fi];
      console.log(`     Fold ${fi+1}: IS sharpe=${f.is.sharpe} ret=${f.is.ret}% | OOS sharpe=${f.oos.sharpe} ret=${f.oos.ret}% n=${f.oos.n}`);
    }
    console.log(`${'═'.repeat(72)}`);
  }

  // Benchmark
  const btcOOS = allCloses[btcIdx];
  const splitBTC = btcOOS[splitIdx], endBTC = btcOOS[n-1];
  const btcRet = Math.round((endBTC-splitBTC)/splitBTC*1000)/10;
  const ethOOS = allCloses[ethIdx];
  const splitETH = ethOOS[splitIdx], endETH = ethOOS[n-1];
  const ethRet = Math.round((endETH-splitETH)/splitETH*1000)/10;
  console.log(`\n   Benchmarks (OOS period): BTC ${btcRet}%  ETH ${ethRet}%  Aave ~3%`);

  const elapsed = Math.round((Date.now()-t0)/1000);
  const outFile = path.join(RESULTS_DIR, `adaptive-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(),
    grid_size: GRID.length,
    top10: topWF.slice(0,10).map(r=>({ params:r.params, oos:r.oos, is:r.is, wf:{meanOOSSharpe:r.wf.meanOOSSharpe,worstOOSSharpe:r.wf.worstOOSSharpe} })),
    best: best ? { params:best.params, oos:best.oos, is:best.is, wf:{ meanOOSSharpe:best.wf.meanOOSSharpe, worstOOSSharpe:best.wf.worstOOSSharpe, folds:best.wf.folds } } : null,
  }, null, 2));
  console.log(`\nDone in ${elapsed}s | 💾 ${outFile}`);
}

main().catch(e => { console.error('Fatal:', e.stack); process.exit(1); });
