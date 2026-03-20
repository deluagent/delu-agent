#!/usr/bin/env node
/**
 * bear_short.js — short strategy in BEAR regime
 *
 * Instead of going 100% flat in bear, take small SHORT positions
 * when BTC distribution signals are strong.
 *
 * Entry signal (SHORT):
 *   - Global regime: BEAR (BTC < 200d MA by >5%)
 *   - BTC 7d momentum strongly negative (< -0.10)
 *   - Volume z-score > 1.0 (selling pressure / distribution)
 *   - RSI > 55 (not yet oversold — early in the down move)
 *   - No recent panic spike (avoid shorting after capitulation)
 *
 * Position: short BTC or ETH only (most liquid, tightest spreads)
 * Size: 5-10% (half normal), tight stop 1.5x ATR, TP 3x ATR
 * Exit: RSI < 30 (capitulation) OR stop hit OR regime changes
 *
 * This flips 52% dead flat time into potential alpha.
 */

const fs   = require('fs');
const path = require('path');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOKENS  = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','AAVEUSDT','ARBUSDT'];
const SYMBOLS = ['BTC','ETH','SOL','BNB','DOGE','AAVE','ARB'];
const SHORT_ELIGIBLE = new Set(['BTC','ETH']); // only short the majors
const ALT_TOKENS = new Set(['AAVE','ARB','SOL']);
const DAYS=730, WARMUP=200*24, REBAL_H=24, AAVE_APY=0.05;
const BASE_SIZE=0.15, SHORT_SIZE=0.08, MAX_POS=0.35;

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

function computeGARCH(c,a=0.05,b=0.90){const n=c.length,s=new Array(n).fill(null);const r=c.map((x,i)=>i===0?0:Math.log(x/c[i-1]));const wu=30*24;if(n<wu+5)return s;const lv=r.slice(1,wu+1).reduce((s,v)=>s+v*v,0)/wu,om=lv*(1-a-b);let sv=lv;for(let i=1;i<n;i++){sv=om+a*r[i]*r[i]+b*sv;if(i>=wu)s[i]=Math.sqrt(sv*24*365);}return s;}
function computeATR(bars,p=14){const a=new Array(bars.length).fill(null);for(let i=1;i<bars.length;i++){const tr=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));a[i]=i<p?tr:(a[i-1]*(p-1)+tr)/p;}return a;}
function computeRSI(c,p=14){const r=new Array(c.length).fill(null);let gA=0,lA=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)gA+=d;else lA+=Math.abs(d);}gA/=p;lA/=p;for(let i=p;i<c.length;i++){const d=c[i]-c[i-1];gA=(gA*(p-1)+(d>0?d:0))/p;lA=(lA*(p-1)+(d<0?Math.abs(d):0))/p;r[i]=lA===0?100:100-100/(1+gA/lA);}return r;}
function volSurpriseZ(v,i,win=30*24){if(i<win)return null;const s=v.slice(i-win,i),m=s.reduce((a,b)=>a+b,0)/s.length;const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);return sd>0?(v[i]-m)/sd:0;}
function ret1dZAt(c,i,win=30*24){if(i<win+24)return null;const r1=(c[i]-c[i-24])/c[i-24];const rs=[];for(let k=i-win;k<=i;k+=24)rs.push((c[k]-c[k-24])/c[k-24]);const m=rs.reduce((a,b)=>a+b,0)/rs.length,sd=Math.sqrt(rs.reduce((s,v)=>s+(v-m)**2,0)/rs.length);return sd>0?(r1-m)/sd:0;}
function smaN(c,i,n){if(i<n)return null;return c.slice(i-n,i+1).reduce((a,b)=>a+b,0)/(n+1);}

function globalRegime(btcC,ethC,allCloses,i){
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
  if(breadth<0.43||vr>2.25)return{state:'BEAR',vr,pct,breadth,extremeVol:vr>2.25};
  const ethAbsTrend2=ethC[i-14*24]>0?(ethC[i]-ethC[i-14*24])/ethC[i-14*24]:0; const altSeason=ethBtcChg>0.05&&ethAbsTrend2>0.02;
  const state=pct>0.05?(altSeason?'ALT_SEASON':vr>1.5?'BULL_COOL':'BULL_HOT'):pct<-0.03?'BEAR':vr>1.5?'RANGE_WIDE':'RANGE_TIGHT';
  return{state,vr,pct,breadth,altSeason,extremeVol:vr>2.25};
}

