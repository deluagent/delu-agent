#!/usr/bin/env node
/**
 * delu deep backtest v3 — Full quant framework (fixed)
 *
 * Bug fix from v3.0: OOS slice was only 2628 bars but regime detection
 * needs 200d*24h=4800 bar warmup → all OOS = ERROR.
 * 
 * Proper walk-forward: run portfolio on FULL dataset, warm up all
 * indicators on full history, then split TRADES by IS/OOS timestamp.
 * This mirrors real-world: you have past data to warm up, then trade forward.
 *
 * Framework (TRADING_BRAIN.md):
 *   alpha_i = w_trend * trend_composite(20/60/120d)
 *           + w_vol_adj * (trend / ewma_vol)
 *           + w_z * (-z_score)  [mean reversion: low z = high score]
 *           + w_xrank * cross_sectional_rank
 *
 *   position_size = base_kelly / (ewma_vol * vol_target_scale)
 *   regime_filter = BTC trend regime + vol ratio
 *   rebalance daily, long top 2 by alpha score
 *   stops: 2.5x ATR, TP: 5x ATR (2:1 R/R)
 */

const fs = require('fs');
const path = require('path');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Universe (proven edge from v1) ──────────────────────────
const TOKENS = [
  { symbol: 'BTC',  binance: 'BTCUSDT' },
  { symbol: 'ETH',  binance: 'ETHUSDT' },
  { symbol: 'SOL',  binance: 'SOLUSDT' },
  { symbol: 'BNB',  binance: 'BNBUSDT' },
  { symbol: 'DOGE', binance: 'DOGEUSDT' },
  { symbol: 'AAVE', binance: 'AAVEUSDT' },
  { symbol: 'ARB',  binance: 'ARBUSDT' },
];

// ─── Factor Weight Grid ───────────────────────────────────────
// [w_trend, w_vol_adj_mom, w_z_reversion, w_cross_rank, vol_target_scale, regime_filter]
const FACTOR_GRID = [
  // Isolated factors (understand each one's contribution)
  [1.0, 0.0, 0.0, 0.0, 1.0, false],   // 1. pure trend composite only
  [0.0, 1.0, 0.0, 0.0, 1.0, false],   // 2. pure vol-adj momentum (Sharpe of returns)
  [0.0, 0.0, 1.0, 0.0, 1.0, false],   // 3. pure mean reversion (z-score)
  [0.0, 0.0, 0.0, 1.0, 1.0, false],   // 4. pure cross-sectional rank

  // Pairs
  [0.5, 0.5, 0.0, 0.0, 1.0, false],   // 5. trend + vol-adj (template A)
  [0.5, 0.0, 0.0, 0.5, 1.0, false],   // 6. trend + cross-rank (Jegadeesh-Titman)
  [0.0, 0.5, 0.5, 0.0, 1.0, false],   // 7. vol-adj + reversion
  [0.5, 0.0, 0.5, 0.0, 1.0, false],   // 8. trend + reversion

  // Full multi-factor combos (TRADING_BRAIN combined model)
  [0.4, 0.3, 0.2, 0.1, 1.0, false],   // 9.  full model, base sizing
  [0.4, 0.3, 0.2, 0.1, 1.5, false],   // 10. full model, moderate vol target
  [0.4, 0.3, 0.2, 0.1, 2.0, false],   // 11. full model, aggressive vol target
  [0.4, 0.3, 0.2, 0.1, 1.0, true],    // 12. full model + regime filter
  [0.4, 0.3, 0.2, 0.1, 1.5, true],    // 13. full model + regime + vol target

  // Weight variations on full model
  [0.2, 0.4, 0.2, 0.2, 1.0, false],   // 14. heavier vol-adj
  [0.2, 0.2, 0.4, 0.2, 1.0, false],   // 15. heavier mean reversion
  [0.2, 0.2, 0.2, 0.4, 1.0, false],   // 16. heavier cross-rank
  [0.6, 0.2, 0.1, 0.1, 1.0, false],   // 17. heavier trend
  [0.3, 0.4, 0.1, 0.2, 1.5, true],    // 18. vol-adj heavy + regime
  [0.4, 0.2, 0.3, 0.1, 1.0, true],    // 19. trend + reversion + regime
  [0.3, 0.3, 0.2, 0.2, 2.0, true],    // 20. balanced + aggressive vol tgt + regime
];

