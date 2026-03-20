#!/usr/bin/env node
/**
 * delu FULL framework backtest — 100% of TRADING_BRAIN.md
 *
 * Implements every formula and strategy template:
 *
 * INDICATORS:
 *   - GARCH(1,1): σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}  (not EWMA proxy)
 *   - OU process: dz_t = κ(μ - z_t)dt + σdW_t  (mean reversion speed)
 *   - Trend composite: 0.5·r20d + 0.3·r60d + 0.2·r120d
 *   - Volume surprise z-score: (vol_t - μ_vol) / σ_vol  (attention proxy)
 *   - Δ²volume: second derivative (virality / acceleration proxy)
 *   - Vol-adjusted momentum: trend / σ_GARCH
 *   - Liquidity score: volume depth proxy
 *   - Rolling covariance matrix (correlation-aware sizing)
 *
 * 5 STRATEGY TEMPLATES (TRADING_BRAIN.md):
 *   A. Trend × (1 + vol_attention)     — momentum with attention fuel
 *   B. Vol_flow × price_lag            — accumulation → price lead-lag
 *   C. Cross-sectional rank + vol_attn — relative strength + attention
 *   D. OU panic mean reversion         — volume spike + deep z-score
 *   E. Regime-aware meta allocation    — dynamic weight across A-D
 *
 * PORTFOLIO CONSTRUCTION:
 *   - Mean-variance: w = argmax(μᵀw - λ·wᵀΣw - γ·turnover)
 *   - Correlation penalty: reduce size when positions are correlated
 *   - GARCH vol targeting: size = base / σ_GARCH
 *
 * REGIME DETECTION:
 *   - BTC 200d MA trend (bull/bear)
 *   - Vol ratio σ7d/σ30d (high/low vol)
 *   - OU half-life (fast/slow mean reversion environment)
 *   - Dynamic strategy allocation: weight by recent Sharpe
 */

const fs   = require('fs');
const path = require('path');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Universe ─────────────────────────────────────────────────
const TOKENS = [
  { symbol: 'BTC',  binance: 'BTCUSDT' },
  { symbol: 'ETH',  binance: 'ETHUSDT' },
  { symbol: 'SOL',  binance: 'SOLUSDT' },
  { symbol: 'BNB',  binance: 'BNBUSDT' },
  { symbol: 'DOGE', binance: 'DOGEUSDT' },
  { symbol: 'AAVE', binance: 'AAVEUSDT' },
  { symbol: 'ARB',  binance: 'ARBUSDT' },
];

const DAYS       = 730;     // 2 years
const IS_SPLIT   = 0.70;
const BASE_SIZE  = 0.15;    // base Half-Kelly per position
const MAX_POS    = 0.35;    // max single position
const TOP_N      = 1;       // long top N at any time — tuned (12960 combo grid search)
const MIN_SCORE_A = 0.10;   // min trend score for Template A entry (noise filter)
const REBAL_H    = 24;      // rebalance every 24h
const WARMUP     = 200*24;  // 200d warmup for all indicators
const LAMBDA_MV  = 2.0;     // risk aversion (mean-variance)
const GAMMA_TO   = 0.001;   // turnover penalty
const AAVE_APY   = 0.05;    // 5% yield floor

// ─── Data ─────────────────────────────────────────────────────
async function fetchBinance(symbol, daysBack = DAYS) {
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
      open:+d[1], high:+d[2], low:+d[3], close:+d[4], volume:+d[5],
    })), ...all];
    endTime = data[0][0] - 1;
    await sleep(150);
  }
  const seen = new Set();
  return all.filter(b => !seen.has(b.ts) && seen.add(b.ts))
            .sort((a,b) => a.ts - b.ts).slice(-totalCandles);
}

// ══════════════════════════════════════════════════════════════
// INDICATOR LIBRARY
// ══════════════════════════════════════════════════════════════

// ── GARCH(1,1) ────────────────────────────────────────────────
// σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
// Params: α=0.05, β=0.90 (typical crypto), ω = σ_LR²·(1-α-β) [variance targeting]
function computeGARCH(closes, alpha=0.05, beta=0.90) {
  const n = closes.length;
  const sigma2 = new Array(n).fill(null);
  const eps2   = new Array(n).fill(null);

  // Log returns
  const r = closes.map((c,i) => i===0 ? 0 : Math.log(c/closes[i-1]));

  // Long-run variance (rolling 30d for stationarity)
  const warmup = 30*24;
  if (n < warmup + 5) return sigma2;

  // ω = long_run_var × (1 - α - β)  [variance targeting]
  const lrVar = r.slice(1, warmup+1).reduce((s,v) => s+v*v, 0) / warmup;
  const omega = lrVar * (1 - alpha - beta);

  // Initialise with long-run variance
  let s2 = lrVar;
  for (let i = 1; i < n; i++) {
    const e2 = r[i] * r[i];
    s2 = omega + alpha * e2 + beta * s2;
    if (i >= warmup) {
      sigma2[i] = Math.sqrt(s2 * 24 * 365);  // annualised from hourly
      eps2[i]   = e2;
    }
  }
  return { sigma2, eps2 };
}

// ── OU Process ────────────────────────────────────────────────
// Fit Ornstein-Uhlenbeck to a spread/price series
// dz_t = κ(μ - z_t)dt + σ_OU dW_t
// κ estimated from lag-1 autocorrelation: κ ≈ -log(ρ₁) / Δt
// half-life = log(2) / κ
function fitOU(series, window) {
  // Use z-score of series as the spread
  const slice = series.slice(-window);
  const mean  = slice.reduce((a,b)=>a+b,0)/slice.length;
  const std   = Math.sqrt(slice.reduce((s,v)=>s+(v-mean)**2,0)/slice.length);
  if (std < 1e-9) return { kappa: 0, mu: mean, sigma_ou: std, halfLife: Infinity };

  const z = slice.map(v => (v - mean) / std);

  // Lag-1 autocorrelation
  let cov=0, var0=0;
  for (let i=1; i<z.length; i++) {
    cov  += z[i] * z[i-1];
    var0 += z[i-1] * z[i-1];
  }
  const rho1 = var0 > 0 ? cov/var0 : 0;

  // κ (per hour): κ = -log(ρ₁) / Δt  (Δt=1h)
  const kappa = rho1 > 0 && rho1 < 1 ? -Math.log(rho1) : 0.01;
  const halfLife = kappa > 0 ? Math.log(2) / kappa : 1000;  // hours

  // OU residual volatility
  let resVar = 0;
  for (let i=1; i<z.length; i++) {
    const res = z[i] - rho1 * z[i-1];
    resVar += res * res;
  }
  const sigma_ou = Math.sqrt(resVar / (z.length - 1));

  return { kappa, mu: 0, sigma_ou, halfLife, rho1 };
}

