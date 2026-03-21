/**
 * candidate_hourly.js — Intraday signal candidate (LONG/SHORT, hourly bars)
 *
 * Returns score in [-1, +1]:
 *   +1 = strong long (buy)
 *    0 = neutral (hold cash)
 *   -1 = strong short (sell)
 *
 * Data: 1h bars, 180 days (4320 bars)
 * Rebalance: every 4h
 * All periods = BEAR (Sep 2025 → Mar 2026)
 * Key signal: relative strength vs BTC + volume direction
 */

'use strict';

function ema(prices, period) {
  const k = 2 / (period + 1);
  let val = prices[0];
  for (let i = 1; i < prices.length; i++) val = prices[i] * k + val * (1 - k);
  return val;
}

function sma(prices, period) {
  const slice = prices.slice(-period);
  return slice.reduce((s, p) => s + p, 0) / slice.length;
}

function realizedVol(prices, period) {
  const n = Math.min(period, prices.length - 1);
  let sum = 0;
  for (let i = prices.length - n; i < prices.length; i++) {
    const r = Math.log(prices[i] / prices[i - 1]);
    sum += r * r;
  }
  return Math.sqrt(sum / n);
}

function zScore(arr) {
  const n = arr.length;
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const std  = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return std > 0 ? (arr[n - 1] - mean) / std : 0;
}

function scoreToken(data) {
  const { prices, volumes, highs, lows, opens, btcPrices } = data;
  const n  = prices.length;
  const bN = (btcPrices || []).length;
  if (n < 169 || bN < 169) return 0;

  // ── Relative strength vs BTC (7d) ───────────────────────────
  // Core bear signal: which tokens are bleeding less (or gaining) vs BTC
  const tokenRet7d = (prices[n-1] - prices[n-169]) / prices[n-169];
  const btcRet7d   = (btcPrices[bN-1] - btcPrices[bN-169]) / btcPrices[bN-169];
  const relStr7d   = tokenRet7d - btcRet7d; // positive = outperforming BTC

  // ── Relative strength vs BTC (4h) ───────────────────────────
  const tokenRet4h = n >= 5 ? (prices[n-1] - prices[n-5]) / prices[n-5] : 0;
  const btcRet4h   = bN >= 5 ? (btcPrices[bN-1] - btcPrices[bN-5]) / btcPrices[bN-5] : 0;
  const relStr4h   = tokenRet4h - btcRet4h;

  // ── Volume direction ─────────────────────────────────────────
  const vol4h  = volumes.slice(-4).reduce((s, v) => s + v, 0) / 4;
  const vol48h = volumes.slice(-48).reduce((s, v) => s + v, 0) / 48;
  const volBurst = vol4h / (vol48h || 1);
  const dir4h    = tokenRet4h > 0 ? 1 : tokenRet4h < 0 ? -1 : 0;
  const volSignal = Math.tanh((volBurst - 1) * dir4h * 2); // positive when volume confirms direction

  // ── Combined score [-1, +1] ──────────────────────────────────
  const score = Math.tanh(relStr7d * 5) * 0.5    // 7d relative strength (primary)
              + Math.tanh(relStr4h * 30) * 0.3   // 4h relative strength (momentum)
              + volSignal * 0.2;                  // volume confirmation

  return Math.max(-1, Math.min(1, score));
}

module.exports = { scoreToken };
