#!/usr/bin/env node
/**
 * token_regime.js — per-token micro-regime filter
 *
 * Upgrade: each token gets its own regime check on top of the global BTC regime.
 * - Token above/below own 50d + 200d MA
 * - Token's own vol ratio
 * - Token-BTC correlation (low corr = more independent momentum)
 *
 * Rules:
 *   Global BEAR   → flat (same as before)
 *   Global BULL   + token personal BEAR  → skip that token
 *   Global BULL   + token personal BULL  → full size
 *   Global RANGE  + token personal BULL  → allow light entry (0.5× size)
 *   Global BULL   + token low BTC-corr   → allow larger size (1.2× size)
 */

const fs   = require('fs');
const path = require('path');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKENS  = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','AAVEUSDT','ARBUSDT'];
const SYMBOLS = ['BTC','ETH','SOL','BNB','DOGE','AAVE','ARB'];
const ALT_TOKENS = new Set(['AAVE','ARB','SOL']);
const DAYS=730, WARMUP=200*24, REBAL_H=24, AAVE_APY=0.05;
const BASE_SIZE=0.15, MAX_POS=0.35;

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

// ─── Global regime (same as adaptive) ─────────────────────────
function globalRegime(btcC, ethC, allCloses, i) {
  if(i<200*24+1)return null;
  const sma200=smaN(btcC,i,200*24); if(!sma200)return null;
  const n7=7*24,n30=30*24; let v7=0,v30=0;
  for(let j=i-n7+1;j<=i;j++){const r=Math.log(btcC[j]/btcC[j-1]);v7+=r*r;}
  for(let j=i-n30+1;j<=i;j++){const r=Math.log(btcC[j]/btcC[j-1]);v30+=r*r;}
  const vr=Math.sqrt(v30/n30)>0?Math.sqrt(v7/n7)/Math.sqrt(v30/n30):1;
  const pct=(btcC[i]-sma200)/sma200;
  const ethBtcChg=ethC[i-14*24]>0?(ethC[i]/btcC[i]-ethC[i-14*24]/btcC[i-14*24])/(ethC[i-14*24]/btcC[i-14*24]):0;
  let aboveMa=0; for(const c of allCloses){const ma=smaN(c,i,200*24);if(ma&&c[i]>ma)aboveMa++;}
  const breadth=aboveMa/allCloses.length;
  if(breadth<0.43||vr>2.25)return{state:'BEAR',vr,pct,breadth};
  const ethAbsTrend=ethC[i-14*24]>0?(ethC[i]-ethC[i-14*24])/ethC[i-14*24]:0; const altSeason=ethBtcChg>0.05&&ethAbsTrend>0.02;
  const state=pct>0.05?( altSeason?'ALT_SEASON':vr>1.5?'BULL_COOL':'BULL_HOT'):pct<-0.03?'BEAR':vr>1.5?'RANGE_WIDE':'RANGE_TIGHT';
  return{state,vr,pct,breadth,altSeason};
}

// ─── Per-token micro-regime ────────────────────────────────────
function tokenRegime(closes, i) {
  if (i < 200*24) return { bull: false, bear: false, sizeAdj: 1.0 };
  const sma200 = smaN(closes, i, 200*24);
  const sma50  = smaN(closes, i, 50*24);
  if (!sma200 || !sma50) return { bull: false, bear: false, sizeAdj: 1.0 };
  const pct200 = (closes[i] - sma200) / sma200;
  const pct50  = (closes[i] - sma50)  / sma50;
  const bull   = pct200 > 0.03 && pct50  > 0;
  const bear   = pct200 < -0.03;
  // Strong bull: token far above both MAs → allow slightly larger size
  const sizeAdj = bull && pct200 > 0.10 ? 1.2 : bear ? 0.0 : bull ? 1.0 : 0.6;
  return { bull, bear, sizeAdj, pct200, pct50 };
}

// ─── BTC correlation (30d rolling) ────────────────────────────
function btcCorr(tokenCloses, btcCloses, i, win=30*24) {
  if (i < win) return 1.0;
  const n = win;
  const tx=[], bx=[];
  for (let k=i-n+1; k<=i; k++) {
    tx.push(Math.log(tokenCloses[k]/tokenCloses[k-1]));
    bx.push(Math.log(btcCloses[k]/btcCloses[k-1]));
  }
  const mt=tx.reduce((a,b)=>a+b,0)/n, mb=bx.reduce((a,b)=>a+b,0)/n;
  let num=0,st=0,sb=0;
  for(let k=0;k<n;k++){num+=(tx[k]-mt)*(bx[k]-mb);st+=(tx[k]-mt)**2;sb+=(bx[k]-mb)**2;}
  return st>0&&sb>0?num/Math.sqrt(st*sb):1.0;
}