const IS_SPLIT  = 0.70;
const TOP_N     = 2;        // long top N tokens by alpha score
const BASE_SIZE = 0.20;     // base Half-Kelly per position
const REBAL_H   = 24;       // rebalance every 24h

// ─── Data fetch ───────────────────────────────────────────────
async function fetchBinance(symbol, daysBack = 365) {
  const totalCandles = daysBack * 24;
  let all = [], endTime = Date.now();
  while (all.length < totalCandles) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    const bars = data.map(d => ({
      ts: d[0], time: new Date(d[0]),
      open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5],
    }));
    all = [...bars, ...all];
    endTime = data[0][0] - 1;
    await sleep(200);
  }
  const seen = new Set();
  return all
    .filter(b => !seen.has(b.ts) && seen.add(b.ts))
    .sort((a, b) => a.ts - b.ts)
    .slice(-totalCandles);
}

// ─── Indicators (all computed on full bar array) ──────────────

// Trend composite: multi-horizon momentum (Moskowitz TSMOM)
// 0.5×r20d + 0.3×r60d + 0.2×r120d
function trendComposite(closes, i) {
  const n20 = 20*24, n60 = 60*24, n120 = 120*24;
  if (i < n120) return null;
  const r20  = (closes[i] - closes[i-n20])  / closes[i-n20];
  const r60  = (closes[i] - closes[i-n60])  / closes[i-n60];
  const r120 = (closes[i] - closes[i-n120]) / closes[i-n120];
  return 0.5*r20 + 0.3*r60 + 0.2*r120;
}

// EWMA volatility (RiskMetrics λ=0.94) — GARCH proxy
// σ²_t = (1-λ)·r²_t + λ·σ²_{t-1}
function ewmaVolAt(closes, i, lambda = 0.94) {
  if (i < 50) return null;
  let s2 = Math.pow(Math.log(closes[1] / closes[0]), 2);
  for (let j = 1; j <= i; j++) {
    const r = Math.log(closes[j] / closes[j-1]);
    s2 = (1 - lambda) * r * r + lambda * s2;
  }
  return Math.sqrt(s2 * 24 * 365);  // annualized from hourly
}

// Precompute all EWMA vols efficiently (one pass)
function precomputeEwmaVol(closes, lambda = 0.94) {
  const vols = new Array(closes.length).fill(null);
  let s2 = Math.pow(Math.log(closes[1] / closes[0]), 2);
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i-1]);
    s2 = (1 - lambda) * r * r + lambda * s2;
    if (i >= 50) vols[i] = Math.sqrt(s2 * 24 * 365);
  }
  return vols;
}

// Vol-adjusted momentum = trend_composite / ewma_vol (dimensionless Sharpe)
function volAdjMom(trend, vol) {
  if (trend === null || vol === null || vol < 0.01) return null;
  return trend / vol;
}

// Z-score: (price - mean_N) / std_N  (30d window)
function precomputeZScore(closes, window = 30*24) {
  const z = new Array(closes.length).fill(null);
  for (let i = window; i < closes.length; i++) {
    const slice = closes.slice(i - window, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length);
    z[i] = std > 0 ? (closes[i] - mean) / std : 0;
  }
  return z;
}

// ATR (14h)
function precomputeATR(bars, period = 14) {
  const atr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i-1].close),
      Math.abs(bars[i].low  - bars[i-1].close)
    );
    atr[i] = i < period ? tr : (atr[i-1] * (period-1) + tr) / period;
  }
  return atr;
}

