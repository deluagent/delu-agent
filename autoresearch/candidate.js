/**
 * candidate.js — THE FILE THE AGENT MODIFIES
 *
 * Rules (enforced by evaluate.js):
 *  - Must export scoreToken(data) → number
 *  - data = { prices, btcPrices, flowSignal, attentionDelta }
 *  - prices / btcPrices: float[] of daily closes, oldest first
 *  - flowSignal: Binance perp funding rate z-score, INVERTED [-1,+1]
 *    Positive = bullish (negative funding = shorts paying = buy signal)
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
  return prev === 0 ? 0 : (prices[n - 1] - prev) / prev;
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
  return s === 0 ? 0 : (f - s) / s;
}

function zScore(prices, window = 20) {
  const n = prices.length;
  if (n < window) return 0;
  const slice = prices.slice(n - window);
  const mean = slice.reduce((s, p) => s + p, 0) / window;
  const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / window);
  return std === 0 ? 0 : (prices[n - 1] - mean) / std;
}

// ── Score function ─────────────────────────────────────────────

function scoreToken(data) {
  const { prices, btcPrices = [], flowSignal = 0 } = data;
  const n = prices.length;
  if (n < 60) return 0;

  // ── Regime detection: BTC Price vs 200d MA ──
  // Updated to match the "BTC below 200d MA" definition for BEAR regime
  let regimeMult = 1.0;
  let isBear = false;
  if (btcPrices.length >= 200) {
    const btcPrice = btcPrices[btcPrices.length - 1];
    const btc200 = sma(btcPrices, 200);
    if (btcPrice < btc200) {
      isBear = true;
      regimeMult = 0.3; // BEAR penalty
    }
  }

  // ── Trend strength filter ──
  const ema = emaGap(prices, 12, 26);
  if (Math.abs(ema) < 0.015) return 0; // Lowered from 0.03 to be more inclusive of emerging trends

  // ── Momentum (multi-timeframe, vol-adjusted) ──
  // Shifted weights to favor the medium-term (20d) trend for validation period stability
  const vol = realizedVol(prices, 14);
  const r7   = pctChange(prices, 7);
  const r20  = pctChange(prices, 20);
  const r60  = pctChange(prices, Math.min(60, n - 1));

  const momentum = 0.25 * r7 / (1 + vol)
                 + 0.50 * r20 / (1 + vol)
                 + 0.25 * r60 / (1 + vol);

  // ── Trend ──
  const trend = 0.20 * ema;

  // ── Mean reversion ──
  // Removed overbought penalty (z > 2.5) as it often cuts winners in momentum regimes
  const z = zScore(prices, 20);
  const meanRev = z < -2.0 ? 0.10 : 0;

  // ── Volatility penalty ──
  // Increased threshold as many high-performing tokens have vol > 0.6
  const volPenalty = -0.15 * Math.max(vol - 0.75, 0);

  // ── Funding rate signal ──
  const fundingBoost = isBear
    ? (flowSignal > 0 ? 0.15 * flowSignal : -0.10 * Math.abs(flowSignal))
    : 0.10 * flowSignal;

  // ── Combined ──
  const raw = momentum + trend + meanRev + volPenalty + fundingBoost;
  return raw * regimeMult;
}

module.exports = { scoreToken };