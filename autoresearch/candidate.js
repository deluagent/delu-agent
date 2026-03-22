/**
 * candidate.js — THE FILE THE AGENT MODIFIES
 *
 * Rules (enforced by evaluate.js):
 *  - Must export scoreToken(data) -- returns number
 *  - data = { prices, volumes, opens, highs, lows, btcPrices, flowSignal, attentionDelta }
 *  - prices / btcPrices: float[] of daily closes, oldest first
 *  - flowSignal: Binance perp funding rate z-score, INVERTED [-1,+1]
 *    Positive = bullish (negative funding = shorts paying = buy signal)
 *  - Pure function — no I/O, no randomness, no external state
 *
 * The evaluator measures validation Sharpe on held-out data.
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

/**
 * Net Volume Flow (OBV-style)
 * Measures the percentage of volume that occurred on "up" days over a window.
 */
function calculateObvSig(prices, volumes, window = 20) {
  const n = prices.length;
  if (n < window + 1 || volumes.length < n) return 0;
  let obvDelta = 0;
  let totalVol = 0;
  for (let i = n - window; i < n; i++) {
    totalVol += volumes[i];
    if (prices[i] > prices[i - 1]) {
      obvDelta += volumes[i];
    } else if (prices[i] < prices[i - 1]) {
      obvDelta -= volumes[i];
    }
  }
  return totalVol > 0 ? obvDelta / totalVol : 0;
}

function scoreToken(data) {
  const { 
    prices, 
    volumes = [], 
    btcPrices = [],
    flowSignal = 0,
    highs = [],
    lows = []
  } = data;
  
  const n = prices.length;
  if (n < 60) return 0;

  const vol = realizedVol(prices, 14);
  const r7 = pctChange(prices, 7);

  let isBear = false;
  if (btcPrices.length >= 200) {
    const btc50  = sma(btcPrices, 50);
    const btc200 = sma(btcPrices, 200);
    if (btc50 < btc200) {
      isBear = true;
    }
  }

  if (vol > 0.80) return 0;

  if (r7 < -0.20) return 0;

  const ema = emaGap(prices, 12, 26);
  if (Math.abs(ema) < 0.03) return 0;

  const r3 = pctChange(prices, 3);
  const r20 = pctChange(prices, 20);
  const r60 = pctChange(prices, Math.min(60, n - 1));

  const momentum = vol > 0.75
    ? (0.60 * r3 + 0.40 * r7) / (1 + vol)
    : (0.30 * r7 + 0.40 * r20 + 0.30 * r60) / (1 + vol);

  const trend = 0.20 * ema;

  const z = zScore(prices, 20);
  const meanRev = z < -1.8 ? 0.10 : (z > 2.5 ? -0.08 : 0);

  const fundingBoost = isBear
    ? (flowSignal > 0 ? 0.15 * flowSignal : -0.15 * Math.abs(flowSignal))
    : 0.10 * flowSignal;

  const r1 = pctChange(prices, 1);
  const high52 = Math.max(...prices.slice(Math.max(0, n - 252)));
  const pctFromHigh = (high52 - prices[n - 1]) / (high52 || 1);
  const highProximity = !isBear && pctFromHigh < 0.12 ? 0.01 : 0;

  let volSurprise = 0;
  if (volumes.length >= 20) {
    const avgVol20 = volumes.slice(Math.max(0, n - 20)).reduce((a, b) => a + b, 0) / Math.min(20, n);
    const recentVol = volumes[n - 1];
    const volRatio = recentVol / (avgVol20 || 1);
    if (r7 > 0.02 && volRatio > 1.40) {
      volSurprise = 0.12;
    }
  }

  const raw = momentum + trend + meanRev + fundingBoost + highProximity + volSurprise;
  
  return Math.max(0, raw);
}

module.exports = { scoreToken };