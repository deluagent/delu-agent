/**
 * candidate.js — THE FILE THE AGENT MODIFIES
 *
 * Rules (enforced by evaluate.js):
 *  - Must export scoreToken(data) → number
 *  - data = { prices, btcPrices, flowSignal, attentionDelta }
 *  - prices / btcPrices: float[] of daily closes, oldest first
 *  - Pure function — no I/O, no randomness, no external state
 *
 * The evaluator measures validation Sharpe on held-out data.
 * Improve it. Every committed version is tracked in git history.
 */

// ── Helpers ──────────────────────────────────────────────────

function pctChange(prices, lookback) {
  const n = prices.length;
  if (n <= lookback) return 0;
  const prev = prices[n - 1 - lookback];
  return prev === 0? 0 : (prices[n - 1] - prev) / prev;
}

function realizedVol(prices, window = 14) {
  const n = prices.length;
  if (n < window + 1) return 0.5;
  const rets = [];
  for (let i = n - window; i < n; i++) {
    if (prices[i - 1] > 0) rets.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (rets.length === 0) return 0.5;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance * 252);
}

function sma(prices, period) {
  const n = prices.length;
  if (n < period) return prices[n - 1] || 0;
  return prices.slice(n - period).reduce((s, p) => s + p, 0) / period;
}

function emaVal(prices, period) {
  const k = 2 / (period + 1);
  let e = prices[0];
  for (let i = 1; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

function emaGap(prices, fast = 12, slow = 26) {
  const n = prices.length;
  if (n < slow) return 0;
  const slice = prices.slice(Math.max(0, n - slow * 3));
  const f = emaVal(slice, fast);
  const s = emaVal(slice, slow);
  return s === 0? 0 : (f - s) / s;
}

function zScore(prices, window = 20) {
  const n = prices.length;
  if (n < window) return 0;
  const slice = prices.slice(n - window);
  const mean = slice.reduce((s, p) => s + p, 0) / window;
  const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / window);
  return std === 0? 0 : (prices[n - 1] - mean) / std;
}

// ── Score function ─────────────────────────────────────────���──

function scoreToken(data) {
  const { prices, btcPrices = [], flowSignal = 0, attentionDelta = 0 } = data;

  // ── Regime filter: only trade when BTC is in uptrend (50d > 200d MA) ──
  let regimeOk = true;
  if (btcPrices.length >= 200) {
    const btc50  = sma(btcPrices, 50);
    const btc200 = sma(btcPrices, 200);
    regimeOk = btc50 > btc200;
  }
  if (!regimeOk) return 0;

  // ── Momentum (multi-timeframe) ──
  const r7  = pctChange(prices, 7);
  const r20 = pctChange(prices, 20);
  const r60 = pctChange(prices, 60);

  // ── Trend ──
  const ema = emaGap(prices, 12, 26);

  // ── Mean reversion ──
  const z = zScore(prices, 20);
  const meanRev = z < -2.0? 0.1 : (z > 2.5? -0.1 : 0);

  // ── Volatility penalty ──
  const vol = realizedVol(prices, 14);
  const volPenalty = -0.15 * Math.max(vol - 0.6, 0);

  // ── Vol-adjusted momentum ──
  const momentum = 0.35 * r7 / (1 + vol) + 0.35 * r20 / (1 + vol) + 0.20 * r60 / (1 + vol);
  const trend    = 0.20 * ema;
  const flow     = 0.15 * flowSignal;
  const attn     = 0.05 * attentionDelta;

  // Introduce a trend strength filter to avoid choppy/flat periods
  const trendStrength = Math.abs(ema);
  const trendStrengthThreshold = 0.05;
  if (trendStrength < trendStrengthThreshold) return 0;

  return momentum + trend + flow + attn + meanRev + volPenalty;
}

module.exports = { scoreToken };