// BTC regime: vol ratio (σ7d/σ30d) + trend (price vs 50d/200d SMA)
function precomputeRegime(btcCloses) {
  const n = btcCloses.length;
  const regime = new Array(n).fill(null);
  const n50  = 50*24, n200 = 200*24;
  const n7   = 7*24,  n30  = 30*24;

  for (let i = n200; i < n; i++) {
    // SMA 50 & 200
    const sma50  = btcCloses.slice(i-n50,  i+1).reduce((a,b)=>a+b,0) / (n50+1);
    const sma200 = btcCloses.slice(i-n200, i+1).reduce((a,b)=>a+b,0) / (n200+1);

    // Realized vol 7d and 30d
    const vol7  = (() => {
      const r = []; for(let j=i-n7+1;j<=i;j++) r.push(Math.log(btcCloses[j]/btcCloses[j-1]));
      const m=r.reduce((a,b)=>a+b,0)/r.length;
      return Math.sqrt(r.reduce((s,v)=>s+(v-m)**2,0)/r.length * 24*365);
    })();
    const vol30 = (() => {
      const r = []; for(let j=i-n30+1;j<=i;j++) r.push(Math.log(btcCloses[j]/btcCloses[j-1]));
      const m=r.reduce((a,b)=>a+b,0)/r.length;
      return Math.sqrt(r.reduce((s,v)=>s+(v-m)**2,0)/r.length * 24*365);
    })();

    regime[i] = {
      bull: btcCloses[i] > sma200,                // BTC above 200d MA = bull
      trending: btcCloses[i] > sma50,             // above 50d = trend intact
      volRatio: vol30 > 0 ? vol7 / vol30 : 1.0,  // >1.2 = elevated vol
      highVol: vol30 > 0 && (vol7/vol30) > 1.4,  // very elevated vol
    };
  }
  return regime;
}

// ─── Precompute all factors per token ────────────────────────
function precomputeFactors(allBars, allCloses, btcCloses) {
  const regime = precomputeRegime(btcCloses);
  const tokenFactors = allCloses.map((closes, tidx) => {
    const vols = precomputeEwmaVol(closes);
    const zscores = precomputeZScore(closes);
    const atr = precomputeATR(allBars[tidx]);
    const trends = closes.map((_, i) => trendComposite(closes, i));
    const vadjs  = trends.map((t, i) => volAdjMom(t, vols[i]));
    return { vols, zscores, atr, trends, vadjs };
  });
  return { regime, tokenFactors };
}

// ─── Alpha Score ──────────────────────────────────────────────
function alphaScore(tokenFactors, tidx, i, factors) {
  const [wTrend, wVadj, wZ, /*xrank applied outside*/, , ] = factors;
  const f = tokenFactors[tidx];

  const trend  = f.trends[i];
  const vadj   = f.vadjs[i];
  const z      = f.zscores[i];

  if (trend === null) return null;

  // Normalize via tanh → bounded [-1, 1]
  const trendN = Math.tanh(trend * 5);
  const vadjN  = vadj !== null ? Math.tanh(vadj * 1.5) : 0;
  const zN     = z !== null ? Math.tanh(-z * 0.7) : 0;  // inverted: low z = buy signal

  return wTrend * trendN + wVadj * vadjN + wZ * zN;
}