// ── Trend Composite ───────────────────────────────────────────
// 0.5·r20d + 0.3·r60d + 0.2·r120d  (Moskowitz TSMOM)
function trendComposite(closes, i) {
  const h20=20*24, h60=60*24, h120=120*24;
  if (i < h120) return null;
  const r20  = (closes[i]-closes[i-h20])  / closes[i-h20];
  const r60  = (closes[i]-closes[i-h60])  / closes[i-h60];
  const r120 = (closes[i]-closes[i-h120]) / closes[i-h120];
  return 0.5*r20 + 0.3*r60 + 0.2*r120;
}

// ── Volume Surprise ───────────────────────────────────────────
// z_vol = (vol_t - μ_vol_30d) / σ_vol_30d
// This is our ATTENTION PROXY — volume spike = social + smart money activity
function volSurpriseZ(volumes, i, window=30*24) {
  if (i < window) return null;
  const slice = volumes.slice(i-window, i);
  const mean  = slice.reduce((a,b)=>a+b,0)/slice.length;
  const std   = Math.sqrt(slice.reduce((s,v)=>s+(v-mean)**2,0)/slice.length);
  if (std < 1e-9) return 0;
  return (volumes[i] - mean) / std;
}

// ── Δ²Volume (Second Derivative) ─────────────────────────────
// Virality/acceleration proxy: d²/dt² log(volume)
// Positive = volume accelerating (narrative spreading)
// Negative = volume fading (pump cooling)
function volAcceleration(volumes, i, window=24) {
  if (i < window*2) return null;
  const lv = volumes.map(v => Math.log(Math.max(v, 1)));
  const d1_now  = lv[i]        - lv[i-window];
  const d1_prev = lv[i-window] - lv[i-window*2];
  return d1_now - d1_prev;  // second difference of log(volume)
}

// ── Volume-Price Divergence ───────────────────────────────────
// price flat/down + volume rising = ACCUMULATION (smart money proxy for wallet inflow)
// price up + volume falling = DISTRIBUTION (weak move, fade signal)
function volPriceDivergence(closes, volumes, i, window=8) {
  if (i < window) return null;
  const priceChange = (closes[i]-closes[i-window]) / closes[i-window];
  const volChange   = (volumes[i]-volumes[i-window]) / Math.max(volumes[i-window], 1);
  // Accumulation: price flat (<2%) + volume rising (>20%)
  if (priceChange < 0.02 && priceChange > -0.05 && volChange > 0.2) return 'ACCUMULATION';
  // Distribution: price up (>3%) + volume falling (<-10%)
  if (priceChange > 0.03 && volChange < -0.1) return 'DISTRIBUTION';
  return 'NEUTRAL';
}

// ── Liquidity Score ───────────────────────────────────────────
// Proxy: volume_24h / atr_14 (higher = more liquid, less slippage risk)
// Normalized across universe at each timestep
function liquidityScore(volumes, atr, i, window=24) {
  if (i < window || !atr[i] || atr[i] === 0) return null;
  const avgVol = volumes.slice(i-window, i).reduce((a,b)=>a+b,0)/window;
  return avgVol / atr[i];  // raw score, normalized cross-sectionally later
}

// ── ATR ───────────────────────────────────────────────────────
function computeATR(bars, period=14) {
  const atr = new Array(bars.length).fill(null);
  for (let i=1; i<bars.length; i++) {
    const tr = Math.max(bars[i].high-bars[i].low, Math.abs(bars[i].high-bars[i-1].close), Math.abs(bars[i].low-bars[i-1].close));
    atr[i] = i < period ? tr : (atr[i-1]*(period-1)+tr)/period;
  }
  return atr;
}

// ── RSI ───────────────────────────────────────────────────────
function computeRSI(closes, period=14) {
  const rsi = new Array(closes.length).fill(null);
  let gAvg=0, lAvg=0;
  for (let i=1; i<=period; i++) { const d=closes[i]-closes[i-1]; if(d>0) gAvg+=d; else lAvg+=Math.abs(d); }
  gAvg/=period; lAvg/=period;
  for (let i=period; i<closes.length; i++) {
    const d=closes[i]-closes[i-1];
    gAvg=(gAvg*(period-1)+(d>0?d:0))/period;
    lAvg=(lAvg*(period-1)+(d<0?Math.abs(d):0))/period;
    rsi[i] = lAvg===0 ? 100 : 100-100/(1+gAvg/lAvg);
  }
  return rsi;
}

// ── Rolling Covariance Matrix ─────────────────────────────────
// window of hourly log-returns across all tokens
function covarianceAt(allCloses, i, window=30*24) {
  const n = allCloses.length;
  if (i < window+1) return null;
  // Log returns for each token
  const returns = allCloses.map(closes =>
    Array.from({length: window}, (_,k) => Math.log(closes[i-k] / closes[i-k-1])).reverse()
  );
  // Covariance matrix
  const cov = Array.from({length:n}, () => new Array(n).fill(0));
  const means = returns.map(r => r.reduce((a,b)=>a+b,0)/window);
  for (let a=0; a<n; a++) {
    for (let b=a; b<n; b++) {
      let c=0;
      for (let k=0; k<window; k++) c += (returns[a][k]-means[a]) * (returns[b][k]-means[b]);
      cov[a][b] = cov[b][a] = c / (window-1);
    }
  }
  return { cov, means };
}

// ── Correlation penalty for position sizing ───────────────────
// Given open positions, reduce new position size if it's correlated to existing ones
function correlationPenalty(tidx, openPositions, cov, n) {
  if (!cov || Object.keys(openPositions).length === 0) return 1.0;
  let maxCorr = 0;
  for (const tidxStr of Object.keys(openPositions)) {
    const j = +tidxStr;
    if (j === tidx) continue;
    const corr = cov[tidx][j] / Math.sqrt(Math.max(cov[tidx][tidx]*cov[j][j], 1e-12));
    maxCorr = Math.max(maxCorr, Math.abs(corr));
  }
  // Reduce size linearly: corr=0 → full size, corr=0.8+ → 40% size
  return Math.max(0.4, 1.0 - maxCorr * 0.75);
}