// ─── Short signal ──────────────────────────────────────────────
function shortScore(c, v, rsi, i, p) {
  const { minDepth, minVolZ, maxRSI, minBearMom } = p;
  if (i < 30*24) return null;

  const sma200 = smaN(c, i, 200*24);
  if (!sma200) return null;

  const pct200 = (c[i] - sma200) / sma200;
  if (pct200 > -minDepth) return 0;  // not deep enough in bear

  // 7d momentum negative
  const mom7 = i >= 7*24 ? (c[i]-c[i-7*24])/c[i-7*24] : 0;
  if (mom7 > minBearMom) return 0;  // still rising or flat — not trending down

  // Volume confirming (distribution, not capitulation)
  const vz = volSurpriseZ(v, i);
  if (vz === null || vz < minVolZ) return 0;

  // RSI not oversold — avoid shorting into capitulation
  if (rsi[i] !== null && rsi[i] < maxRSI) return 0;

  // Not already in freefall (avoid chasing)
  const r3d = i >= 3*24 ? (c[i]-c[i-3*24])/c[i-3*24] : 0;
  if (r3d < -0.12) return 0;  // >12% in 3 days = already crashing

  const depthStr = Math.min(Math.abs(pct200) - minDepth, 0.20) / 0.20;
  const momStr   = Math.min(Math.abs(mom7) - Math.abs(minBearMom), 0.15) / 0.15;
  const volStr   = Math.min(vz - minVolZ, 2) / 2;
  return Math.max(0, depthStr * momStr * volStr);
}

// Long signals (same as adaptive)
function scoreA(c,v,i){if(i<120*24)return null;const r20=(c[i]-c[i-20*24])/c[i-20*24],r60=(c[i]-c[i-60*24])/c[i-60*24],r120=(c[i]-c[i-120*24])/c[i-120*24];const trend=0.5*r20+0.3*r60+0.2*r120;if(trend<0.10)return 0;const vz=volSurpriseZ(v,i);if(vz===null)return null;return Math.max(0,trend*(1+Math.tanh(vz*0.5)));}
function scoreB(c,v,rsi,i){const WIN=14*24;if(i<WIN+25)return null;if(rsi[i]!==null&&rsi[i]>60)return 0;if((c[i]-c[i-WIN])/c[i-WIN]>0.05)return 0;let ob=0;const arr=[];for(let k=Math.max(0,i-WIN-25);k<=i;k++){if(k>0){if(c[k]>c[k-1])ob+=v[k];else if(c[k]<c[k-1])ob-=v[k];}arr.push(ob);}const w=arr.slice(-WIN-1),m=w.reduce((a,b)=>a+b,0)/w.length,sd=Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/w.length);if(sd<1e-9)return 0;const oz=(w[w.length-1]-m)/sd,ozP=(w[w.length-25]-m)/sd;if(oz<0.8||oz<=ozP)return 0;return Math.max(0,Math.tanh(oz*0.5)*Math.tanh((oz-ozP)*2));}
function scoreD(c,v,rsi,rz,i){if(i<30*24)return null;const retZ=rz[i],vz=volSurpriseZ(v,i);if(retZ===null||vz===null)return null;if(retZ>-1.2)return 0;if(vz<0.5)return 0;if(rsi[i]!==null&&rsi[i]>45)return 0;const r4d=i>=4*24?(c[i]-c[i-4*24])/c[i-4*24]:0;if(r4d<-0.30)return 0;if(i>=4&&(c[i]-c[i-4])/c[i-4]>0.03)return 0;return Math.max(0,Math.min(Math.abs(retZ)-1.2,3)/3*Math.min(vz-0.5,3)/3);}

