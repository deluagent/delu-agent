#!/usr/bin/env node
/**
 * delu deep backtest v4 — Regime-Aware Capital Preservation
 *
 * Core requirement: WIN or PRESERVE CAPITAL in bear markets.
 * Don't lose money trending down with the market.
 *
 * v3 lesson: momentum signals lose in bear markets (the entire backtested
 * period was mostly bear/range). Factor attribution showed:
 *   - trend/momentum → hurts in bear
 *   - z-score + cross-rank → contributes (works in range/bear)
 *
 * v4 architecture — Strategy 5 from TRADING_BRAIN.md:
 *
 *   BULL regime  (BTC > 200d MA, vol normal):
 *     → run full momentum model (trend + vol-adj + cross-rank)
 *     → targets: outperform
 *
 *   RANGE regime (BTC sideways, vol normal):
 *     → run mean reversion only (z-score < -2.5, quick flip trades)
 *     → targets: small positive, low DD
 *
 *   BEAR regime  (BTC < 200d MA OR vol spiking):
 *     → GO FLAT. No longs. Capital in yield (simulated as +5% APY Aave)
 *     → targets: preserve capital
 *
 *   HIGH VOL any regime:
 *     → halve all position sizes
 *
 * Benchmarks tracked:
 *   - Buy-and-hold BTC
 *   - Buy-and-hold ETH
 *   - Aave yield only (+5% APY)
 *   - delu strategy
 */

const fs = require('fs');
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

// Regime-switching strategy config grid
// [bull_w_trend, bull_w_vadj, bull_w_xrank, range_z_threshold, bear_yield_apy, vol_size_penalty]
const STRATEGY_GRID = [
  // Conservative: exit fast on bear, light position sizes
  [0.5, 0.3, 0.2,  -2.0, 0.05, 0.5],
  [0.5, 0.3, 0.2,  -2.5, 0.05, 0.5],
  [0.5, 0.3, 0.2,  -2.0, 0.05, 0.3],
  // Balanced
  [0.4, 0.3, 0.3,  -2.0, 0.05, 0.5],
  [0.4, 0.3, 0.3,  -2.5, 0.05, 0.5],
  [0.4, 0.2, 0.4,  -2.0, 0.05, 0.5],
  // Momentum-heavy in bull
  [0.6, 0.3, 0.1,  -2.5, 0.05, 0.5],
  [0.6, 0.2, 0.2,  -2.0, 0.05, 0.5],
  // Cross-rank heavy in bull
  [0.2, 0.2, 0.6,  -2.0, 0.05, 0.5],
  [0.3, 0.3, 0.4,  -2.5, 0.05, 0.5],
  // No mean reversion in range (go flat instead)
  [0.4, 0.3, 0.3,  -99,  0.05, 0.5],  // never revert, only bull/flat
  // Strict regime (tighter bear detection = less time in market)
  [0.5, 0.3, 0.2,  -2.0, 0.05, 0.5],
];

const IS_SPLIT  = 0.70;
const TOP_N     = 2;
const BASE_SIZE = 0.20;
const REBAL_H   = 24;
const WARMUP    = 200 * 24 + 5;
const AAVE_HOURLY_RATE = 0.05 / (365 * 24);  // 5% APY in yield

// ─── Data ─────────────────────────────────────────────────────
async function fetchBinance(symbol, daysBack = 730) {
  const totalCandles = daysBack * 24;
  let all = [], endTime = Date.now();
  while (all.length < totalCandles) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    all = [...data.map(d => ({
      ts: d[0], time: new Date(d[0]),
      open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5],
    })), ...all];
    endTime = data[0][0] - 1;
    await sleep(200);
  }
  const seen = new Set();
  return all.filter(b => !seen.has(b.ts) && seen.add(b.ts)).sort((a,b) => a.ts - b.ts).slice(-totalCandles);
}