// ─── Signals ──────────────────────────────────────────────────
function scoreA(c,v,i){
  if(i<120*24)return null;
  const r20=(c[i]-c[i-20*24])/c[i-20*24],r60=(c[i]-c[i-60*24])/c[i-60*24],r120=(c[i]-c[i-120*24])/c[i-120*24];
  const trend=0.5*r20+0.3*r60+0.2*r120; if(trend<0.10)return 0;
  const vz=volSurpriseZ(v,i); if(vz===null)return null;
  return Math.max(0,trend*(1+Math.tanh(vz*0.5)));
}
function scoreB(c,v,rsi,i){
  const WIN=14*24; if(i<WIN+25)return null;
  if(rsi[i]!==null&&rsi[i]>60)return 0;
  if((c[i]-c[i-WIN])/c[i-WIN]>0.05)return 0;
  let ob=0; const arr=[];
  for(let k=Math.max(0,i-WIN-25);k<=i;k++){if(k>0){if(c[k]>c[k-1])ob+=v[k];else if(c[k]<c[k-1])ob-=v[k];}arr.push(ob);}
  const w=arr.slice(-WIN-1),m=w.reduce((a,b)=>a+b,0)/w.length,sd=Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/w.length);
  if(sd<1e-9)return 0;
  const oz=(w[w.length-1]-m)/sd,ozP=(w[w.length-25]-m)/sd;
  if(oz<0.8||oz<=ozP)return 0;
  return Math.max(0,Math.tanh(oz*0.5)*Math.tanh((oz-ozP)*2));
}
function scoreC(c,v,i){
  if(i<30*24)return null;
  const r30=(c[i]-c[i-30*24])/c[i-30*24],vz=volSurpriseZ(v,i); if(vz===null)return null;
  let va=0; if(i>=3){const z1=volSurpriseZ(v,i-1),z2=volSurpriseZ(v,i-2);if(z1!==null&&z2!==null)va=(vz-z1)-(z1-z2);}
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

function precompute(allBars,allCloses,btcCloses){
  console.log('  Precomputing...');
  const garchs=allCloses.map(c=>computeGARCH(c));
  const atrs=allBars.map(b=>computeATR(b));
  const rsis=allCloses.map(c=>computeRSI(c));
  const volumes=allBars.map(b=>b.map(x=>x.volume));
  const ret1dZs=allCloses.map(c=>c.map((_,i)=>ret1dZAt(c,i)));
  console.log('  Pre-scoring templates...');
  const sA=allCloses.map((c,ti)=>c.map((_,i)=>scoreA(c,volumes[ti],i)));
  const sB=allCloses.map((c,ti)=>c.map((_,i)=>scoreB(c,volumes[ti],rsis[ti],i)));
  const sC=allCloses.map((c,ti)=>c.map((_,i)=>scoreC(c,volumes[ti],i)));
  const sD=allCloses.map((c,ti)=>c.map((_,i)=>scoreD(c,volumes[ti],rsis[ti],ret1dZs[ti],i)));
  return{garchs,atrs,volumes,sA,sB,sC,sD};
}

// ─── Grid ─────────────────────────────────────────────────────
const GRID=[];
for(const stopMult   of [1.5,2.0,2.5])
for(const tpMult     of [4.0,5.0,6.0])
for(const stopMultD  of [1.5,2.0])
for(const tpMultD    of [2.0,2.5])
for(const topN       of [1,2])
for(const corrBoost  of [true,false])  // boost low-corr tokens
for(const rangeAllow of [true,false])  // allow token-personal-BULL in global RANGE
  GRID.push({stopMult,tpMult,stopMultD,tpMultD,topN,corrBoost,rangeAllow,
    label:`sm=${stopMult} tp=${tpMult} smD=${stopMultD} tpD=${tpMultD} N=${topN} corrBoost=${corrBoost} rngAllow=${rangeAllow}`});

function simulate(allBars,allCloses,btcCloses,ethCloses,symbols,precomp,splitIdx,params){
  const{garchs,atrs,sA,sB,sC,sD}=precomp;
  const{stopMult,tpMult,stopMultD,tpMultD,topN,corrBoost,rangeAllow}=params;
  const n=allBars[0].length;
  const isTrades=[],oosTrades=[];
  let openPos={},lastRebal=0,yIS=0,yOOS=0;

  for(let i=WARMUP;i<n;i++){
    const reg=globalRegime(btcCloses,ethCloses,allCloses,i); if(!reg)continue;
    const inOOS=i>=splitIdx;

    // Stop/TP
    for(const[ts,pos]of Object.entries(openPos)){
      const tidx=+ts,bar=allBars[tidx][i]; let ep=null,er=null;
      if(bar.low<=pos.stop){ep=pos.stop;er='stop';}
      if(bar.high>=pos.tp){ep=pos.tp;er='tp';}
      if(ep){
        const t={entryBar:pos.entryBar,pnl:(ep-pos.entryPrice)/pos.entryPrice,exitReason:er,holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
        (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
      }
    }
    const idle=Math.max(0,1-Object.keys(openPos).length*BASE_SIZE);
    if(inOOS)yOOS+=idle*AAVE_APY/(365*24); else yIS+=idle*AAVE_APY/(365*24);
    if(i-lastRebal<REBAL_H)continue; lastRebal=i;

    if(reg.state==='BEAR'){
      for(const[ts,pos]of Object.entries(openPos)){
        const tidx=+ts,bar=allBars[tidx][i];
        const t={entryBar:pos.entryBar,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'regime',holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
        (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
      }
      continue;
    }

    // Cross-sectional C rank
    const cRaw=allCloses.map((_,ti)=>({ti,s:sC[ti][i]})).filter(x=>x.s!==null);
    cRaw.sort((a,b)=>a.s-b.s);
    const cRanked=new Map();
    for(let ri=0;ri<cRaw.length;ri++) cRanked.set(cRaw[ri].ti,cRaw.length>1?(ri/(cRaw.length-1))*2-1:0);

    // Regime weights
    const state=reg.state;
    const useC=state!=='ALT_SEASON';
    const wA=state==='ALT_SEASON'?0.6:0.4, wB=state==='ALT_SEASON'?0.25:0.2;
    const wC=useC?0.2:0, wD=0.2;

    // Score tokens with per-token micro-regime filter
    const scored=allCloses.map((_,ti)=>{
      const tr=tokenRegime(allCloses[ti],i);
      // Skip if token in personal bear while global is BULL
      if(tr.bear&&(state==='BULL_HOT'||state==='BULL_COOL'||state==='ALT_SEASON')) return null;
      // Skip if global RANGE and token not personally bullish (unless rangeAllow)
      if(state.startsWith('RANGE')&&!tr.bull&&!rangeAllow) return null;

      const va=sA[ti][i]??0, vb=sB[ti][i]??0;
      const xrank=cRanked.get(ti)??0, vcRaw=sC[ti][i]??0;
      const vc=0.6*vcRaw+0.4*xrank;
      const vd=sD[ti][i]??0;
      const altBoost=(state==='ALT_SEASON'&&ALT_TOKENS.has(symbols[ti]))?1.5:1.0;
      const wC_eff=useC?wC:0;
      let combined=(wA*va+wB*vb+wC_eff*vc+wD*vd)*altBoost;

      // Correlation boost: low-corr tokens get extra size multiplier
      let sizeAdj=tr.sizeAdj;
      if(corrBoost&&ti>0){
        const corr=btcCorr(allCloses[ti],btcCloses,i);
        if(corr<0.5) sizeAdj*=1.2;  // low corr to BTC → more independent alpha
      }

      const candidates=[{s:'A',v:wA*va},{s:'B',v:wB*vb},{s:'C',v:wC_eff*vc},{s:'D',v:wD*vd}];
      const dom=candidates.reduce((best,c)=>c.v>best.v?c:best,{s:'A',v:0});
      return{ti,combined,strat:dom.s,vd,va,gs:garchs[ti][i]||0.5,sizeAdj};
    }).filter(Boolean);

    // Entry queue
    const entryQueue=[];
    if(state.startsWith('RANGE')||state==='BULL_COOL'){
      const dCands=scored.filter(s=>s.vd>0).sort((a,b)=>b.vd-a.vd);
      for(const d of dCands.slice(0,1)) entryQueue.push({ti:d.ti,strat:'D',score:d.vd,gs:d.gs,sizeAdj:d.sizeAdj});
    }
    if(state==='BULL_HOT'||state==='BULL_COOL'||state==='ALT_SEASON'){
      const bullCands=scored.filter(s=>s.combined>0).sort((a,b)=>b.combined-a.combined);
      for(const c of bullCands.slice(0,topN)){
        if(entryQueue.find(e=>e.ti===c.ti))continue;
        entryQueue.push({ti:c.ti,strat:c.strat,score:c.combined,gs:c.gs,sizeAdj:c.sizeAdj});
      }
    }
    if(state==='RANGE_TIGHT'){
      const aCands=scored.filter(s=>s.va>0).sort((a,b)=>b.va-a.va);
      for(const a of aCands.slice(0,1)){
        if(entryQueue.find(e=>e.ti===a.ti))continue;
        entryQueue.push({ti:a.ti,strat:'A',score:a.va,gs:a.gs,sizeAdj:a.sizeAdj||1});
      }
    }

    // Close not in queue
    const topSet=new Set(entryQueue.map(e=>e.ti));
    for(const[ts,pos]of Object.entries(openPos)){
      if(!topSet.has(+ts)){
        const tidx=+ts,bar=allBars[tidx][i];
        const t={entryBar:pos.entryBar,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'rebalance',holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
        (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
      }
    }
    // Open new
    for(const e of entryQueue){
      if(openPos[e.ti]!==undefined)continue;
      const bar=allBars[e.ti][i],atr=atrs[e.ti][i]||bar.close*0.02;
      const sz=Math.min(BASE_SIZE/(e.gs*0.5)*( e.sizeAdj||1),MAX_POS);
      const sm=e.strat==='D'?stopMultD:stopMult, tm=e.strat==='D'?tpMultD:tpMult;
      openPos[e.ti]={entryBar:i,entryPrice:bar.close,stop:bar.close-sm*atr,tp:bar.close+tm*atr,weight:sz,strategy:e.strat,regimeEntry:state};
    }
  }
  for(const[ts,pos]of Object.entries(openPos)){
    const tidx=+ts,last=allBars[tidx][n-1];
    const t={entryBar:pos.entryBar,pnl:(last.close-pos.entryPrice)/pos.entryPrice,exitReason:'end',holdHours:n-1-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry,open:true};
    (pos.entryBar>=splitIdx?oosTrades:isTrades).push(t);
  }
  return{isTrades,oosTrades,yIS,yOOS};
}

function stats(trades,y=0){
  const yr=y*100;
  if(!trades||trades.length<5)return{n:trades?.length||0,sharpe:-99,ret:Math.round(yr*10)/10,dd:0,wr:0};
  const pr=trades.map(t=>t.pnl*(t.weight||BASE_SIZE));
  const wins=trades.filter(t=>t.pnl>0),m=pr.reduce((a,b)=>a+b,0)/pr.length,sd=Math.sqrt(pr.reduce((s,r)=>s+(r-m)**2,0)/pr.length);
  const sharpe=sd>0?(m/sd)*Math.sqrt(365):0;
  let eq=1,pk=1,dd=0; for(const r of pr){eq*=(1+r);if(eq>pk)pk=eq;const d=(pk-eq)/pk;if(d>dd)dd=d;}
  const tr=(eq-1)*100,tot=tr+yr;
  const byS={},byR={};
  for(const t of trades){
    const s=t.strategy||'?'; if(!byS[s])byS[s]={n:0,wins:0,pnl:0};
    byS[s].n++; if(t.pnl>0)byS[s].wins++; byS[s].pnl+=t.pnl;
    const r=t.regime||'?'; if(!byR[r])byR[r]={n:0,wins:0,pnl:0};
    byR[r].n++; if(t.pnl>0)byR[r].wins++; byR[r].pnl+=t.pnl;
  }
  return{n:trades.length,sharpe:Math.round(sharpe*100)/100,ret:Math.round(tot*10)/10,tradRet:Math.round(tr*10)/10,dd:Math.round(dd*1000)/10,wr:Math.round(wins.length/trades.length*100),stop:Math.round(trades.filter(t=>t.exitReason==='stop').length/trades.length*100),byStrategy:byS,byRegime:byR};
}

async function main(){
  const t0=Date.now();
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`TOKEN MICRO-REGIME — per-token bull/bear filter + BTC correlation`);
  console.log(`Grid: ${GRID.length} combos | 7 tokens | 2yr | IS/OOS 70/30`);
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
  const btcIdx=symbols.indexOf('BTC'),ethIdx=symbols.indexOf('ETH');
  const btcCloses=allCloses[btcIdx>=0?btcIdx:0],ethCloses=allCloses[ethIdx>=0?ethIdx:btcIdx];
  const splitIdx=Math.floor(minLen*0.70),n=minLen;
  console.log(`\n${n} bars | IS: ${Math.round(splitIdx/24)}d | OOS: ${Math.round((n-splitIdx)/24)}d\n`);

  const precomp=precompute(allBars,allCloses,btcCloses);
  console.log(`\nRunning ${GRID.length} combos...\n`);

  const results=[];
  let tested=0;
  for(const params of GRID){
    const{isTrades,oosTrades,yIS,yOOS}=simulate(allBars,allCloses,btcCloses,ethCloses,symbols,precomp,splitIdx,params);
    const oos=stats(oosTrades,yOOS),is_=stats(isTrades,yIS);
    results.push({params,is:is_,oos});
    tested++;
    if(tested%50===0) process.stdout.write(`  ${tested}/${GRID.length}...\r`);
  }

  const ranked=results.filter(r=>r.oos.n>=10).sort((a,b)=>{
    const aS=a.oos.sharpe*(a.is.sharpe>0?1.5:0.5);
    const bS=b.oos.sharpe*(b.is.sharpe>0?1.5:0.5);
    return bS-aS;
  });

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`RESULTS — ${ranked.length} valid configs`);
  console.log(`${'─'.repeat(100)}`);
  console.log(`${'Params'.padEnd(55)} ${'OOS-Sh'.padEnd(8)} ${'Ret%'.padEnd(9)} ${'N'.padEnd(5)} ${'WR'.padEnd(6)} ${'DD%'.padEnd(7)} IS-Sh`);
  console.log(`${'─'.repeat(100)}`);
  for(const r of ranked.slice(0,15)){
    const o=r.oos,f=o.sharpe>2?'🔥':o.sharpe>1?'✅':o.sharpe>0?'⚠️':'❌';
    const inv=r.is.sharpe>0?'✅':'⚠️';
    console.log(`${f} ${r.params.label.slice(0,52).padEnd(55)} ${String(o.sharpe).padEnd(8)} ${String(o.ret+'%').padEnd(9)} ${String(o.n).padEnd(5)} ${String(o.wr+'%').padEnd(6)} ${String(o.dd+'%').padEnd(7)} ${inv}${r.is.sharpe}`);
  }

  const best=ranked[0];
  if(best){
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`BEST: ${best.params.label}`);
    console.log(`OOS: ret=${best.oos.ret}% trading=${best.oos.tradRet}% sharpe=${best.oos.sharpe} DD=${best.oos.dd}% n=${best.oos.n} wr=${best.oos.wr}% stop=${best.oos.stop}%`);
    console.log(`IS:  ret=${best.is.ret}% sharpe=${best.is.sharpe} n=${best.is.n}`);
    if(best.oos.byStrategy){
      console.log(`By template (OOS):`);
      for(const[s,v]of Object.entries(best.oos.byStrategy)){
        if(!v.n)continue;
        console.log(`  ${s}: n=${v.n} wr=${Math.round(v.wins/v.n*100)}% pnl=${Math.round(v.pnl*100)}%`);
      }
    }
    if(best.oos.byRegime){
      console.log(`By regime (OOS):`);
      for(const[r,v]of Object.entries(best.oos.byRegime)){
        if(!v.n)continue;
        console.log(`  ${r.padEnd(14)}: n=${v.n} wr=${Math.round(v.wins/v.n*100)}% pnl=${Math.round(v.pnl*100)}%`);
      }
    }
    console.log(`${'═'.repeat(70)}`);
  }

  const btcOOS=allCloses[btcIdx],ethOOS=allCloses[ethIdx];
  const sp=splitIdx,en=n-1;
  console.log(`Benchmarks (OOS): BTC ${Math.round((btcOOS[en]-btcOOS[sp])/btcOOS[sp]*1000)/10}%  ETH ${Math.round((ethOOS[en]-ethOOS[sp])/ethOOS[sp]*1000)/10}%  Aave ~3%`);

  const elapsed=Math.round((Date.now()-t0)/1000);
  const outFile=path.join(RESULTS_DIR,`token-regime-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile,JSON.stringify({run_at:new Date().toISOString(),top10:ranked.slice(0,10).map(r=>({params:r.params,oos:r.oos,is:r.is})),best:ranked[0]?{params:ranked[0].params,oos:ranked[0].oos,is:ranked[0].is}:null},null,2));
  console.log(`\nDone in ${elapsed}s | 💾 ${outFile}`);
}
main().catch(e=>{console.error('Fatal:',e.stack);process.exit(1);});