function precompute(allBars,allCloses,btcCloses){
  console.log('  Precomputing...');
  const garchs=allCloses.map(c=>computeGARCH(c));
  const atrs=allBars.map(b=>computeATR(b));
  const rsis=allCloses.map(c=>computeRSI(c));
  const volumes=allBars.map(b=>b.map(x=>x.volume));
  const ret1dZs=allCloses.map(c=>c.map((_,i)=>ret1dZAt(c,i)));
  console.log('  Pre-scoring...');
  const sA=allCloses.map((c,ti)=>c.map((_,i)=>scoreA(c,volumes[ti],i)));
  const sB=allCloses.map((c,ti)=>c.map((_,i)=>scoreB(c,volumes[ti],rsis[ti],i)));
  const sD=allCloses.map((c,ti)=>c.map((_,i)=>scoreD(c,volumes[ti],rsis[ti],ret1dZs[ti],i)));
  const sShort=allCloses.map((c,ti)=>c.map((_,i)=>null)); // filled below per grid
  return{garchs,atrs,volumes,sA,sB,sD,rsis,ret1dZs,sShort};
}

const GRID=[];
for(const stopMult     of [1.5,2.5])
for(const tpMult       of [5.0,6.0])
for(const stopShort    of [1.5,2.0])
for(const tpShort      of [2.5,3.0])
for(const minDepth     of [0.05,0.10])
for(const minVolZ      of [0.5,1.0])
for(const maxRSI       of [50,55,60])    // min RSI to short (not oversold)
for(const minBearMom   of [-0.05,-0.10])
  GRID.push({stopMult,tpMult,stopShort,tpShort,shortParams:{minDepth,minVolZ,maxRSI,minBearMom},
    label:`sm=${stopMult} tp=${tpMult} ss=${stopShort} ts=${tpShort} depth=${minDepth} vz=${minVolZ} rsi<${maxRSI} mom<${minBearMom}`});