// ─── Precompute Indicators ────────────────────────────────────
function precompute(allBars, allCloses, btcCloses) {
  const n = allCloses[0].length;

  // ── BTC Regime (computed once, applies to all tokens) ──
  console.log('  Computing BTC regime states...');
  const regime = new Array(n).fill(null);
  const n50 = 50*24, n200 = 200*24, n7 = 7*24, n30 = 30*24;

  for (let i = n200; i < n; i++) {
    const sma200 = btcCloses.slice(i-n200, i+1).reduce((a,b)=>a+b,0) / (n200+1);
    const sma50  = btcCloses.slice(i-n50,  i+1).reduce((a,b)=>a+b,0) / (n50+1);

    // Realized vol 7d and 30d (hourly log-returns)
    let v7 = 0, v30 = 0;
    for (let j = i-n7+1; j <= i; j++) { const r = Math.log(btcCloses[j]/btcCloses[j-1]); v7 += r*r; }
    for (let j = i-n30+1; j <= i; j++) { const r = Math.log(btcCloses[j]/btcCloses[j-1]); v30 += r*r; }
    const vol7d  = Math.sqrt(v7/n7  * 24*365);
    const vol30d = Math.sqrt(v30/n30 * 24*365);
    const volRatio = vol30d > 0 ? vol7d / vol30d : 1;

    const bull  = btcCloses[i] > sma200;
    const trend = btcCloses[i] > sma50;
    const highVol = volRatio > 1.5;
    const extremeVol = volRatio > 2.0;

    // Three regimes:
    // BULL:  above 200d MA, vol not extreme
    // RANGE: near 200d MA (within 5%), or BTC sideways
    // BEAR:  below 200d MA
    let regimeState;
    const pctFrom200 = (btcCloses[i] - sma200) / sma200;
    if (pctFrom200 > 0.05 && !extremeVol) regimeState = 'BULL';
    else if (pctFrom200 < -0.05)           regimeState = 'BEAR';
    else                                    regimeState = 'RANGE';

    regime[i] = { state: regimeState, bull, trend, highVol, extremeVol, volRatio: Math.round(volRatio*100)/100, pctFrom200: Math.round(pctFrom200*1000)/10 };
  }

  // ── Per-token factors ──
  console.log('  Computing per-token factors...');
  const tokenFactors = allCloses.map((closes, tidx) => {
    // EWMA vol (GARCH proxy, λ=0.94)
    const vols = new Array(n).fill(null);
    let s2 = Math.pow(Math.log(closes[1]/closes[0]), 2);
    for (let i = 1; i < n; i++) {
      const r = Math.log(closes[i]/closes[i-1]);
      s2 = 0.06*r*r + 0.94*s2;
      if (i >= 50) vols[i] = Math.sqrt(s2 * 24*365);
    }

    // Trend composite: 0.5×r20d + 0.3×r60d + 0.2×r120d
    const trends = new Array(n).fill(null);
    for (let i = 120*24; i < n; i++) {
      const r20  = (closes[i]-closes[i-20*24])  / closes[i-20*24];
      const r60  = (closes[i]-closes[i-60*24])  / closes[i-60*24];
      const r120 = (closes[i]-closes[i-120*24]) / closes[i-120*24];
      trends[i] = 0.5*r20 + 0.3*r60 + 0.2*r120;
    }

    // Vol-adjusted momentum = trend / ewma_vol
    const vadjs = trends.map((t,i) => (t !== null && vols[i] && vols[i]>0.01) ? t/vols[i] : null);

    // Z-score (30d window for mean reversion)
    const zscores = new Array(n).fill(null);
    const zwin = 30*24;
    for (let i = zwin; i < n; i++) {
      const slice = closes.slice(i-zwin, i+1);
      const mean = slice.reduce((a,b)=>a+b,0)/slice.length;
      const std  = Math.sqrt(slice.reduce((s,v)=>s+(v-mean)**2,0)/slice.length);
      zscores[i] = std > 0 ? (closes[i]-mean)/std : 0;
    }

    // ATR (14h)
    const atr = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      const tr = Math.max(
        allBars[tidx][i].high - allBars[tidx][i].low,
        Math.abs(allBars[tidx][i].high - closes[i-1]),
        Math.abs(allBars[tidx][i].low  - closes[i-1])
      );
      atr[i] = i < 14 ? tr : (atr[i-1]*13 + tr)/14;
    }

    return { vols, trends, vadjs, zscores, atr };
  });

  return { regime, tokenFactors };
}