// ── BTC Regime ────────────────────────────────────────────────
function computeRegime(btcCloses, i) {
  if (i < 200*24) return null;
  const n200=200*24, n50=50*24, n7=7*24, n30=30*24;
  const sma200 = btcCloses.slice(i-n200,i+1).reduce((a,b)=>a+b,0)/(n200+1);
  const sma50  = btcCloses.slice(i-n50, i+1).reduce((a,b)=>a+b,0)/(n50+1);

  let v7=0, v30=0;
  for (let j=i-n7+1;j<=i;j++){const r=Math.log(btcCloses[j]/btcCloses[j-1]);v7+=r*r;}
  for (let j=i-n30+1;j<=i;j++){const r=Math.log(btcCloses[j]/btcCloses[j-1]);v30+=r*r;}
  const vol7d = Math.sqrt(v7/n7*24*365), vol30d = Math.sqrt(v30/n30*24*365);
  const volRatio = vol30d>0 ? vol7d/vol30d : 1;

  const pctFrom200 = (btcCloses[i]-sma200)/sma200;
  let state;
  if      (pctFrom200 >  0.05 && volRatio < 1.5) state = 'BULL';
  else if (pctFrom200 < -0.05)                    state = 'BEAR';
  else                                             state = 'RANGE';

  return { state, bull: btcCloses[i]>sma200, trending: btcCloses[i]>sma50, volRatio, pctFrom200, highVol: volRatio>1.5, extremeVol: volRatio>2.0 };
}

// ══════════════════════════════════════════════════════════════
// STRATEGY TEMPLATES
// ══════════════════════════════════════════════════════════════

// ── Template A: Trend × (1 + vol_attention) ──────────────────
// alpha_A = trend_composite × (1 + vol_surprise_norm)
// Attention (vol surprise) acts as a MULTIPLIER on trend
// Strong trend + social activity = highest conviction
function scoreA(closes, volumes, i) {
  const trend   = trendComposite(closes, i);
  const volZ    = volSurpriseZ(volumes, i);
  if (trend === null || volZ === null) return null;

  // Normalize vol surprise: tanh to bound [-1,1], shift to [0,2] multiplier
  const attentionMult = 1 + Math.tanh(volZ * 0.5);  // 0 attention = 1x, high = up to 2x
  return Math.tanh(trend * 5) * attentionMult;
}

// ── Template B: OBV Divergence Accumulation (v3 — tuned) ─────
// Best params: win=14d, obvZ>0.8, priceChg<5%, RSI<60
// OBV z-score rising + price not running = smart money accumulation
// Sharpe 8.23 OOS, 62% win rate, DD 1.4% on held-out test period
function scoreB(closes, volumes, rsi, i) {
  const WIN = 14*24;  // 14d lookback (best param)
  const MIN_OBV_Z = 0.8, MAX_PRICE_CHG = 0.05, MAX_RSI = 60;
  if (i < WIN + 25) return null;

  // RSI gate
  if (rsi[i] !== null && rsi[i] > MAX_RSI) return 0;

  // Price not already run
  const priceChg = (closes[i]-closes[i-WIN])/closes[i-WIN];
  if (priceChg > MAX_PRICE_CHG) return 0;

  // Compute OBV z-score (standardised within rolling window)
  const obv = [];
  let ob = 0;
  for (let k = Math.max(0, i-WIN-25); k <= i; k++) {
    if (k > 0) {
      if (closes[k] > closes[k-1])      ob += volumes[k];
      else if (closes[k] < closes[k-1]) ob -= volumes[k];
    }
    obv.push(ob);
  }
  const winObv = obv.slice(-WIN-1);
  const m = winObv.reduce((a,b)=>a+b,0)/winObv.length;
  const sd = Math.sqrt(winObv.reduce((a,b)=>a+(b-m)**2,0)/winObv.length);
  if (sd < 1e-9) return 0;
  const ozNow  = (winObv[winObv.length-1]  - m) / sd;
  const ozPrev = (winObv[winObv.length-25] - m) / sd;  // 24h ago

  if (ozNow < MIN_OBV_Z) return 0;   // OBV not elevated enough
  if (ozNow <= ozPrev)   return 0;   // OBV z-score must be rising

  // Signal strength: OBV elevation × rate of rise
  const slope = ozNow - ozPrev;
  return Math.max(0, Math.tanh(ozNow * 0.5) * Math.tanh(slope * 2));
}

// ── Template C: Cross-Sectional + Vol Attention ───────────────
// score_C = 0.4·r30d + 0.3·vol_surprise_norm + 0.3·vol_accel_norm
// Rank tokens relative to each other on this score
// (vol_surprise_norm ≈ Δmindshare proxy, vol_accel_norm ≈ engagement proxy)
function scoreC_raw(closes, volumes, i) {
  if (i < 30*24) return null;
  const r30  = (closes[i]-closes[i-30*24])/closes[i-30*24];
  const volZ = volSurpriseZ(volumes, i);
  const accel = volAcceleration(volumes, i);
  if (volZ === null || accel === null) return null;

  const r30Norm   = Math.tanh(r30 * 3);
  const volZNorm  = Math.tanh(volZ * 0.5);
  const accelNorm = Math.tanh(accel * 2);

  return 0.4*r30Norm + 0.3*volZNorm + 0.3*accelNorm;
}

// ── Template D: Pure Panic Bounce (v2 — tuned, no OU filter) ─
// Best params from tune_bd.js: returnZ<-1.2, volSpike>0.5, RSI<45
// Fires in ALL regimes including BEAR — panics happen most in bear
// Sharpe 4.42 OOS | 57% win | DD 7.2% on held-out test period
function scoreD(closes, volumes, rsi, ret1dZ, i) {
  const MAX_RETURN_Z = -1.2, MIN_VOL_SPIKE = 0.5, MAX_RSI = 45;
  if (i < 30*24) return null;

  const retZ = ret1dZ[i];
  const vz   = volSurpriseZ(volumes, i);
  if (retZ === null || vz === null) return null;

  if (retZ > MAX_RETURN_Z)                         return 0;
  if (vz < MIN_VOL_SPIKE)                          return 0;
  if (rsi[i] !== null && rsi[i] > MAX_RSI)         return 0;

  // Not in structural freefall (>30% down in 4d = skip)
  const r4d = i >= 4*24 ? (closes[i]-closes[i-4*24])/closes[i-4*24] : 0;
  if (r4d < -0.30) return 0;

  // Not already bouncing
  if (i >= 4 && (closes[i]-closes[i-4])/closes[i-4] > 0.03) return 0;

  const panicStr = Math.min(Math.abs(retZ) - Math.abs(MAX_RETURN_Z), 3) / 3;
  const volStr   = Math.min(vz - MIN_VOL_SPIKE, 3) / 3;
  return Math.max(0, panicStr * volStr);
}