// ─── Portfolio Simulation ─────────────────────────────────────
// Run on FULL dataset, split trades by IS/OOS boundary index
function simulate(allBars, allCloses, btcCloses, tokenFactors, regime, factors, splitIdx) {
  const [, , , wXrank, volTargetScale, regimeAware] = factors;
  const n = allBars[0].length;
  const symbols = allBars.map((_, i) => i);

  const isTrades  = [];
  const oosTrades = [];
  let openPositions = {};  // tidx → position
  let lastRebal = 0;

  const WARMUP = 120*24 + 5;  // 120d for longest indicator

  for (let i = WARMUP; i < n; i++) {
    // ── Check stop/TP on all open positions ──────────────────
    for (const [tidxStr, pos] of Object.entries(openPositions)) {
      const tidx = +tidxStr;
      const bar = allBars[tidx][i];
      if (!bar) continue;

      let exitPrice = null, exitReason = null;
      if (bar.low <= pos.stopLoss)   { exitPrice = pos.stopLoss;   exitReason = 'stop'; }
      else if (bar.high >= pos.takeProfit) { exitPrice = pos.takeProfit; exitReason = 'tp'; }

      if (exitPrice !== null) {
        const trade = {
          tidx, entryBar: pos.entryBar, exitBar: i,
          entryPrice: pos.entryPrice, exitPrice,
          pnl: (exitPrice - pos.entryPrice) / pos.entryPrice,
          exitReason, holdHours: i - pos.entryBar,
          weight: pos.weight,
        };
        if (pos.entryBar < splitIdx) isTrades.push(trade);
        else oosTrades.push(trade);
        delete openPositions[tidxStr];
      }
    }

    // ── Rebalance every REBAL_H hours ────────────────────────
    if (i - lastRebal < REBAL_H) continue;
    lastRebal = i;

    // Regime filter
    if (regimeAware && regime[i]) {
      const reg = regime[i];
      // Skip ALL longs in: bear + high vol (worst environment)
      if (!reg.bull && reg.highVol) {
        // Close all positions
        for (const [tidxStr, pos] of Object.entries(openPositions)) {
          const tidx = +tidxStr;
          const bar = allBars[tidx][i];
          const trade = {
            tidx, entryBar: pos.entryBar, exitBar: i,
            entryPrice: pos.entryPrice, exitPrice: bar.close,
            pnl: (bar.close - pos.entryPrice) / pos.entryPrice,
            exitReason: 'regime_exit', holdHours: i - pos.entryBar,
            weight: pos.weight,
          };
          if (pos.entryBar < splitIdx) isTrades.push(trade);
          else oosTrades.push(trade);
          delete openPositions[tidxStr];
        }
        continue;
      }
    }

    // ── Compute alpha scores + cross-sectional rank ──────────
    const rawScores = [];
    for (let tidx = 0; tidx < allCloses.length; tidx++) {
      const base = alphaScore(tokenFactors, tidx, i, factors);
      if (base === null) continue;
      rawScores.push({ tidx, base });
    }
    if (rawScores.length < 2) continue;

    // Cross-sectional rank: rank from -1 (worst) to +1 (best)
    const sorted = [...rawScores].sort((a, b) => a.base - b.base);
    for (let ri = 0; ri < sorted.length; ri++) {
      sorted[ri].xrank = (ri / (sorted.length - 1)) * 2 - 1;  // [-1, +1]
    }
    // Final score
    for (const s of rawScores) {
      const xr = sorted.find(x => x.tidx === s.tidx)?.xrank ?? 0;
      s.final = (1 - wXrank) * s.base + wXrank * xr;
    }
    rawScores.sort((a, b) => b.final - a.final);

    // ── Close positions no longer in top N ───────────────────
    const topNSet = new Set(rawScores.slice(0, TOP_N).filter(s => s.final > 0).map(s => s.tidx));
    for (const [tidxStr, pos] of Object.entries(openPositions)) {
      if (!topNSet.has(+tidxStr)) {
        const tidx = +tidxStr;
        const bar = allBars[tidx][i];
        const trade = {
          tidx, entryBar: pos.entryBar, exitBar: i,
          entryPrice: pos.entryPrice, exitPrice: bar.close,
          pnl: (bar.close - pos.entryPrice) / pos.entryPrice,
          exitReason: 'rebalance', holdHours: i - pos.entryBar,
          weight: pos.weight,
        };
        if (pos.entryBar < splitIdx) isTrades.push(trade);
        else oosTrades.push(trade);
        delete openPositions[tidxStr];
      }
    }

    // ── Open top N positions ──────────────────────────────────
    for (const s of rawScores.slice(0, TOP_N)) {
      if (s.final <= 0) continue;  // no signal → skip
      if (openPositions[s.tidx] !== undefined) continue;  // already in

      const f = tokenFactors[s.tidx];
      const bar = allBars[s.tidx][i];
      const atr = f.atr[i] || (bar.close * 0.02);
      const vol = f.vols[i] || 0.5;

      // Vol-targeted position size (high vol = smaller bet)
      const size = Math.min(BASE_SIZE / (vol * volTargetScale), 0.40);

      openPositions[s.tidx] = {
        entryBar: i, entryPrice: bar.close,
        stopLoss:   bar.close - 2.5 * atr,
        takeProfit: bar.close + 5.0 * atr,  // 2:1 R/R
        weight: size,
      };
    }
  }

  // Close all remaining at end
  for (const [tidxStr, pos] of Object.entries(openPositions)) {
    const tidx = +tidxStr;
    const last = allBars[tidx][n-1];
    const trade = {
      tidx, entryBar: pos.entryBar, exitBar: n-1,
      entryPrice: pos.entryPrice, exitPrice: last.close,
      pnl: (last.close - pos.entryPrice) / pos.entryPrice,
      exitReason: 'end', holdHours: n-1 - pos.entryBar,
      weight: pos.weight, open: true,
    };
    if (pos.entryBar < splitIdx) isTrades.push(trade);
    else oosTrades.push(trade);
  }

  return { isTrades, oosTrades };
}