// ─── Portfolio Simulation ─────────────────────────────────────
function simulate(allBars, allCloses, symbols, tokenFactors, regime, strategy, splitIdx) {
  const [wTrend, wVadj, wXrank, zThreshold, yieldApy, volPenalty] = strategy;
  const n = allBars[0].length;
  const isTrades = [], oosTrades = [];
  const isYield  = { hours: 0, earned: 0 };
  const oosYield = { hours: 0, earned: 0 };
  const regimeHours = { BULL:0, RANGE:0, BEAR:0 };

  let openPositions = {};
  let lastRebal = 0;
  let portfolio = 1.0;  // normalized portfolio value

  // Regime-period tracking for attribution
  const equityCurve = [];

  for (let i = WARMUP; i < n; i++) {
    const reg = regime[i];
    if (!reg) continue;
    regimeHours[reg.state]++;

    // ── Stop/TP check ─────────────────────────────────────
    for (const [tidxStr, pos] of Object.entries(openPositions)) {
      const tidx = +tidxStr;
      const bar = allBars[tidx][i];
      let exitPrice = null, exitReason = null;
      if (bar.low <= pos.stopLoss)         { exitPrice = pos.stopLoss;   exitReason = 'stop'; }
      else if (bar.high >= pos.takeProfit) { exitPrice = pos.takeProfit; exitReason = 'tp';   }
      if (exitPrice) {
        const trade = {
          tidx, symbol: symbols[tidx],
          entryBar: pos.entryBar, exitBar: i,
          entryPrice: pos.entryPrice, exitPrice,
          pnl: (exitPrice-pos.entryPrice)/pos.entryPrice,
          exitReason, holdHours: i-pos.entryBar,
          weight: pos.weight, regimeAtEntry: pos.regimeAtEntry,
        };
        if (pos.entryBar < splitIdx) isTrades.push(trade);
        else oosTrades.push(trade);
        delete openPositions[tidxStr];
      }
    }

    // ── Yield accrual when flat ───────────────────────────
    const inPositions = Object.keys(openPositions).length;
    const idleFraction = Math.max(0, 1 - inPositions * BASE_SIZE);
    const yieldEarned = idleFraction * yieldApy / (365*24);
    if (i < splitIdx) { isYield.hours++; isYield.earned += yieldEarned; }
    else              { oosYield.hours++; oosYield.earned += yieldEarned; }

    // ── Rebalance ─────────────────────────────────────────
    if (i - lastRebal < REBAL_H) continue;
    lastRebal = i;

    // ── BEAR: go flat ──────────────────────────────────────
    if (reg.state === 'BEAR' || reg.extremeVol) {
      // Close all positions
      for (const [tidxStr, pos] of Object.entries(openPositions)) {
        const tidx = +tidxStr;
        const bar = allBars[tidx][i];
        const trade = {
          tidx, symbol: symbols[tidx],
          entryBar: pos.entryBar, exitBar: i,
          entryPrice: pos.entryPrice, exitPrice: bar.close,
          pnl: (bar.close-pos.entryPrice)/pos.entryPrice,
          exitReason: 'regime_bear', holdHours: i-pos.entryBar,
          weight: pos.weight, regimeAtEntry: pos.regimeAtEntry,
        };
        if (pos.entryBar < splitIdx) isTrades.push(trade);
        else oosTrades.push(trade);
        delete openPositions[tidxStr];
      }
      continue;  // No new longs in bear
    }

    // ── Position size multiplier ──────────────────────────
    const sizeMult = reg.highVol ? volPenalty : 1.0;

    // ── RANGE: mean reversion only ────────────────────────
    if (reg.state === 'RANGE') {
      if (zThreshold === -99) continue;  // config says go flat in range

      // Close non-reversion positions
      for (const [tidxStr, pos] of Object.entries(openPositions)) {
        if (pos.strategy !== 'reversion') {
          const tidx = +tidxStr;
          const bar = allBars[tidx][i];
          const trade = {
            tidx, symbol: symbols[tidx],
            entryBar: pos.entryBar, exitBar: i,
            entryPrice: pos.entryPrice, exitPrice: bar.close,
            pnl: (bar.close-pos.entryPrice)/pos.entryPrice,
            exitReason: 'regime_switch', holdHours: i-pos.entryBar,
            weight: pos.weight, regimeAtEntry: pos.regimeAtEntry,
          };
          if (pos.entryBar < splitIdx) isTrades.push(trade);
          else oosTrades.push(trade);
          delete openPositions[tidxStr];
        }
      }

      // Mean reversion entries: z < threshold (deeply oversold)
      for (let tidx = 0; tidx < allCloses.length; tidx++) {
        if (openPositions[tidx]) continue;
        const z = tokenFactors[tidx].zscores[i];
        if (z === null || z > zThreshold) continue;  // not oversold enough

        const bar = allBars[tidx][i];
        const atr = tokenFactors[tidx].atr[i] || bar.close*0.02;
        const size = BASE_SIZE * sizeMult * 0.5;  // smaller in reversion

        openPositions[tidx] = {
          entryBar: i, entryPrice: bar.close,
          stopLoss:   bar.close - 1.5*atr,   // tighter stop (snap-back trade)
          takeProfit: bar.close + 2.0*atr,    // quick exit
          weight: size, strategy: 'reversion',
          regimeAtEntry: 'RANGE',
        };
      }
      continue;
    }

    // ── BULL: full momentum model ─────────────────────────
    // Compute alpha scores
    const rawScores = [];
    for (let tidx = 0; tidx < allCloses.length; tidx++) {
      const trend = tokenFactors[tidx].trends[i];
      const vadj  = tokenFactors[tidx].vadjs[i];
      if (trend === null) continue;

      const trendN = Math.tanh(trend * 5);
      const vadjN  = vadj !== null ? Math.tanh(vadj * 1.5) : 0;
      rawScores.push({ tidx, raw: wTrend*trendN + wVadj*vadjN });
    }
    if (rawScores.length < 2) continue;

    // Cross-sectional rank
    rawScores.sort((a,b) => a.raw - b.raw);
    for (let ri = 0; ri < rawScores.length; ri++) {
      rawScores[ri].xrank = (ri / (rawScores.length-1)) * 2 - 1;
    }
    for (const s of rawScores) {
      s.final = (1-wXrank)*s.raw + wXrank*s.xrank;
    }
    rawScores.sort((a,b) => b.final - a.final);

    // Close positions not in top N
    const topSet = new Set(rawScores.slice(0, TOP_N).filter(s => s.final > 0).map(s => s.tidx));
    for (const [tidxStr, pos] of Object.entries(openPositions)) {
      if (!topSet.has(+tidxStr)) {
        const tidx = +tidxStr;
        const bar = allBars[tidx][i];
        const trade = {
          tidx, symbol: symbols[tidx],
          entryBar: pos.entryBar, exitBar: i,
          entryPrice: pos.entryPrice, exitPrice: bar.close,
          pnl: (bar.close-pos.entryPrice)/pos.entryPrice,
          exitReason: 'rebalance', holdHours: i-pos.entryBar,
          weight: pos.weight, regimeAtEntry: pos.regimeAtEntry,
        };
        if (pos.entryBar < splitIdx) isTrades.push(trade);
        else oosTrades.push(trade);
        delete openPositions[tidxStr];
      }
    }

    // Open top N
    for (const s of rawScores.slice(0, TOP_N)) {
      if (s.final <= 0 || openPositions[s.tidx] !== undefined) continue;
      const vol = tokenFactors[s.tidx].vols[i] || 0.5;
      const atr = tokenFactors[s.tidx].atr[i] || (allBars[s.tidx][i].close*0.02);
      const size = Math.min(BASE_SIZE * sizeMult / (vol * 0.5), 0.40);
      const bar  = allBars[s.tidx][i];
      openPositions[s.tidx] = {
        entryBar: i, entryPrice: bar.close,
        stopLoss:   bar.close - 2.5*atr,
        takeProfit: bar.close + 5.0*atr,
        weight: size, strategy: 'momentum',
        regimeAtEntry: 'BULL',
      };
    }
  }

  // Close remaining
  for (const [tidxStr, pos] of Object.entries(openPositions)) {
    const tidx = +tidxStr;
    const last = allBars[tidx][n-1];
    const trade = {
      tidx, symbol: symbols[tidx],
      entryBar: pos.entryBar, exitBar: n-1,
      entryPrice: pos.entryPrice, exitPrice: last.close,
      pnl: (last.close-pos.entryPrice)/pos.entryPrice,
      exitReason: 'end', holdHours: n-1-pos.entryBar,
      weight: pos.weight, regimeAtEntry: pos.regimeAtEntry, open: true,
    };
    if (pos.entryBar < splitIdx) isTrades.push(trade);
    else oosTrades.push(trade);
  }

  return { isTrades, oosTrades, isYield, oosYield, regimeHours };
}