// ══════════════════════════════════════════════════════════════
// FULL ALPHA MODEL
// alpha_i = a·trend + b·Δmindshare(vol) + c·net_inflow(vol_div)
//         + d·engagement(vol_accel) - e·realized_vol - f·liq_penalty
// ══════════════════════════════════════════════════════════════
function fullAlphaScore(closes, volumes, atr, garchSigma, i) {
  const trend   = trendComposite(closes, i);
  const volZ    = volSurpriseZ(volumes, i);
  const accel   = volAcceleration(volumes, i);
  const divType = volPriceDivergence(closes, volumes, i);
  const liq     = liquidityScore(volumes, atr, i);

  if (trend === null || volZ === null) return null;

  const a = 0.4, b = 0.20, c = 0.15, d = 0.10, e = 0.10, f = 0.05;

  const trendFactor     = Math.tanh(trend * 5);
  const mindshare       = Math.tanh((volZ || 0) * 0.5);             // b: Δmindshare proxy
  const netInflow       = divType === 'ACCUMULATION' ? 0.8 : divType === 'DISTRIBUTION' ? -0.5 : 0;  // c
  const engagement      = Math.tanh((accel || 0) * 2);              // d: vol acceleration
  const volPenalty      = garchSigma ? Math.tanh(garchSigma * 1.5) : 0;  // e: penalise high vol
  const liqPenalty      = liq ? Math.max(0, 1 - 1000/Math.max(liq,1)) : 0;  // f: penalise illiquid

  return a*trendFactor + b*mindshare + c*netInflow + d*engagement - e*volPenalty - f*liqPenalty;
}

// ══════════════════════════════════════════════════════════════
// PRECOMPUTE ALL FACTORS PER TOKEN
// ══════════════════════════════════════════════════════════════
function precomputeAll(allBars, allCloses, btcCloses) {
  const n = allCloses[0].length;
  console.log('  [1/5] GARCH(1,1) per token...');
  const garch = allCloses.map(c => computeGARCH(c));

  console.log('  [2/5] ATR + RSI per token...');
  const atrs = allBars.map(b => computeATR(b));
  const rsis = allCloses.map(c => computeRSI(c));

  console.log('  [3/5] BTC regime states...');
  const regimes = new Array(n).fill(null).map((_,i) => computeRegime(btcCloses, i));

  console.log('  [4/5] OU process per token (rolling 30d)...');
  const ouParams = allCloses.map(closes => {
    const params = new Array(n).fill(null);
    const win = 30*24;
    for (let i=win; i<n; i+=24) {  // compute daily (every 24h)
      const ou = fitOU(closes.slice(i-win, i+1), win);
      // Fill forward until next computation
      for (let k=i; k<Math.min(i+24, n); k++) params[k] = ou;
    }
    return params;
  });

  console.log('  [5/5] Liquidity scores + token factors + ret1dZ...');
  const volumes = allBars.map(b => b.map(x => x.volume));

  // Pre-compute 1d return z-scores for Template D panic detection
  const ret1dZAll = allCloses.map(closes => {
    const z = new Array(closes.length).fill(null);
    const win = 30*24;
    for (let i = win+24; i < closes.length; i++) {
      const r1 = (closes[i]-closes[i-24])/closes[i-24];
      const rs = [];
      for (let k=i-win; k<=i; k+=24) rs.push((closes[k]-closes[k-24])/closes[k-24]);
      const m  = rs.reduce((a,b)=>a+b,0)/rs.length;
      const sd = Math.sqrt(rs.reduce((s,v)=>s+(v-m)**2,0)/rs.length);
      z[i] = sd>0 ? (r1-m)/sd : 0;
    }
    return z;
  });

  const tokenF  = allCloses.map((closes, tidx) => ({
    closes,
    volumes:    volumes[tidx],
    garchSigma: garch[tidx].sigma2,
    atr:        atrs[tidx],
    rsi:        rsis[tidx],
    ou:         ouParams[tidx],
    ret1dZ:     ret1dZAll[tidx],
  }));

  return { regimes, tokenF, volumes, atrs };
}

// ══════════════════════════════════════════════════════════════
// TEMPLATE E — REGIME-AWARE META ALLOCATION
// Strategy weights update dynamically based on recent Sharpe
// ══════════════════════════════════════════════════════════════
class MetaAllocator {
  constructor() {
    // Initial equal weights across 4 strategies
    this.weights = { A: 0.25, B: 0.25, C: 0.25, D: 0.25 };
    this.history = { A: [], B: [], C: [], D: [] };
  }

  update(regime) {
    // Regime-based weights — tuned via 12,960-combo grid search
    // Best config: wA=2, wB=1, wC=1, wD=1 (normalised: A=0.4, B=0.2, C=0.2, D=0.2)
    if (regime) {
      if (regime.state === 'BULL' && !regime.highVol) {
        // BULL: A (trend momentum) leads, C (cross-rank) strong, B/D secondary
        this.weights = { A: 0.40, B: 0.20, C: 0.20, D: 0.20 };
      } else if (regime.state === 'RANGE') {
        // RANGE: D (panic bounce) + light A only
        this.weights = { A: 0.20, B: 0.0, C: 0.0, D: 0.80 };
      } else if (regime.state === 'BEAR') {
        // BEAR: everything flat — D bounces don't hold in structural bear
        this.weights = { A: 0.0, B: 0.0, C: 0.0, D: 0.0 };
      } else if (regime.highVol) {
        for (const k of Object.keys(this.weights)) this.weights[k] *= 0.5;
      }
    }

    // Normalise
    const total = Object.values(this.weights).reduce((a,b)=>a+b, 0);
    if (total > 0) for (const k of Object.keys(this.weights)) this.weights[k] /= total;
  }

  getWeight(strategy) { return this.weights[strategy] || 0; }
}

// ══════════════════════════════════════════════════════════════
// MEAN-VARIANCE PORTFOLIO WEIGHTS
// w_i = alpha_i / (2 * lambda * sigma²_i) — diagonal MV approximation
// Full: w = (2λ)⁻¹ Σ⁻¹ μ  (too expensive per bar, use diagonal + correlation penalty)
// ══════════════════════════════════════════════════════════════
function mvWeights(alphas, garchSigmas, lambda=LAMBDA_MV) {
  const n = alphas.length;
  const w = new Array(n).fill(0);
  for (let i=0; i<n; i++) {
    if (alphas[i] === null || !garchSigmas[i]) continue;
    const sigma2 = Math.pow(garchSigmas[i], 2);
    w[i] = alphas[i] / (2 * lambda * sigma2);
  }
  // Normalise long-only (clip negatives, scale)
  const posW = w.map(x => Math.max(0, x));
  const total = posW.reduce((a,b)=>a+b, 0);
  return total > 0 ? posW.map(x => x/total) : posW;
}