// ─── Statistics ───────────────────────────────────────────────
function calcStats(trades) {
  if (!trades || trades.length < 5) return { error: `only ${trades?.length ?? 0} trades` };

  // Portfolio P&L: each trade's contribution = pnl_pct × weight
  const portReturns = trades.map(t => t.pnl * (t.weight || BASE_SIZE));
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const mean = portReturns.reduce((a, b) => a + b, 0) / portReturns.length;
  const std  = Math.sqrt(portReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / portReturns.length);
  // Annualized Sharpe (trading at ~daily rebalance frequency)
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  let equity = 1, peak = 1, maxDD = 0;
  for (const r of portReturns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const totalReturnPct = (equity - 1) * 100;
  const avgWin  = wins.length   > 0 ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length*100 : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s,t)=>s+t.pnl,0)/losses.length*100) : 0;
  const pf = avgLoss > 0 ? (wins.length * avgWin) / (losses.length * avgLoss) : Infinity;

  return {
    n:              trades.length,
    winRate:        Math.round(wins.length / trades.length * 100),
    totalReturnPct: Math.round(totalReturnPct * 10) / 10,
    avgWinPct:      Math.round(avgWin * 100) / 100,
    avgLossPct:     Math.round(avgLoss * 100) / 100,
    profitFactor:   Math.round(pf * 100) / 100,
    sharpe:         Math.round(sharpe * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 1000) / 10,
    calmar:         maxDD > 0 ? Math.round(totalReturnPct / (maxDD * 100) * 100) / 100 : 0,
    avgHoldHours:   Math.round(trades.reduce((s,t)=>s+(t.holdHours||0),0) / trades.length),
    stopHitPct:     Math.round(trades.filter(t=>t.exitReason==='stop').length / trades.length * 100),
    tpHitPct:       Math.round(trades.filter(t=>t.exitReason==='tp').length / trades.length * 100),
    rebalancePct:   Math.round(trades.filter(t=>t.exitReason==='rebalance').length / trades.length * 100),
  };
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`delu DEEP backtest v3 — FULL QUANT FRAMEWORK`);
  console.log(`Proper walk-forward: warmup on full data, split trades by time`);
  console.log(`${new Date().toISOString()} | ${TOKENS.length} tokens | ${FACTOR_GRID.length} factor models`);
  console.log(`${'═'.repeat(65)}\n`);

  // ── Fetch data ─────────────────────────────────────────────
  console.log('Fetching 1yr hourly from Binance...');
  const rawData = [];
  for (const token of TOKENS) {
    process.stdout.write(`  [${token.symbol}] `);
    try {
      const bars = await fetchBinance(token.binance, 365);
      rawData.push({ symbol: token.symbol, bars });
      console.log(`${bars.length} bars ($${bars[0].close.toFixed(2)} → $${bars[bars.length-1].close.toFixed(2)})`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
    await sleep(300);
  }

  const valid = rawData.filter(d => d.bars?.length > 500);
  const minLen = Math.min(...valid.map(d => d.bars.length));
  const allBars   = valid.map(d => d.bars.slice(-minLen));
  const allCloses = allBars.map(b => b.map(x => x.close));
  const symbols   = valid.map(d => d.symbol);
  const btcIdx    = symbols.indexOf('BTC');
  const btcCloses = allCloses[btcIdx >= 0 ? btcIdx : 0];
  const splitIdx  = Math.floor(minLen * IS_SPLIT);

  console.log(`\nAligned: ${minLen} bars (${Math.round(minLen/24)}d) | IS: first ${Math.round(splitIdx/24)}d | OOS: last ${Math.round((minLen-splitIdx)/24)}d`);
  console.log('Precomputing all factors (EWMA vol, z-score, ATR, regime)...');

  // ── Precompute all indicators ──────────────────────────────
  const { regime, tokenFactors } = precomputeFactors(allBars, allCloses, btcCloses);

  const warmupBars = tokenFactors[0].trends.findIndex(t => t !== null);
  console.log(`Warmup complete. First valid bar: ${warmupBars} (${Math.round(warmupBars/24)}d)\n`);

  // ── Run all factor models ──────────────────────────────────
  const results = [];
  let totalTrades = 0;

  for (let fi = 0; fi < FACTOR_GRID.length; fi++) {
    const factors  = FACTOR_GRID[fi];
    const label    = `t=${factors[0]} va=${factors[1]} z=${factors[2]} xr=${factors[3]} vt=${factors[4]} reg=${factors[5]}`;
    const labelFull = `trend=${factors[0]} vol_adj=${factors[1]} z_rev=${factors[2]} x_rank=${factors[3]} vol_tgt=${factors[4]} regime=${factors[5]}`;

    const { isTrades, oosTrades } = simulate(allBars, allCloses, btcCloses, tokenFactors, regime, factors, splitIdx);
    const isStats  = calcStats(isTrades);
    const oosStats = calcStats(oosTrades);
    totalTrades += isTrades.length + oosTrades.length;

    results.push({ fi, label: labelFull, factors, isStats, oosStats, isN: isTrades.length, oosN: oosTrades.length });

    const oos = oosStats;
    const oosStr = oos.error
      ? `⚠️  ${oos.error}`
      : `sharpe=${oos.sharpe}  wr=${oos.winRate}%  ret=${oos.totalReturnPct}%  DD=${oos.maxDrawdownPct}%  PF=${oos.profitFactor}  stop=${oos.stopHitPct}%  tp=${oos.tpHitPct}%  (${oosTrades.length} trades)`;

    console.log(`[${String(fi+1).padStart(2)}/20] ${label}  |  OOS: ${oosStr}`);
  }

  // ── Results ────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`DONE — ${totalTrades.toLocaleString()} total trades | ${elapsed}s`);
  console.log(`${'═'.repeat(65)}`);

  const ranked = results
    .filter(r => !r.oosStats.error && r.oosN >= 5)
    .sort((a, b) => (b.oosStats.sharpe || -99) - (a.oosStats.sharpe || -99));

  console.log('\n🏆 ALL MODELS — ranked by OOS Sharpe:');
  console.log(`${'─'.repeat(105)}`);
  console.log(`Rank  ${'Model'.padEnd(50)} ${'N'.padEnd(5)} ${'Win%'.padEnd(6)} ${'Ret%'.padEnd(8)} ${'Sharpe'.padEnd(8)} ${'DD%'.padEnd(7)} ${'PF'.padEnd(7)} Stop%  TP%`);
  console.log(`${'─'.repeat(105)}`);
  for (let ri = 0; ri < ranked.length; ri++) {
    const r = ranked[ri];
    const o = r.oosStats;
    const medal = ri === 0 ? '🥇' : ri === 1 ? '🥈' : ri === 2 ? '🥉' : `  ${ri+1}.`;
    console.log(
      `${medal.padEnd(6)}${r.label.padEnd(50)} ` +
      `${String(r.oosN).padEnd(5)} ${String(o.winRate+'%').padEnd(6)} ` +
      `${String(o.totalReturnPct+'%').padEnd(8)} ${String(o.sharpe).padEnd(8)} ` +
      `${String(o.maxDrawdownPct+'%').padEnd(7)} ${String(o.profitFactor).padEnd(7)} ` +
      `${String(o.stopHitPct+'%').padEnd(7)}${o.tpHitPct}%`
    );
  }

  // IS→OOS degradation check
  console.log('\n📊 IS vs OOS Sharpe (degradation check):');
  console.log(`${'─'.repeat(65)}`);
  for (const r of ranked.slice(0, 10)) {
    const isS  = r.isStats.sharpe  || 0;
    const oosS = r.oosStats.sharpe || 0;
    const pct  = isS > 0 ? Math.round(oosS / isS * 100) : 0;
    const flag = pct >= 50 ? '✅' : pct >= 25 ? '⚠️' : '❌';
    console.log(`${flag} ${r.label.slice(0,45).padEnd(47)} IS=${isS}  OOS=${oosS}  (${pct}% retained)`);
  }

  // Best model
  if (ranked.length > 0) {
    const best = ranked[0];
    const o = best.oosStats;
    console.log(`\n🥇 BEST: ${best.label}`);
    console.log(`   OOS: n=${o.n}  winRate=${o.winRate}%  return=${o.totalReturnPct}%  Sharpe=${o.sharpe}  maxDD=${o.maxDrawdownPct}%  calmar=${o.calmar}`);
    console.log(`   IS:  n=${best.isStats.n}  sharpe=${best.isStats.sharpe}`);
  }

  // Factor contribution analysis
  console.log('\n🔬 FACTOR ATTRIBUTION (avg OOS Sharpe by factor weight):');
  const factorNames = ['trend', 'vol_adj_mom', 'z_reversion', 'cross_rank'];
  for (let fi = 0; fi < 4; fi++) {
    const high = ranked.filter(r => r.factors[fi] >= 0.4);
    const low  = ranked.filter(r => r.factors[fi] <= 0.1);
    const avgH = high.length > 0 ? high.reduce((s,r)=>s+(r.oosStats.sharpe||0),0)/high.length : null;
    const avgL = low.length  > 0 ? low.reduce((s,r)=>s+(r.oosStats.sharpe||0),0)/low.length   : null;
    if (avgH !== null && avgL !== null) {
      const edge = Math.round((avgH - avgL) * 100) / 100;
      const flag = edge > 0.1 ? '✅ contributes' : edge < -0.1 ? '❌ hurts' : '➖ neutral';
      console.log(`   ${factorNames[fi].padEnd(15)} high-weight avg=${Math.round(avgH*100)/100}  low-weight avg=${Math.round(avgL*100)/100}  edge=${edge} → ${flag}`);
    }
  }

  const outFile = path.join(RESULTS_DIR, `deep-v3-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(), version: '3.1',
    config: { tokens: symbols, nFactorModels: FACTOR_GRID.length, totalTrades, elapsed, splitIdx, warmupBars },
    ranked: ranked.map(r => ({
      fi: r.fi, label: r.label, factors: r.factors,
      isStats: r.isStats, oosStats: r.oosStats,
      isN: r.isN, oosN: r.oosN,
    })),
    allResults: results.map(r => ({
      fi: r.fi, label: r.label, isStats: r.isStats, oosStats: r.oosStats,
      isN: r.isN, oosN: r.oosN,
    })),
  }, null, 2));
  console.log(`\n💾 Saved: ${outFile} | Total trades: ${totalTrades.toLocaleString()}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