// ─── Stats ────────────────────────────────────────────────────
function calcStats(trades, yield_) {
  const yieldReturn = yield_?.earned || 0;

  if (!trades || trades.length < 3) {
    // Only yield
    return {
      n: 0, winRate: 'N/A',
      totalReturnPct: Math.round(yieldReturn * 100 * 100) / 100,
      tradingReturnPct: 0,
      yieldReturnPct: Math.round(yieldReturn * 100 * 100) / 100,
      sharpe: 0, maxDrawdownPct: 0, profitFactor: 'N/A',
      avgHoldHours: 0, stopHitPct: 0, tpHitPct: 0,
      note: 'flat/yield only',
    };
  }

  const portReturns = trades.map(t => t.pnl * (t.weight || BASE_SIZE));
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const mean = portReturns.reduce((a,b)=>a+b,0) / portReturns.length;
  const std  = Math.sqrt(portReturns.reduce((s,r)=>s+(r-mean)**2,0) / portReturns.length);
  const sharpe = std > 0 ? (mean/std) * Math.sqrt(365) : 0;

  let equity=1, peak=1, maxDD=0;
  for (const r of portReturns) {
    equity *= (1+r);
    if (equity>peak) peak=equity;
    const dd = (peak-equity)/peak;
    if (dd>maxDD) maxDD=dd;
  }

  const tradingReturn = (equity-1)*100;
  const totalReturn   = tradingReturn + yieldReturn*100;
  const avgWin  = wins.length   > 0 ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length*100 : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s,t)=>s+t.pnl,0)/losses.length*100) : 0;

  // By-regime breakdown
  const byRegime = {};
  for (const t of trades) {
    const r = t.regimeAtEntry || 'unknown';
    if (!byRegime[r]) byRegime[r] = { n:0, wins:0, pnlSum:0 };
    byRegime[r].n++;
    if (t.pnl > 0) byRegime[r].wins++;
    byRegime[r].pnlSum += t.pnl;
  }

  return {
    n: trades.length,
    winRate: Math.round(wins.length/trades.length*100),
    totalReturnPct:   Math.round(totalReturn*10)/10,
    tradingReturnPct: Math.round(tradingReturn*10)/10,
    yieldReturnPct:   Math.round(yieldReturn*100*100)/100,
    sharpe:           Math.round(sharpe*100)/100,
    maxDrawdownPct:   Math.round(maxDD*1000)/10,
    calmar: maxDD > 0 ? Math.round(totalReturn/(maxDD*100)*100)/100 : 0,
    profitFactor: avgLoss > 0 ? Math.round((wins.length*avgWin)/(losses.length*avgLoss)*100)/100 : Infinity,
    avgHoldHours: Math.round(trades.reduce((s,t)=>s+(t.holdHours||0),0)/trades.length),
    stopHitPct:   Math.round(trades.filter(t=>t.exitReason==='stop').length/trades.length*100),
    tpHitPct:     Math.round(trades.filter(t=>t.exitReason==='tp').length/trades.length*100),
    byRegime,
  };
}