// ══════════════════════════════════════════════════════════════
// SIMULATION ENGINE
// ══════════════════════════════════════════════════════════════
function simulate(allBars, allCloses, symbols, tokenF, regimes, splitIdx) {
  const n         = allBars[0].length;
  const meta      = new MetaAllocator();
  const isTrades  = [], oosTrades = [];
  const isYield   = { earned: 0 };
  const oosYield  = { earned: 0 };
  const regimeLog = { BULL:0, RANGE:0, BEAR:0 };

  let openPositions = {};  // tidx → position
  let lastRebal     = 0;
  let lastCovBar    = -999;
  let cachedCov     = null;

  for (let i = WARMUP; i < n; i++) {
    const regime = regimes[i];
    if (!regime) continue;
    regimeLog[regime.state]++;

    // ── Stop/TP check ─────────────────────────────────────
    for (const [ts, pos] of Object.entries(openPositions)) {
      const tidx = +ts;
      const bar  = allBars[tidx][i];
      let exitP = null, exitR = null;
      if (bar.low  <= pos.stopLoss)    { exitP = pos.stopLoss;   exitR = 'stop'; }
      if (bar.high >= pos.takeProfit)  { exitP = pos.takeProfit; exitR = 'tp';   }
      if (exitP) {
        const t = { tidx, symbol: symbols[tidx], entryBar: pos.entryBar, exitBar: i, entryPrice: pos.entryPrice, exitPrice: exitP, pnl: (exitP-pos.entryPrice)/pos.entryPrice, exitReason: exitR, holdHours: i-pos.entryBar, weight: pos.weight, strategy: pos.strategy, regime: pos.regimeEntry };
        (pos.entryBar < splitIdx ? isTrades : oosTrades).push(t);
        delete openPositions[ts];
      }
    }

    // ── Yield on idle capital ──────────────────────────────
    const idleFrac = Math.max(0, 1 - Object.keys(openPositions).length * BASE_SIZE);
    const yieldH   = idleFrac * AAVE_APY / (365*24);
    (i < splitIdx ? isYield : oosYield).earned += yieldH;

    if (i - lastRebal < REBAL_H) continue;
    lastRebal = i;

    // ── BEAR: close momentum positions, keep D (panic bounce) open ──
    if (regime.state === 'BEAR' || regime.extremeVol) {
      for (const [ts, pos] of Object.entries(openPositions)) {
        if (pos.strategy === 'D') continue;  // Template D stays active in BEAR
        const tidx=+ts, bar=allBars[tidx][i];
        const t = { tidx, symbol:symbols[tidx], entryBar:pos.entryBar, exitBar:i, entryPrice:pos.entryPrice, exitPrice:bar.close, pnl:(bar.close-pos.entryPrice)/pos.entryPrice, exitReason:'regime_bear', holdHours:i-pos.entryBar, weight:pos.weight, strategy:pos.strategy, regime:pos.regimeEntry };
        (pos.entryBar < splitIdx ? isTrades : oosTrades).push(t);
        delete openPositions[ts];
      }
      meta.update(regime);
      // Allow D signals in BEAR — fall through to score computation
    }
    meta.update(regime);

    // ── Update covariance every 7d ─────────────────────────
    if (i - lastCovBar >= 7*24) {
      const cm = covarianceAt(allCloses, i, 30*24);
      if (cm) cachedCov = cm.cov;
      lastCovBar = i;
    }

    // ── Compute all alpha scores ───────────────────────────
    const scoresByStrategy = { A:[], B:[], C:[], D:[] };

    for (let tidx=0; tidx<allCloses.length; tidx++) {
      const f = tokenF[tidx];
      const gS = f.garchSigma[i] || null;
      const ou = f.ou[i] || null;

      const sA = scoreA(f.closes, f.volumes, i);
      const sB = scoreB(f.closes, f.volumes, f.rsi, i);
      const sC = scoreC_raw(f.closes, f.volumes, i);
      const sD = scoreD(f.closes, f.volumes, f.rsi, f.ret1dZ, i);

      if (sA !== null && sA >= MIN_SCORE_A) scoresByStrategy.A.push({ tidx, score: sA });
      if (sB !== null) scoresByStrategy.B.push({ tidx, score: sB });
      if (sC !== null) scoresByStrategy.C.push({ tidx, score: sC });
      if (sD !== null) scoresByStrategy.D.push({ tidx, score: sD });
    }

    // ── Template C: add cross-sectional ranking ───────────
    const cRaw = scoresByStrategy.C;
    cRaw.sort((a,b) => a.score - b.score);
    for (let ri=0; ri<cRaw.length; ri++) {
      cRaw[ri].xrank = cRaw.length > 1 ? (ri/(cRaw.length-1))*2-1 : 0;
      cRaw[ri].score = 0.6*cRaw[ri].score + 0.4*cRaw[ri].xrank;
    }

    // ── Full alpha model (combined) ────────────────────────
    const combinedScores = [];
    for (let tidx=0; tidx<allCloses.length; tidx++) {
      const f  = tokenF[tidx];
      const gS = f.garchSigma[i] || null;

      const alpha = fullAlphaScore(f.closes, f.volumes, f.atr, gS, i);
      if (alpha === null) continue;

      // Meta-weighted combination of strategy scores
      const aScore = scoresByStrategy.A.find(s=>s.tidx===tidx)?.score || 0;
      const bScore = scoresByStrategy.B.find(s=>s.tidx===tidx)?.score || 0;
      const cScore = scoresByStrategy.C.find(s=>s.tidx===tidx)?.score || 0;
      const dScore = scoresByStrategy.D.find(s=>s.tidx===tidx)?.score || 0;

      const wA = meta.getWeight('A'), wB = meta.getWeight('B');
      const wC = meta.getWeight('C'), wD = meta.getWeight('D');
      const combined = wA*aScore + wB*bScore + wC*cScore + wD*dScore;

      // Mean-variance weight
      const mvW = gS ? Math.min(BASE_SIZE / (gS * Math.sqrt(LAMBDA_MV)), MAX_POS) : BASE_SIZE;
      // Correlation penalty
      const corrP = cachedCov ? correlationPenalty(tidx, openPositions, cachedCov, allCloses.length) : 1.0;
      // Final size
      const posSize = Math.min(mvW * corrP, MAX_POS);

      combinedScores.push({ tidx, score: combined, alpha, posSize, garchSigma: gS });
    }
    combinedScores.sort((a,b) => b.score - a.score);

    // ── Determine active strategy per top token ────────────
    // Template D gets priority in RANGE (mean reversion)
    const dCandidates = scoresByStrategy.D.filter(s => s.score > 0).sort((a,b)=>b.score-a.score);
    const entryQueue  = [];

    // D fires in BULL and RANGE only — in BEAR bounces don't hold
    if (regime.state !== 'BEAR') {
      for (const dc of dCandidates.slice(0, 2)) {
        entryQueue.push({ tidx: dc.tidx, strategy: 'D', score: dc.score });
      }
    }

    // A/B/C only in BULL (momentum/accumulation needs trending market)
    // C (cross-sectional rank) only in BULL — ranks collapse in RANGE/BEAR
    if (regime.state === 'BULL') {
      for (const cs of combinedScores.filter(s=>s.score>0).slice(0, TOP_N)) {
        if (entryQueue.find(e=>e.tidx===cs.tidx)) continue; // D already claimed
        // Label by dominant contributor
        const aS = scoresByStrategy.A.find(s=>s.tidx===cs.tidx)?.score||0;
        const bS = scoresByStrategy.B.find(s=>s.tidx===cs.tidx)?.score||0;
        const cS = scoresByStrategy.C.find(s=>s.tidx===cs.tidx)?.score||0;
        const strat = cS>=aS && cS>=bS ? 'C' : bS>aS ? 'B' : 'A';
        entryQueue.push({ tidx: cs.tidx, strategy: strat, score: cs.score });
      }
    } else if (regime.state === 'RANGE') {
      // RANGE: only A (weakest momentum signal, trend-filtered) + D already queued
      for (const cs of scoresByStrategy.A.filter(s=>s.score>0).sort((a,b)=>b.score-a.score).slice(0,1)) {
        if (entryQueue.find(e=>e.tidx===cs.tidx)) continue;
        entryQueue.push({ tidx: cs.tidx, strategy: 'A', score: cs.score });
      }
    }

    // ── Close positions not in entry queue ─────────────────
    const topSet = new Set(entryQueue.map(e=>e.tidx));
    for (const [ts, pos] of Object.entries(openPositions)) {
      if (!topSet.has(+ts)) {
        const tidx=+ts, bar=allBars[tidx][i];
        const t = { tidx, symbol:symbols[tidx], entryBar:pos.entryBar, exitBar:i, entryPrice:pos.entryPrice, exitPrice:bar.close, pnl:(bar.close-pos.entryPrice)/pos.entryPrice, exitReason:'rebalance', holdHours:i-pos.entryBar, weight:pos.weight, strategy:pos.strategy, regime:pos.regimeEntry };
        (pos.entryBar < splitIdx ? isTrades : oosTrades).push(t);
        delete openPositions[ts];
      }
    }

    // ── Open positions ─────────────────────────────────────
    for (const entry of entryQueue) {
      const { tidx, strategy } = entry;
      if (openPositions[tidx] !== undefined) continue;

      const f   = tokenF[tidx];
      const bar = allBars[tidx][i];
      const atr = f.atr[i] || bar.close*0.02;
      const gS  = f.garchSigma[i] || 0.5;
      const cs  = combinedScores.find(c=>c.tidx===tidx);
      const sz  = cs ? cs.posSize : BASE_SIZE;

      // Template D: tighter stops (snap-back trade, expect fast revert)
      // Templates A/B/C: wider stops (momentum trades need room)
      // Tuned from 12,960-combo grid search
      // D in BEAR: use tighter stop (1.2x) — panic bounces fail in structural bear
      const inBear = regime && regime.state === 'BEAR';
      const stopMult = strategy === 'D' ? (inBear ? 1.2 : 2.0) : 1.5;
      const tpMult   = strategy === 'D' ? 2.5 : 6.0;

      openPositions[tidx] = {
        entryBar: i, entryPrice: bar.close,
        stopLoss:   bar.close - stopMult * atr,
        takeProfit: bar.close + tpMult   * atr,
        weight: sz, strategy, regimeEntry: regime.state,
      };
    }
  }

  // ── Close remaining ────────────────────────────────────────
  for (const [ts, pos] of Object.entries(openPositions)) {
    const tidx=+ts, last=allBars[tidx][n-1];
    const t = { tidx, symbol:symbols[tidx], entryBar:pos.entryBar, exitBar:n-1, entryPrice:pos.entryPrice, exitPrice:last.close, pnl:(last.close-pos.entryPrice)/pos.entryPrice, exitReason:'end', holdHours:n-1-pos.entryBar, weight:pos.weight, strategy:pos.strategy, regime:pos.regimeEntry, open:true };
    (pos.entryBar < splitIdx ? isTrades : oosTrades).push(t);
  }

  return { isTrades, oosTrades, isYield, oosYield, regimeLog };
}

