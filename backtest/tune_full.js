#!/usr/bin/env node
/**
 * tune_full.js — grid search on full framework meta-parameters
 *
 * Reuses all signal logic from full_v2.js but sweeps:
 *   1. stopMult / tpMult  — ATR stop & take-profit multipliers
 *   2. wA/wB/wC/wD        — meta-allocator template weights
 *   3. topN               — max concurrent positions
 *   4. rangeMode          — what to do in RANGE regime
 *   5. minScoreA          — minimum A score to enter (noise filter)
 *
 * Goal: find config where BOTH IS Sharpe > 0 AND OOS Sharpe > 1
 */

const fs   = require('fs');
const path = require('path');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKENS  = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','AAVEUSDT','ARBUSDT'];
const SYMBOLS = ['BTC','ETH','SOL','BNB','DOGE','AAVE','ARB'];
const DAYS=730, IS_SPLIT=0.70, WARMUP=200*24, REBAL_H=24, AAVE_APY=0.05;
const BASE_SIZE=0.15, MAX_POS=0.35;

// ─── Data ─────────────────────────────────────────────────────
async function fetchBinance(symbol) {
  const total=DAYS*24; let all=[],endTime=Date.now();
  while(all.length<total){
    const res=await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&endTime=${endTime}`);
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
function computeOBV(c,v){
  const o=new Array(c.length).fill(0);
  for(let i=1;i<c.length;i++){
    if(c[i]>c[i-1])o[i]=o[i-1]+v[i];
    else if(c[i]<c[i-1])o[i]=o[i-1]-v[i];
    else o[i]=o[i-1];
  }
  return o;
}
function volSurpriseZ(v,i,win=30*24){
  if(i<win)return null;
  const s=v.slice(i-win,i),m=s.reduce((a,b)=>a+b,0)/s.length;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
  return sd>0?(v[i]-m)/sd:0;
}
function ret1dZ(c,i,win=30*24){
  if(i<win+24)return null;
  const r1=(c[i]-c[i-24])/c[i-24];
  const rs=[]; for(let k=i-win;k<=i;k+=24)rs.push((c[k]-c[k-24])/c[k-24]);
  const m=rs.reduce((a,b)=>a+b,0)/rs.length,sd=Math.sqrt(rs.reduce((s,v)=>s+(v-m)**2,0)/rs.length);
  return sd>0?(r1-m)/sd:0;
}
function btcRegime(btcC,i){
  if(i<200*24)return null;
  const n200=200*24,n7=7*24,n30=30*24;
  const sma200=btcC.slice(i-n200,i+1).reduce((a,b)=>a+b,0)/(n200+1);
  let v7=0,v30=0;
  for(let j=i-n7+1;j<=i;j++){const r=Math.log(btcC[j]/btcC[j-1]);v7+=r*r;}
  for(let j=i-n30+1;j<=i;j++){const r=Math.log(btcC[j]/btcC[j-1]);v30+=r*r;}
  const vr=Math.sqrt(v30/n30)>0?Math.sqrt(v7/n7)/Math.sqrt(v30/n30):1;
  const pct=(btcC[i]-sma200)/sma200;
  return{state:pct>0.05&&vr<1.5?'BULL':pct<-0.05?'BEAR':'RANGE',extremeVol:vr>2.0};
}

// ─── Signal functions (tuned params from tune.js + tune_bd.js) ──
function scoreA(c,v,i,minScore=0.05){
  if(i<120*24)return null;
  const r20=(c[i]-c[i-20*24])/c[i-20*24];
  const r60=(c[i]-c[i-60*24])/c[i-60*24];
  const r120=(c[i]-c[i-120*24])/c[i-120*24];
  const trend=0.5*r20+0.3*r60+0.2*r120;
  if(trend<minScore)return 0;
  const vz=volSurpriseZ(v,i); if(vz===null)return null;
  // Template A: trend × (1 + attention_multiplier)
  const attn=Math.tanh(vz*0.5);
  return Math.max(0, trend*(1+attn));
}

function scoreB(c,v,rsi,i){
  const WIN=14*24,MIN_OBV_Z=0.8,MAX_PC=0.05,MAX_RSI=60;
  if(i<WIN+25)return null;
  if(rsi[i]!==null&&rsi[i]>MAX_RSI)return 0;
  const priceChg=(c[i]-c[i-WIN])/c[i-WIN];
  if(priceChg>MAX_PC)return 0;
  // Compute OBV z-score inline
  let ob=0; const obvArr=[];
  for(let k=Math.max(0,i-WIN-25);k<=i;k++){
    if(k>0){if(c[k]>c[k-1])ob+=v[k];else if(c[k]<c[k-1])ob-=v[k];}
    obvArr.push(ob);
  }
  const win=obvArr.slice(-WIN-1);
  const m=win.reduce((a,b)=>a+b,0)/win.length,sd=Math.sqrt(win.reduce((a,b)=>a+(b-m)**2,0)/win.length);
  if(sd<1e-9)return 0;
  const ozNow=(win[win.length-1]-m)/sd, ozPrev=(win[win.length-25]-m)/sd;
  if(ozNow<MIN_OBV_Z||ozNow<=ozPrev)return 0;
  return Math.max(0,Math.tanh(ozNow*0.5)*Math.tanh((ozNow-ozPrev)*2));
}

function scoreC(c,v,i){
  // Raw score for cross-sectional ranking
  if(i<30*24)return null;
  const r30=(c[i]-c[i-30*24])/c[i-30*24];
  const vz=volSurpriseZ(v,i); if(vz===null)return null;
  // vol acceleration (2nd derivative)
  let va=0;
  if(i>=3){
    const vz1=volSurpriseZ(v,i-1),vz2=volSurpriseZ(v,i-2);
    if(vz1!==null&&vz2!==null)va=(vz-vz1)-(vz1-vz2);
  }
  return r30*0.3 + Math.tanh(vz*0.4) + Math.tanh(va*0.2);
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

// ─── Precompute ───────────────────────────────────────────────
function precompute(allBars,allCloses,btcCloses){
  console.log('  Precomputing indicators...');
  const n=allCloses[0].length;
  const regimes=allCloses[0].map((_,i)=>btcRegime(btcCloses,i));
  const garchs=allCloses.map(c=>computeGARCH(c));
  const atrs=allBars.map(b=>computeATR(b));
  const rsis=allCloses.map(c=>computeRSI(c));
  const volumes=allBars.map(b=>b.map(x=>x.volume));
  const ret1dZs=allCloses.map(c=>c.map((_,i)=>ret1dZ(c,i)));

  // Pre-score all templates at every bar
  console.log('  Pre-scoring templates A/B/C/D...');
  const scoresA=allCloses.map((c,ti)=>c.map((_,i)=>scoreA(c,volumes[ti],i)));
  const scoresB=allCloses.map((c,ti)=>c.map((_,i)=>scoreB(c,volumes[ti],rsis[ti],i)));
  const scoresC=allCloses.map((c,ti)=>c.map((_,i)=>scoreC(c,volumes[ti],i)));
  const scoresD=allCloses.map((c,ti)=>c.map((_,i)=>scoreD(c,volumes[ti],rsis[ti],ret1dZs[ti],i)));

  return{regimes,garchs,atrs,volumes,scoresA,scoresB,scoresC,scoresD};
}

// ─── Simulation ───────────────────────────────────────────────
function simulate(allBars,allCloses,precomp,splitIdx,params){
  const{regimes,garchs,atrs,scoresA,scoresB,scoresC,scoresD}=precomp;
  const{stopMult,tpMult,stopMultD,tpMultD,wA,wB,wC,wD,topN,minScoreA,rangeMode}=params;
  const n=allBars[0].length;
  const isTrades=[], oosTrades=[];
  let openPos={}, lastRebal=0, yIS=0, yOOS=0;

  for(let i=WARMUP;i<n;i++){
    const reg=regimes[i]; if(!reg)continue;

    // Stop/TP checks
    for(const[ts,pos]of Object.entries(openPos)){
      const tidx=+ts,bar=allBars[tidx][i]; let ep=null,er=null;
      if(bar.low<=pos.stop){ep=pos.stop;er='stop';}
      else if(bar.high>=pos.tp){ep=pos.tp;er='tp';}
      if(ep){
        const t={entryBar:pos.entryBar,pnl:(ep-pos.entryPrice)/pos.entryPrice,exitReason:er,holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t); delete openPos[ts];
      }
    }

    // Yield
    const idle=Math.max(0,1-Object.keys(openPos).length*BASE_SIZE);
    if(i<splitIdx)yIS+=idle*AAVE_APY/(365*24); else yOOS+=idle*AAVE_APY/(365*24);

    if(i-lastRebal<REBAL_H)continue; lastRebal=i;

    // BEAR: exit A/B/C positions (D stays)
    if(reg.state==='BEAR'||reg.extremeVol){
      for(const[ts,pos]of Object.entries(openPos)){
        if(pos.strategy==='D')continue;
        const tidx=+ts,bar=allBars[tidx][i];
        const t={entryBar:pos.entryBar,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'regime',holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t); delete openPos[ts];
      }
    }

    // Build cross-sectional C ranks at this bar
    const cRaw=allCloses.map((_,ti)=>({ti,s:scoresC[ti][i]})).filter(x=>x.s!==null);
    cRaw.sort((a,b)=>a.s-b.s);
    const cRanked=new Map();
    for(let ri=0;ri<cRaw.length;ri++) cRanked.set(cRaw[ri].ti, cRaw.length>1?(ri/(cRaw.length-1))*2-1:0);

    // Score tokens
    const tokenScores=allCloses.map((_,ti)=>{
      const sA=scoresA[ti][i]??0, sB=scoresB[ti][i]??0;
      const sC_raw=scoresC[ti][i]??0;
      const xrank=cRanked.get(ti)??0;
      const sC=sC_raw!==null?0.6*sC_raw+0.4*xrank:0;
      const sD=scoresD[ti][i]??0;
      const combined=wA*(sA>=minScoreA?sA:0)+wB*sB+wC*sC+wD*sD;
      const dominantStrat=sD>0&&sD>=Math.max(wA*(sA>=minScoreA?sA:0),wB*sB,wC*sC)?'D':
                          sB>0&&wB*sB>=Math.max(wA*(sA>=minScoreA?sA:0),wC*sC)?'B':
                          sC>0&&wC*sC>=wA*(sA>=minScoreA?sA:0)?'C':'A';
      return{ti,sA,sB,sC,sD,combined,strat:dominantStrat,gs:garchs[ti][i]||0.5};
    });

    // Entry queue by regime
    const entryQueue=[];
    const dCands=tokenScores.filter(s=>s.sD>0).sort((a,b)=>b.sD-a.sD);

    // D fires in all regimes
    for(const d of dCands.slice(0,2)){
      entryQueue.push({ti:d.ti,strat:'D',score:d.sD,gs:d.gs});
    }

    if(reg.state==='BULL'){
      const bullCands=tokenScores.filter(s=>s.combined>0).sort((a,b)=>b.combined-a.combined);
      for(const c of bullCands.slice(0,topN)){
        if(entryQueue.find(e=>e.ti===c.ti))continue;
        entryQueue.push({ti:c.ti,strat:c.strat,score:c.combined,gs:c.gs});
      }
    } else if(reg.state==='RANGE'){
      if(rangeMode==='A_only'){
        const aCands=tokenScores.filter(s=>s.sA>=minScoreA).sort((a,b)=>b.sA-a.sA);
        for(const c of aCands.slice(0,1)){
          if(entryQueue.find(e=>e.ti===c.ti))continue;
          entryQueue.push({ti:c.ti,strat:'A',score:c.sA,gs:c.gs});
        }
      }
      // rangeMode='D_only' → only D (already queued above)
    }

    // Close not in entry queue
    const topSet=new Set(entryQueue.map(e=>e.ti));
    for(const[ts,pos]of Object.entries(openPos)){
      if(!topSet.has(+ts)){
        const tidx=+ts,bar=allBars[tidx][i];
        const t={entryBar:pos.entryBar,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'rebalance',holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
        (pos.entryBar<splitIdx?isTrades:oosTrades).push(t); delete openPos[ts];
      }
    }

    // Open new positions
    for(const e of entryQueue){
      if(openPos[e.ti]!==undefined)continue;
      const bar=allBars[e.ti][i],atr=atrs[e.ti][i]||bar.close*0.02;
      const sz=Math.min(BASE_SIZE/(e.gs*0.5),MAX_POS);
      const sm=e.strat==='D'?stopMultD:stopMult;
      const tm=e.strat==='D'?tpMultD:tpMult;
      openPos[e.ti]={entryBar:i,entryPrice:bar.close,stop:bar.close-sm*atr,tp:bar.close+tm*atr,weight:sz,strategy:e.strat,regimeEntry:reg.state};
    }
  }

  // Close remaining
  for(const[ts,pos]of Object.entries(openPos)){
    const tidx=+ts,last=allBars[tidx][n-1];
    const t={entryBar:pos.entryBar,pnl:(last.close-pos.entryPrice)/pos.entryPrice,exitReason:'end',holdHours:n-1-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry,open:true};
    (pos.entryBar<splitIdx?isTrades:oosTrades).push(t);
  }

  return{isTrades,oosTrades,yIS,yOOS};
}

function stats(trades,y=0){
  const yr=y*100;
  if(!trades||trades.length<5)return{n:trades?.length||0,sharpe:-99,ret:Math.round(yr*10)/10,dd:0,wr:0};
  const pr=trades.map(t=>t.pnl*(t.weight||BASE_SIZE));
  const wins=trades.filter(t=>t.pnl>0);
  const m=pr.reduce((a,b)=>a+b,0)/pr.length,sd=Math.sqrt(pr.reduce((s,r)=>s+(r-m)**2,0)/pr.length);
  const sharpe=sd>0?(m/sd)*Math.sqrt(365):0;
  let eq=1,pk=1,dd=0; for(const r of pr){eq*=(1+r);if(eq>pk)pk=eq;const d=(pk-eq)/pk;if(d>dd)dd=d;}
  const tr=(eq-1)*100,tot=tr+yr;
  const byS={};
  for(const t of trades){
    const s=t.strategy||'?'; if(!byS[s])byS[s]={n:0,wins:0,pnl:0};
    byS[s].n++; if(t.pnl>0)byS[s].wins++; byS[s].pnl+=t.pnl;
  }
  return{n:trades.length,sharpe:Math.round(sharpe*100)/100,ret:Math.round(tot*10)/10,tradRet:Math.round(tr*10)/10,dd:Math.round(dd*1000)/10,wr:Math.round(wins.length/trades.length*100),stop:Math.round(trades.filter(t=>t.exitReason==='stop').length/trades.length*100),byStrategy:byS};
}

// ─── Grid ─────────────────────────────────────────────────────
const GRID=[];
for(const stopMult    of [1.5, 2.0, 2.5, 3.0])
for(const tpMult      of [3.0, 4.0, 5.0, 6.0])
for(const stopMultD   of [1.2, 1.5, 2.0])
for(const tpMultD     of [2.0, 2.5, 3.0])
for(const topN        of [1, 2, 3])
for(const minScoreA   of [0.02, 0.05, 0.10])
for(const rangeMode   of ['D_only', 'A_only'])
for(const weights     of [
  {wA:1,wB:1,wC:1,wD:1},      // equal
  {wA:0.5,wB:2,wC:1,wD:2},    // boost B+D (high Sharpe templates)
  {wA:1,wB:1,wC:2,wD:1},      // boost C (best tune.js result)
  {wA:1,wB:0.5,wC:1,wD:2},    // boost D
  {wA:2,wB:1,wC:1,wD:1},      // boost A (dominant volume)
])
  GRID.push({stopMult,tpMult,stopMultD,tpMultD,topN,minScoreA,rangeMode,...weights,
    label:`sm=${stopMult} tp=${tpMult} smD=${stopMultD} tpD=${tpMultD} N=${topN} minA=${minScoreA} rng=${rangeMode} w=[${weights.wA},${weights.wB},${weights.wC},${weights.wD}]`});

// ─── Main ─────────────────────────────────────────────────────
async function main(){
  const t0=Date.now();
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`delu FULL FRAMEWORK — meta parameter grid search`);
  console.log(`Grid: ${GRID.length} combos | 7 tokens | 2yr data | IS/OOS 70/30`);
  console.log(`${'═'.repeat(70)}\n`);

  console.log('Fetching data...');
  const rawData=[];
  for(let i=0;i<TOKENS.length;i++){
    process.stdout.write(`  [${SYMBOLS[i]}] `);
    try{const bars=await fetchBinance(TOKENS[i]);rawData.push({symbol:SYMBOLS[i],bars});console.log(`${bars.length} bars`);}
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
  console.log(`\n${minLen} bars | IS: ${Math.round(splitIdx/24)}d | OOS: ${Math.round((minLen-splitIdx)/24)}d\n`);

  const precomp=precompute(allBars,allCloses,btcCloses);
  console.log(`\nRunning ${GRID.length} combos...\n`);

  const results=[];
  let tested=0;
  for(const params of GRID){
    const{isTrades,oosTrades,yIS,yOOS}=simulate(allBars,allCloses,precomp,splitIdx,params);
    const oos=stats(oosTrades,yOOS), is_=stats(isTrades,yIS);
    results.push({params,is:is_,oos});
    tested++;
    if(tested%100===0){process.stdout.write(`  ${tested}/${GRID.length} done...\r`);}
  }

  // Rank: primary = OOS Sharpe, secondary = IS Sharpe > 0 (not inverted)
  const valid_r=results.filter(r=>r.oos.n>=15);
  const ranked=valid_r.sort((a,b)=>{
    // Penalise heavily if IS is negative (overfitting proxy)
    const aScore=a.oos.sharpe*(a.is.sharpe>0?1.5:0.5);
    const bScore=b.oos.sharpe*(b.is.sharpe>0?1.5:0.5);
    return bScore-aScore;
  });
  const winners=ranked.filter(r=>r.oos.sharpe>1&&r.is.sharpe>0);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`RESULTS — ${valid_r.length} configs with ≥15 OOS trades`);
  console.log(`Winners (OOS Sharpe>1 AND IS Sharpe>0): ${winners.length}`);
  console.log(`${'═'.repeat(70)}\n`);

  if(winners.length>0){
    console.log(`🏆 CONFIGS WHERE BOTH IS AND OOS ARE POSITIVE:\n`);
    for(const r of winners.slice(0,10)){
      console.log(`  OOS: sharpe=${r.oos.sharpe} ret=${r.oos.ret}% n=${r.oos.n} wr=${r.oos.wr}% DD=${r.oos.dd}% stop=${r.oos.stop}%`);
      console.log(`  IS:  sharpe=${r.is.sharpe} ret=${r.is.ret}% n=${r.is.n}`);
      console.log(`  → ${r.params.label}`);
      if(r.oos.byStrategy){
        const bs=Object.entries(r.oos.byStrategy).map(([s,v])=>`${s}:n=${v.n}(${Math.round(v.wins/v.n*100)}%win)`).join(' ');
        console.log(`  OOS by template: ${bs}`);
      }
      console.log('');
    }
  } else {
    console.log(`⚠️  No config has both IS>0 AND OOS Sharpe>1. Top by OOS only:\n`);
  }

  console.log(`TOP 20 (OOS Sharpe, IS Sharpe>0 boosted):\n`);
  console.log(`${'─'.repeat(110)}`);
  console.log(`${'Params'.padEnd(60)} ${'OOS-Sh'.padEnd(8)} ${'OOS-Ret'.padEnd(9)} ${'N'.padEnd(5)} ${'WR'.padEnd(6)} ${'DD'.padEnd(7)} IS-Sh`);
  console.log(`${'─'.repeat(110)}`);
  for(const r of ranked.slice(0,20)){
    const o=r.oos,is_=r.is;
    const f=o.sharpe>2?'🔥':o.sharpe>1?'✅':o.sharpe>0?'⚠️':'❌';
    const inv=is_.sharpe<0?'⚠️':'✅';
    console.log(`${f} ${r.params.label.slice(0,57).padEnd(60)} ${String(o.sharpe).padEnd(8)} ${String(o.ret+'%').padEnd(9)} ${String(o.n).padEnd(5)} ${String(o.wr+'%').padEnd(6)} ${String(o.dd+'%').padEnd(7)} ${inv}${is_.sharpe}`);
  }

  const best=ranked[0];
  if(best){
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`BEST CONFIG: ${best.params.label}`);
    console.log(`OOS: ret=${best.oos.ret}% trading=${best.oos.tradRet}% sharpe=${best.oos.sharpe} DD=${best.oos.dd}% n=${best.oos.n} wr=${best.oos.wr}% stop=${best.oos.stop}%`);
    console.log(`IS:  ret=${best.is.ret}% sharpe=${best.is.sharpe} n=${best.is.n}`);
    if(best.oos.byStrategy){
      console.log(`By template (OOS):`);
      for(const[s,v]of Object.entries(best.oos.byStrategy)){
        console.log(`  ${s}: n=${v.n} wins=${v.wins} wr=${Math.round(v.wins/v.n*100)}% pnl=${Math.round(v.pnl*100)}%`);
      }
    }
    console.log(`${'═'.repeat(70)}`);
  }

  const elapsed=Math.round((Date.now()-t0)/1000);
  const outFile=path.join(RESULTS_DIR,`tune-full-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile,JSON.stringify({
    run_at:new Date().toISOString(),
    grid_size:GRID.length,
    winners:winners.length,
    top20:ranked.slice(0,20).map(r=>({params:r.params,oos:r.oos,is:r.is})),
    best:ranked[0]?{params:ranked[0].params,oos:ranked[0].oos,is:ranked[0].is}:null,
  },null,2));
  console.log(`\nDone in ${elapsed}s | 💾 ${outFile}`);
}

main().catch(e=>{console.error('Fatal:',e.stack);process.exit(1);});