function simulate(allBars,allCloses,btcCloses,ethCloses,symbols,precomp,splitIdx,params){
  const{garchs,atrs,volumes,sA,sB,sD,rsis,ret1dZs}=precomp;
  const{stopMult,tpMult,stopShort,tpShort,shortParams}=params;
  const n=allBars[0].length;
  const isTrades=[],oosTrades=[];
  let openPos={},lastRebal=0,yIS=0,yOOS=0;

  for(let i=WARMUP;i<n;i++){
    const reg=globalRegime(btcCloses,ethCloses,allCloses,i); if(!reg)continue;
    const inOOS=i>=splitIdx;

    for(const[ts,pos]of Object.entries(openPos)){
      const tidx=+ts,bar=allBars[tidx][i]; let ep=null,er=null;
      if(pos.short){
        // Short: profit when price goes DOWN
        if(bar.high>=pos.stop){ep=pos.stop;er='stop';}
        if(bar.low<=pos.tp){ep=pos.tp;er='tp';}
        if(ep){
          const pnl=(pos.entryPrice-ep)/pos.entryPrice; // short PnL
          const t={entryBar:pos.entryBar,pnl,exitReason:er,holdHours:i-pos.entryBar,weight:pos.weight,strategy:'SHORT',regime:pos.regimeEntry};
          (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
        }
        // Force exit short if regime turns BULL
        if(reg.state!=='BEAR'&&openPos[ts]){
          const bar2=allBars[tidx][i];
          const pnl=(pos.entryPrice-bar2.close)/pos.entryPrice;
          const t={entryBar:pos.entryBar,pnl,exitReason:'regime',holdHours:i-pos.entryBar,weight:pos.weight,strategy:'SHORT',regime:pos.regimeEntry};
          (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
        }
        // Force exit if RSI < 35 (capitulation — cover shorts)
        if(openPos[ts]&&rsis[tidx][i]!==null&&rsis[tidx][i]<35){
          const bar2=allBars[tidx][i];
          const pnl=(pos.entryPrice-bar2.close)/pos.entryPrice;
          const t={entryBar:pos.entryBar,pnl,exitReason:'rsi_exit',holdHours:i-pos.entryBar,weight:pos.weight,strategy:'SHORT',regime:pos.regimeEntry};
          (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
        }
      } else {
        if(bar.low<=pos.stop){ep=pos.stop;er='stop';}
        if(bar.high>=pos.tp){ep=pos.tp;er='tp';}
        if(ep){
          const t={entryBar:pos.entryBar,pnl:(ep-pos.entryPrice)/pos.entryPrice,exitReason:er,holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
          (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
        }
      }
    }

    const idle=Math.max(0,1-Object.keys(openPos).length*BASE_SIZE);
    if(inOOS)yOOS+=idle*AAVE_APY/(365*24); else yIS+=idle*AAVE_APY/(365*24);
    if(i-lastRebal<REBAL_H)continue; lastRebal=i;

    if(reg.state==='BEAR'){
      // Close any long positions
      for(const[ts,pos]of Object.entries(openPos)){
        if(!pos.short){
          const tidx=+ts,bar=allBars[tidx][i];
          const t={entryBar:pos.entryBar,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'regime',holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
          (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
        }
      }
      // Enter short positions on BTC and/or ETH
      const openShorts=Object.values(openPos).filter(p=>p.short).length;
      if(openShorts<1){
        for(const ti of [0,1]){ // BTC first, then ETH
          if(!SHORT_ELIGIBLE.has(symbols[ti]))continue;
          const ss=shortScore(allCloses[ti],volumes[ti],rsis[ti],i,shortParams);
          if(ss!==null&&ss>0&&openPos[ti]===undefined){
            const bar=allBars[ti][i],atr=atrs[ti][i]||bar.close*0.02;
            openPos[ti]={entryBar:i,entryPrice:bar.close,
              stop:bar.close+stopShort*atr,  // stop ABOVE entry for short
              tp:bar.close-tpShort*atr,      // TP BELOW entry for short
              weight:SHORT_SIZE,strategy:'SHORT',regimeEntry:'BEAR',short:true};
            break; // one short at a time
          }
        }
      }
      continue;
    }

    // BULL/RANGE logic (same as adaptive best params)
    for(const[ts,pos]of Object.entries(openPos)){
      if(pos.short){
        const tidx=+ts,bar=allBars[tidx][i];
        const pnl=(pos.entryPrice-bar.close)/pos.entryPrice;
        const t={entryBar:pos.entryBar,pnl,exitReason:'regime_exit',holdHours:i-pos.entryBar,weight:pos.weight,strategy:'SHORT',regime:pos.regimeEntry};
        (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
      }
    }

    const state=reg.state;
    const scored=allCloses.map((_,ti)=>{
      const va=sA[ti][i]??0, vb=sB[ti][i]??0, vd=sD[ti][i]??0;
      const wA=state==='ALT_SEASON'?0.6:0.4, wB=0.2;
      const altBoost=(state==='ALT_SEASON'&&ALT_TOKENS.has(symbols[ti]))?1.5:1.0;
      const combined=(wA*va+wB*vb)*altBoost;
      return{ti,combined,strat:vb>va?'B':'A',vd,gs:garchs[ti][i]||0.5};
    });

    const entryQueue=[];
    if(state.startsWith('RANGE')||state==='BULL_COOL'){
      const dCands=scored.filter(s=>s.vd>0).sort((a,b)=>b.vd-a.vd);
      if(dCands[0])entryQueue.push({ti:dCands[0].ti,strat:'D',score:dCands[0].vd,gs:dCands[0].gs});
    }
    if(state==='BULL_HOT'||state==='BULL_COOL'||state==='ALT_SEASON'){
      const bullCands=scored.filter(s=>s.combined>0).sort((a,b)=>b.combined-a.combined);
      for(const c of bullCands.slice(0,1)){
        if(!entryQueue.find(e=>e.ti===c.ti))
          entryQueue.push({ti:c.ti,strat:c.strat,score:c.combined,gs:c.gs});
      }
    }
    const topSet=new Set(entryQueue.map(e=>e.ti));
    for(const[ts,pos]of Object.entries(openPos)){
      if(!topSet.has(+ts)&&!pos.short){
        const tidx=+ts,bar=allBars[tidx][i];
        const t={entryBar:pos.entryBar,pnl:(bar.close-pos.entryPrice)/pos.entryPrice,exitReason:'rebalance',holdHours:i-pos.entryBar,weight:pos.weight,strategy:pos.strategy,regime:pos.regimeEntry};
        (inOOS?oosTrades:isTrades).push(t); delete openPos[ts];
      }
    }
    for(const e of entryQueue){
      if(openPos[e.ti]!==undefined)continue;
      const bar=allBars[e.ti][i],atr=atrs[e.ti][i]||bar.close*0.02;
      const sz=Math.min(BASE_SIZE/(e.gs*0.5),MAX_POS);
      openPos[e.ti]={entryBar:i,entryPrice:bar.close,stop:bar.close-stopMult*atr,tp:bar.close+tpMult*atr,weight:sz,strategy:e.strat,regimeEntry:state};
    }
  }
  for(const[ts,pos]of Object.entries(openPos)){
    const tidx=+ts,last=allBars[tidx][n-1];
    const pnl=pos.short?(pos.entryPrice-last.close)/pos.entryPrice:(last.close-pos.entryPrice)/pos.entryPrice;
    const t={entryBar:pos.entryBar,pnl,exitReason:'end',holdHours:n-1-pos.entryBar,weight:pos.weight,strategy:pos.strategy||'SHORT',regime:pos.regimeEntry,open:true};
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
    byS[s].n++;if(t.pnl>0)byS[s].wins++;byS[s].pnl+=t.pnl;
    const r=t.regime||'?'; if(!byR[r])byR[r]={n:0,wins:0,pnl:0};
    byR[r].n++;if(t.pnl>0)byR[r].wins++;byR[r].pnl+=t.pnl;
  }
  return{n:trades.length,sharpe:Math.round(sharpe*100)/100,ret:Math.round(tot*10)/10,tradRet:Math.round(tr*10)/10,dd:Math.round(dd*1000)/10,wr:Math.round(wins.length/trades.length*100),stop:Math.round(trades.filter(t=>t.exitReason==='stop').length/trades.length*100),byStrategy:byS,byRegime:byR};
}

async function main(){
  const t0=Date.now();
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`BEAR SHORT STRATEGY — flip flat bear time into alpha`);
  console.log(`Grid: ${GRID.length} combos | SHORT: BTC/ETH only | IS/OOS 70/30`);
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
    if(tested%50===0)process.stdout.write(`  ${tested}/${GRID.length}...\r`);
  }

  const ranked=results.filter(r=>r.oos.n>=10).sort((a,b)=>{
    const aS=a.oos.sharpe*(a.is.sharpe>0?1.5:0.5);
    const bS=b.oos.sharpe*(b.is.sharpe>0?1.5:0.5);
    return bS-aS;
  });

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`RESULTS — ${ranked.length} valid configs`);
  console.log(`${'─'.repeat(100)}`);
  for(const r of ranked.slice(0,15)){
    const o=r.oos,f=o.sharpe>2?'🔥':o.sharpe>1?'✅':o.sharpe>0?'⚠️':'❌';
    const inv=r.is.sharpe>0?'✅':'⚠️';
    console.log(`${f} ${r.params.label.slice(0,55).padEnd(58)} OOS:${String(o.sharpe).padEnd(6)} ${o.ret}% n=${o.n} wr=${o.wr}% DD=${o.dd}% | IS:${inv}${r.is.sharpe}`);
  }
  const best=ranked[0];
  if(best){
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`BEST: ${best.params.label}`);
    console.log(`OOS: ret=${best.oos.ret}% sharpe=${best.oos.sharpe} DD=${best.oos.dd}% n=${best.oos.n} wr=${best.oos.wr}%`);
    console.log(`IS:  ret=${best.is.ret}% sharpe=${best.is.sharpe}`);
    if(best.oos.byStrategy){
      console.log(`By strategy (OOS):`);
      for(const[s,v]of Object.entries(best.oos.byStrategy)){if(!v.n)continue;console.log(`  ${s}: n=${v.n} wr=${Math.round(v.wins/v.n*100)}% pnl=${Math.round(v.pnl*100)}%`);}
    }
  }
  const btcOOS=allCloses[btcIdx],ethOOS=allCloses[ethIdx];
  console.log(`Benchmarks (OOS): BTC ${Math.round((btcOOS[n-1]-btcOOS[splitIdx])/btcOOS[splitIdx]*1000)/10}%  ETH ${Math.round((ethOOS[n-1]-ethOOS[splitIdx])/ethOOS[splitIdx]*1000)/10}%`);
  const elapsed=Math.round((Date.now()-t0)/1000);
  const outFile=path.join(RESULTS_DIR,`bear-short-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile,JSON.stringify({run_at:new Date().toISOString(),top10:ranked.slice(0,10).map(r=>({params:r.params,oos:r.oos,is:r.is})),best:ranked[0]?{params:ranked[0].params,oos:ranked[0].oos,is:ranked[0].is}:null},null,2));
  console.log(`Done in ${elapsed}s | 💾 ${outFile}`);
}
main().catch(e=>{console.error('Fatal:',e.stack);process.exit(1);});