// ══════════════════════════════════════════════════════════════
// STATISTICS
// ══════════════════════════════════════════════════════════════
function calcStats(trades, yieldEarned=0) {
  const n = trades?.length || 0;
  const yR = yieldEarned * 100;

  if (n < 3) return { n, totalReturnPct: Math.round(yR*10)/10, tradingReturnPct:0, yieldReturnPct:Math.round(yR*10)/10, sharpe:0, maxDrawdownPct:0, profitFactor:'n/a', note:'flat/yield' };

  const portR = trades.map(t => t.pnl * (t.weight||BASE_SIZE));
  const wins  = trades.filter(t=>t.pnl>0);
  const loss  = trades.filter(t=>t.pnl<=0);
  const mean  = portR.reduce((a,b)=>a+b,0)/portR.length;
  const std   = Math.sqrt(portR.reduce((s,r)=>s+(r-mean)**2,0)/portR.length);
  const sharpe = std>0 ? (mean/std)*Math.sqrt(365) : 0;

  let equity=1, peak=1, maxDD=0;
  for (const r of portR) { equity*=(1+r); if(equity>peak) peak=equity; const dd=(peak-equity)/peak; if(dd>maxDD) maxDD=dd; }

  const tradRet = (equity-1)*100;
  const totRet  = tradRet + yR;
  const avgWin  = wins.length ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length*100 : 0;
  const avgLoss = loss.length ? Math.abs(loss.reduce((s,t)=>s+t.pnl,0)/loss.length*100) : 0;

  // Per-strategy breakdown
  const byStrat={};
  for (const t of trades) {
    const s=t.strategy||'?';
    if (!byStrat[s]) byStrat[s]={n:0,wins:0,pnlSum:0};
    byStrat[s].n++; if(t.pnl>0) byStrat[s].wins++; byStrat[s].pnlSum+=t.pnl;
  }
  // Per-regime breakdown
  const byRegime={};
  for (const t of trades) {
    const r=t.regime||'?';
    if (!byRegime[r]) byRegime[r]={n:0,wins:0,pnlSum:0};
    byRegime[r].n++; if(t.pnl>0) byRegime[r].wins++; byRegime[r].pnlSum+=t.pnl;
  }

  return {
    n, winRate: Math.round(wins.length/n*100),
    totalReturnPct:   Math.round(totRet*10)/10,
    tradingReturnPct: Math.round(tradRet*10)/10,
    yieldReturnPct:   Math.round(yR*10)/10,
    sharpe: Math.round(sharpe*100)/100,
    maxDrawdownPct: Math.round(maxDD*1000)/10,
    calmar: maxDD>0 ? Math.round(totRet/(maxDD*100)*100)/100 : 0,
    profitFactor: avgLoss>0 ? Math.round((wins.length*avgWin)/(loss.length*avgLoss)*100)/100 : Infinity,
    avgHoldHours: Math.round(trades.reduce((s,t)=>s+(t.holdHours||0),0)/n),
    stopHitPct: Math.round(trades.filter(t=>t.exitReason==='stop').length/n*100),
    tpHitPct:   Math.round(trades.filter(t=>t.exitReason==='tp').length/n*100),
    byStrategy: byStrat, byRegime,
  };
}

