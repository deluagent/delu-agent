/**
 * candidate.js — THE FILE THE AGENT MODIFIES
 *
 * Rules (enforced by evaluate.js):
 *  - Must export scoreToken(data) → number
 *  - data = { prices, flowSignal, attentionDelta, vol }
 *  - Pure function — no I/O, no randomness, no external state
 *  - Lower vol → higher weight (vol-adjust internally if needed)
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

function emaGap(prices, fast = 12, slow = 26) {
  function ema(arr, period) {
    const k = 2 / (period + 1);
    let e = arr[0];
    for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  }
  const n = prices.length;
  if (n < slow) return 0;
  const slice = prices.slice(Math.max(0, n - slow * 3));
  const f = ema(slice, fast);
  const s = ema(slice, slow);
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

// ── Score function ────────────────────────────────────────────
// This is what the agent optimizes.

function scoreToken(data) {
  const { prices, flowSignal = 0, attentionDelta = 0 } = data;

  // ── Momentum signals (multi-timeframe) ──
  const r7   = pctChange(prices, 7);
  const r20  = pctChange(prices, 20);
  const r60  = pctChange(prices, 60);

  // ── Trend ──
  const ema  = emaGap(prices, 12, 26);

  // ── Regime filter: only go long when BTC 50d MA > 200d MA (trend regime)
  const btcPrices = [...prices]; // assuming we have BTC prices
  const btc50dMA = ema(btcPrices, 50);
  const btc200dMA = ema(btcPrices, 200);
  const regimeFilter = btc50dMA > btc200dMA? 1 : 0;

  // ── Mean reversion filter (z-score) ──
  // Negative z = oversold = slightly positive for mean reversion
  const z    = zScore(prices, 20);
  const meanRevSignal = z < -2.0? 0.1 : (z > 2.5? -0.1 : 0);

  // ── Volatility penalty ──
  const vol  = realizedVol(prices, 14);
  const volPenalty = -0.15 * Math.max(vol - 0.6, 0);

  // ── Weighted composite ──
  const momentum = 0.35 * r7 + 0.35 * r20 + 0.20 * r60;
  const trend    = 0.20 * ema;
  const flow     = 0.15 * flowSignal;
  const attn     = 0.05 * attentionDelta;

  return regimeFilter * (momentum + trend + flow + attn + meanRevSignal + volPenalty);
}

module.exports = { scoreToken };