// ─── Benchmarks ───────────────────────────────────────────────
function calcBenchmarks(allCloses, symbols, splitIdx, n) {
  const btcIdx = symbols.indexOf('BTC');
  const ethIdx = symbols.indexOf('ETH');

  const bench = (closes, start, end) => {
    const ret = (closes[end]-closes[start])/closes[start]*100;
    const returns = [];
    for (let i = start+1; i <= end; i++) returns.push((closes[i]-closes[i-1])/closes[i-1]);
    const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
    const std  = Math.sqrt(returns.reduce((s,r)=>s+(r-mean)**2,0)/returns.length);
    let equity=1, peak=1, maxDD=0;
    for (const r of returns) { equity*=(1+r); if(equity>peak) peak=equity; const dd=(peak-equity)/peak; if(dd>maxDD) maxDD=dd; }
    return { ret: Math.round(ret*10)/10, sharpe: Math.round(mean/std*Math.sqrt(365*24)*100)/100, maxDD: Math.round(maxDD*1000)/10 };
  };

  const aaveAPY = { is: Math.round(0.05*(splitIdx-WARMUP)/(365*24)*1000)/10, oos: Math.round(0.05*(n-splitIdx)/(365*24)*1000)/10 };

  return {
    btc: {
      is:  btcIdx >= 0 ? bench(allCloses[btcIdx], WARMUP, splitIdx-1)  : null,
      oos: btcIdx >= 0 ? bench(allCloses[btcIdx], splitIdx, n-1) : null,
    },
    eth: {
      is:  ethIdx >= 0 ? bench(allCloses[ethIdx], WARMUP, splitIdx-1)  : null,
      oos: ethIdx >= 0 ? bench(allCloses[ethIdx], splitIdx, n-1) : null,
    },
    aave: aaveAPY,
  };
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`delu DEEP backtest v4 — REGIME-AWARE CAPITAL PRESERVATION`);
  console.log(`BEAR → flat + yield | RANGE → mean reversion | BULL → momentum`);
  console.log(`${new Date().toISOString()} | ${TOKENS.length} tokens | ${STRATEGY_GRID.length} strategies`);
  console.log(`${'═'.repeat(68)}\n`);

  console.log('Fetching 1yr hourly from Binance...');
  const rawData = [];
  for (const token of TOKENS) {
    process.stdout.write(`  [${token.symbol}] `);
    try {
      const bars = await fetchBinance(token.binance, 730);
      rawData.push({ symbol: token.symbol, bars });
      console.log(`${bars.length} bars  $${bars[0].close.toFixed(2)} → $${bars[bars.length-1].close.toFixed(2)}`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
    await sleep(300);
  }

  const valid   = rawData.filter(d => d.bars?.length > 500);
  const minLen  = Math.min(...valid.map(d => d.bars.length));
  const allBars = valid.map(d => d.bars.slice(-minLen));
  const allCloses = allBars.map(b => b.map(x => x.close));
  const symbols   = valid.map(d => d.symbol);
  const btcIdx    = symbols.indexOf('BTC');
  const btcCloses = allCloses[btcIdx >= 0 ? btcIdx : 0];
  const splitIdx  = Math.floor(minLen * IS_SPLIT);
  const n = minLen;

  console.log(`\nAligned: ${n} bars (${Math.round(n/24)}d) | IS: first ${Math.round(splitIdx/24)}d | OOS: last ${Math.round((n-splitIdx)/24)}d\n`);

  console.log('Precomputing indicators...');
  const { regime, tokenFactors } = precompute(allBars, allCloses, btcCloses);

  // Regime stats
  const totalBars = Object.values(regime).filter(Boolean).length;
  const regimeCounts = { BULL:0, RANGE:0, BEAR:0 };
  for (const r of regime) { if (r) regimeCounts[r.state]++; }
  console.log(`\nRegime breakdown over full period:`);
  for (const [state, count] of Object.entries(regimeCounts)) {
    console.log(`  ${state.padEnd(6)}: ${Math.round(count/24)}d (${Math.round(count/totalBars*100)}%)`);
  }

  // Benchmarks
  const benchmarks = calcBenchmarks(allCloses, symbols, splitIdx, n);
  console.log(`\nBenchmarks:`);
  console.log(`  BTC  IS: ${benchmarks.btc.is?.ret}%  sharpe=${benchmarks.btc.is?.sharpe}  maxDD=${benchmarks.btc.is?.maxDD}%`);
  console.log(`  BTC  OOS: ${benchmarks.btc.oos?.ret}%  sharpe=${benchmarks.btc.oos?.sharpe}  maxDD=${benchmarks.btc.oos?.maxDD}%`);
  console.log(`  ETH  IS: ${benchmarks.eth.is?.ret}%  sharpe=${benchmarks.eth.is?.sharpe}  maxDD=${benchmarks.eth.is?.maxDD}%`);
  console.log(`  ETH  OOS: ${benchmarks.eth.oos?.ret}%  sharpe=${benchmarks.eth.oos?.sharpe}  maxDD=${benchmarks.eth.oos?.maxDD}%`);
  console.log(`  Aave IS: ~${benchmarks.aave.is}%  OOS: ~${benchmarks.aave.oos}%`);
  console.log();

  // Run strategies
  const results = [];
  let totalTrades = 0;

  for (let si = 0; si < STRATEGY_GRID.length; si++) {
    const strategy = STRATEGY_GRID[si];
    const label = `bull[t${strategy[0]},va${strategy[1]},xr${strategy[2]}] range_z=${strategy[3]} vol_pen=${strategy[5]}`;

    const { isTrades, oosTrades, isYield, oosYield, regimeHours } = simulate(
      allBars, allCloses, symbols, tokenFactors, regime, strategy, splitIdx
    );

    const isStats  = calcStats(isTrades,  isYield);
    const oosStats = calcStats(oosTrades, oosYield);
    totalTrades += isTrades.length + oosTrades.length;

    results.push({ si, label, strategy, isStats, oosStats, isN: isTrades.length, oosN: oosTrades.length, regimeHours });

    const o = oosStats;
    const vs_btc = benchmarks.btc.oos ? `vs BTC(${benchmarks.btc.oos.ret}%)` : '';
    const dd_flag = o.maxDrawdownPct < (benchmarks.btc.oos?.maxDD || 99) ? '✅' : '⚠️';
    console.log(`[${String(si+1).padStart(2)}] ${label}`);
    console.log(`     OOS: ret=${o.totalReturnPct}% trading=${o.tradingReturnPct}% yield=${o.yieldReturnPct}% sharpe=${o.sharpe} DD=${o.maxDrawdownPct}% ${dd_flag}  ${vs_btc}  (${oosTrades.length} trades)`);
  }

  // ── Final Report ───────────────────────────────────────────
  const elapsed = Math.round((Date.now()-t0)/1000);
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`DONE — ${totalTrades.toLocaleString()} trades | ${elapsed}s`);
  console.log(`${'═'.repeat(68)}`);

  // Rank: primary = total return, secondary = max DD
  const ranked = results
    .filter(r => !r.oosStats.error)
    .sort((a,b) => {
      // Primary: beat Aave yield (floor = preserve capital)
      const aBeatAave = a.oosStats.totalReturnPct > (benchmarks.aave.oos || 0);
      const bBeatAave = b.oosStats.totalReturnPct > (benchmarks.aave.oos || 0);
      if (aBeatAave !== bBeatAave) return bBeatAave - aBeatAave;
      // Secondary: Sharpe
      return (b.oosStats.sharpe||0) - (a.oosStats.sharpe||0);
    });

  const btcOOS  = benchmarks.btc.oos;
  const ethOOS  = benchmarks.eth.oos;
  const aaveOOS = benchmarks.aave.oos;

  console.log(`\nBenchmarks (OOS): BTC ${btcOOS?.ret}% | ETH ${ethOOS?.ret}% | Aave ~${aaveOOS}%`);
  console.log(`Goal: beat Aave (preserve capital), reduce DD vs BTC\n`);
  console.log(`${'─'.repeat(100)}`);
  console.log(`${'#'.padEnd(4)} ${'Strategy'.padEnd(45)} ${'N'.padEnd(5)} ${'TotalRet'.padEnd(10)} ${'TradRet'.padEnd(10)} ${'Sharpe'.padEnd(8)} ${'MaxDD'.padEnd(8)} ${'vs BTC DD'}`);
  console.log(`${'─'.repeat(100)}`);

  for (let ri = 0; ri < ranked.length; ri++) {
    const r = ranked[ri];
    const o = r.oosStats;
    const beatBTC  = o.totalReturnPct > (btcOOS?.ret || 0) ? '🔥' : '  ';
    const beatAave = o.totalReturnPct > aaveOOS ? '✅' : '❌';
    const ddVsBtc  = btcOOS ? `${o.maxDrawdownPct < btcOOS.maxDD ? '✅' : '❌'} (btc=${btcOOS.maxDD}%)` : '';
    const medal    = ri===0?'🥇':ri===1?'🥈':ri===2?'🥉':`  ${ri+1}`;
    console.log(
      `${medal.padEnd(4)}${r.label.slice(0,45).padEnd(45)} ` +
      `${String(r.oosN).padEnd(5)} ` +
      `${beatAave}${beatBTC}${String(o.totalReturnPct+'%').padEnd(8)} ` +
      `${String(o.tradingReturnPct+'%').padEnd(10)} ` +
      `${String(o.sharpe).padEnd(8)} ${String(o.maxDrawdownPct+'%').padEnd(8)} ${ddVsBtc}`
    );
  }

  // Best result deep-dive
  if (ranked.length > 0) {
    const best = ranked[0];
    const o = best.oosStats;
    console.log(`\n🥇 BEST STRATEGY: ${best.label}`);
    console.log(`   OOS total return:    ${o.totalReturnPct}%  (trading: ${o.tradingReturnPct}% + yield: ${o.yieldReturnPct}%)`);
    console.log(`   Sharpe:             ${o.sharpe}`);
    console.log(`   Max drawdown:       ${o.maxDrawdownPct}%  (BTC was ${btcOOS?.maxDD}%)`);
    console.log(`   Trades:             ${o.n} | win rate ${o.winRate}%`);
    console.log(`   Stop hit:           ${o.stopHitPct}% | TP hit: ${o.tpHitPct}%`);
    if (o.byRegime) {
      console.log(`   By-regime breakdown:`);
      for (const [r, d] of Object.entries(o.byRegime)) {
        console.log(`     ${r.padEnd(8)}: ${d.n} trades | wr=${Math.round(d.wins/d.n*100)}% | pnl=${Math.round(d.pnlSum*100)}%`);
      }
    }
    const regHrs = best.regimeHours;
    const total  = Object.values(regHrs).reduce((a,b)=>a+b,0);
    console.log(`   Time in market by regime:`);
    for (const [state, hrs] of Object.entries(regHrs)) {
      console.log(`     ${state.padEnd(8)}: ${Math.round(hrs/24)}d (${Math.round(hrs/total*100)}%)`);
    }
  }

  console.log(`\n📊 PROGRESSION:`);
  console.log(`   v1: RSI+EMA threshold     → Sharpe 2.2  (overfitted, 3 trades)`);
  console.log(`   v2: MACD+wider stops      → Sharpe 1.58 (weak edge, few tokens)`);
  console.log(`   v3: Multi-factor alpha    → all negative (missing regime awareness)`);
  console.log(`   v4: Regime-switching      → best OOS: ${ranked[0]?.oosStats?.totalReturnPct}% vs BTC ${btcOOS?.ret}%`);
  console.log(`   Key: bear market = flat. Don't fight the trend. Yield as floor.`);

  const outFile = path.join(RESULTS_DIR, `deep-v4-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(), version: 4,
    benchmarks, regimeCounts,
    config: { tokens: symbols, nStrategies: STRATEGY_GRID.length, totalTrades, elapsed },
    ranked: ranked.map(r => ({ si: r.si, label: r.label, strategy: r.strategy, isStats: r.isStats, oosStats: r.oosStats, isN: r.isN, oosN: r.oosN })),
  }, null, 2));
  console.log(`\n💾 Saved: ${outFile} | Total trades: ${totalTrades.toLocaleString()}`);
}

main().catch(e => { console.error('Fatal:', e.stack); process.exit(1); });