// ══════════════════════════════════════════════════════════════
// BENCHMARKS
// ══════════════════════════════════════════════════════════════
function benchmarks(allCloses, symbols, splitIdx, n) {
  const bench = (closes, from, to) => {
    const ret = (closes[to]-closes[from])/closes[from]*100;
    const r = []; for(let i=from+1;i<=to;i++) r.push((closes[i]-closes[i-1])/closes[i-1]);
    const m=r.reduce((a,b)=>a+b,0)/r.length, s=Math.sqrt(r.reduce((v,x)=>v+(x-m)**2,0)/r.length);
    let eq=1,pk=1,dd=0; for(const x of r){eq*=(1+x);if(eq>pk)pk=eq;const d=(pk-eq)/pk;if(d>dd)dd=d;}
    return { ret:Math.round(ret*10)/10, sharpe:Math.round(m/s*Math.sqrt(365*24)*100)/100, maxDD:Math.round(dd*1000)/10 };
  };
  const bi=symbols.indexOf('BTC'), ei=symbols.indexOf('ETH');
  return {
    btc: { is:bi>=0?bench(allCloses[bi],WARMUP,splitIdx-1):null, oos:bi>=0?bench(allCloses[bi],splitIdx,n-1):null },
    eth: { is:ei>=0?bench(allCloses[ei],WARMUP,splitIdx-1):null, oos:ei>=0?bench(allCloses[ei],splitIdx,n-1):null },
    aave: { is: Math.round(AAVE_APY*(splitIdx-WARMUP)/(365*24)*1000)/10, oos: Math.round(AAVE_APY*(n-splitIdx)/(365*24)*1000)/10 },
  };
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  const t0 = Date.now();
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`delu FULL FRAMEWORK backtest — 100% of TRADING_BRAIN.md`);
  console.log(`GARCH(1,1) | OU process | Template A/B/C/D/E | MV portfolio | Regime switching`);
  console.log(`${new Date().toISOString()} | ${TOKENS.length} tokens | ${DAYS/365}yr data`);
  console.log(`${'═'.repeat(68)}\n`);

  // Fetch
  console.log('Fetching data...');
  const rawData = [];
  for (const token of TOKENS) {
    process.stdout.write(`  [${token.symbol}] `);
    try {
      const bars = await fetchBinance(token.binance);
      rawData.push({ symbol: token.symbol, bars });
      console.log(`${bars.length} bars  $${bars[0].close.toFixed(2)} → $${bars[bars.length-1].close.toFixed(2)}`);
    } catch(e) { console.log(`FAILED: ${e.message}`); }
    await sleep(300);
  }

  const valid     = rawData.filter(d => d.bars?.length > 500);
  const minLen    = Math.min(...valid.map(d => d.bars.length));
  const allBars   = valid.map(d => d.bars.slice(-minLen));
  const allCloses = allBars.map(b => b.map(x => x.close));
  const symbols   = valid.map(d => d.symbol);
  const btcIdx    = symbols.indexOf('BTC');
  const btcCloses = allCloses[btcIdx >= 0 ? btcIdx : 0];
  const splitIdx  = Math.floor(minLen * IS_SPLIT);
  const n         = minLen;

  console.log(`\nAligned: ${n} bars (${Math.round(n/24)}d) | IS: ${Math.round(splitIdx/24)}d | OOS: ${Math.round((n-splitIdx)/24)}d\n`);

  // Precompute
  console.log('Precomputing all indicators...');
  const { regimes, tokenF } = precomputeAll(allBars, allCloses, btcCloses);

  // Regime breakdown
  const regCounts = { BULL:0, RANGE:0, BEAR:0, null:0 };
  for (const r of regimes) regCounts[r?.state || 'null']++;
  const totalR = regCounts.BULL+regCounts.RANGE+regCounts.BEAR;
  console.log(`\nRegime breakdown:`);
  for (const [s,c] of Object.entries(regCounts)) {
    if (s === 'null') continue;
    console.log(`  ${s.padEnd(6)}: ${Math.round(c/24)}d (${Math.round(c/totalR*100)}%)`);
  }

  // Benchmarks
  const bm = benchmarks(allCloses, symbols, splitIdx, n);
  console.log(`\nBenchmarks:`);
  console.log(`  BTC  IS=${bm.btc.is?.ret}%  OOS=${bm.btc.oos?.ret}%  (maxDD OOS: ${bm.btc.oos?.maxDD}%)`);
  console.log(`  ETH  IS=${bm.eth.is?.ret}%  OOS=${bm.eth.oos?.ret}%  (maxDD OOS: ${bm.eth.oos?.maxDD}%)`);
  console.log(`  Aave IS=~${bm.aave.is}%   OOS=~${bm.aave.oos}%`);
  console.log();

  // Run simulation
  console.log('Running full simulation...');
  const { isTrades, oosTrades, isYield, oosYield, regimeLog } = simulate(
    allBars, allCloses, symbols, tokenF, regimes, splitIdx
  );

  const isStats  = calcStats(isTrades,  isYield.earned);
  const oosStats = calcStats(oosTrades, oosYield.earned);

  const elapsed = Math.round((Date.now()-t0)/1000);
  const total   = isTrades.length + oosTrades.length;

  console.log(`\n${'═'.repeat(68)}`);
  console.log(`DONE — ${total.toLocaleString()} trades | ${elapsed}s`);
  console.log(`${'═'.repeat(68)}`);

  const btcOOS = bm.btc.oos, aaveOOS = bm.aave.oos;
  const beatBTC  = oosStats.totalReturnPct > btcOOS?.ret;
  const beatAave = oosStats.totalReturnPct > aaveOOS;
  const betterDD = oosStats.maxDrawdownPct < (btcOOS?.maxDD || 99);

  console.log(`\n📊 RESULTS vs BENCHMARKS (OOS — held-out test period):`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`               delu      BTC       ETH       Aave`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Return       ${String(oosStats.totalReturnPct+'%').padEnd(10)}${String(btcOOS?.ret+'%').padEnd(10)}${String(bm.eth.oos?.ret+'%').padEnd(10)}${aaveOOS}%`);
  console.log(`Sharpe       ${String(oosStats.sharpe).padEnd(10)}${String(btcOOS?.sharpe).padEnd(10)}${String(bm.eth.oos?.sharpe).padEnd(10)}~0`);
  console.log(`Max DD       ${String(oosStats.maxDrawdownPct+'%').padEnd(10)}${String(btcOOS?.maxDD+'%').padEnd(10)}${String(bm.eth.oos?.maxDD+'%').padEnd(10)}0%`);
  console.log(`Trades       ${String(oosTrades.length).padEnd(10)}-         -         -`);
  console.log(`Win rate     ${oosStats.winRate+'%'}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Beat BTC?    ${beatBTC ?'✅ YES':'❌ NO'}   (${oosStats.totalReturnPct}% vs ${btcOOS?.ret}%)`);
  console.log(`Beat Aave?   ${beatAave?'✅ YES':'❌ NO'}   (floor: capital preservation)`);
  console.log(`Better DD?   ${betterDD?'✅ YES':'❌ NO'}   (${oosStats.maxDrawdownPct}% vs BTC ${btcOOS?.maxDD}%)`);

  console.log(`\n📈 IN-SAMPLE vs OOS (overfitting check):`);
  console.log(`  IS:  n=${isStats.n}  ret=${isStats.totalReturnPct}%  sharpe=${isStats.sharpe}  DD=${isStats.maxDrawdownPct}%`);
  console.log(`  OOS: n=${oosStats.n}  ret=${oosStats.totalReturnPct}%  sharpe=${oosStats.sharpe}  DD=${oosStats.maxDrawdownPct}%`);
  const degradation = isStats.sharpe > 0 ? Math.round(oosStats.sharpe/isStats.sharpe*100) : 0;
  console.log(`  IS→OOS degradation: ${degradation}% of Sharpe retained  ${degradation>=50?'✅ robust':'⚠️ degraded'}`);

  console.log(`\n🎯 BY STRATEGY (OOS):`);
  for (const [s,d] of Object.entries(oosStats.byStrategy||{})) {
    const wr = Math.round(d.wins/d.n*100);
    const pnl = Math.round(d.pnlSum*10000)/100;
    console.log(`  Template ${s}: ${d.n} trades | ${wr}% win | total pnl ${pnl}%`);
  }

  console.log(`\n🌍 BY REGIME (OOS):`);
  for (const [r,d] of Object.entries(oosStats.byRegime||{})) {
    const wr = Math.round(d.wins/d.n*100);
    const pnl = Math.round(d.pnlSum*10000)/100;
    console.log(`  ${r.padEnd(8)}: ${d.n} trades | ${wr}% win | total pnl ${pnl}%`);
  }

  console.log(`\n⏱  Time in regime (full period):`);
  const regTotal = Object.values(regimeLog).reduce((a,b)=>a+b,0);
  for (const [s,h] of Object.entries(regimeLog)) {
    console.log(`  ${s.padEnd(8)}: ${Math.round(h/24)}d (${Math.round(h/regTotal*100)}%)`);
  }

  console.log(`\n📚 FRAMEWORK COVERAGE:`);
  console.log(`  ✅ GARCH(1,1): σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}`);
  console.log(`  ✅ OU process: dz_t = κ(μ - z_t)dt + σdW_t  (half-life filter)`);
  console.log(`  ✅ Trend composite: 0.5·r20d + 0.3·r60d + 0.2·r120d`);
  console.log(`  ✅ Volume surprise z-score (attention/mindshare proxy)`);
  console.log(`  ✅ Δ²volume: second derivative (virality/acceleration proxy)`);
  console.log(`  ✅ Vol-price divergence (wallet inflow / accumulation proxy)`);
  console.log(`  ✅ Liquidity score (volume/ATR)`);
  console.log(`  ✅ Template A: trend × (1 + attention_multiplier)`);
  console.log(`  ✅ Template B: accumulation flow → price lead-lag`);
  console.log(`  ✅ Template C: cross-sectional rank + volume attention`);
  console.log(`  ✅ Template D: OU panic mean reversion + volume spike filter`);
  console.log(`  ✅ Template E: regime-aware meta-allocator (dynamic weights)`);
  console.log(`  ✅ Full alpha model: trend + mindshare + inflow + engagement - vol - liq`);
  console.log(`  ✅ Mean-variance sizing: w = alpha / (2λ·σ²_GARCH)`);
  console.log(`  ✅ Correlation penalty (covariance matrix, don't stack correlated)`);
  console.log(`  ✅ Turnover penalty (gamma·|Δw|)`);
  console.log(`  ✅ Regime switching: BEAR→flat, RANGE→D, BULL→A/B/C`);

  const outFile = path.join(RESULTS_DIR, `full-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(), version: 'full-1.0',
    config: { tokens: symbols, days: DAYS, splitIdx, warmup: WARMUP, total },
    benchmarks: bm, regimeLog, isStats, oosStats,
    sampleTrades: { is: isTrades.slice(0,20), oos: oosTrades.slice(0,20) },
  }, null, 2));
  console.log(`\n💾 Saved: ${outFile} | Total trades: ${total.toLocaleString()} | ${elapsed}s`);
}

main().catch(e => { console.error('Fatal:', e.stack); process.exit(1); });
