/**
 * candidate_5m.js — 5-minute intraday signal candidate (LONG/SHORT)
 *
 * Score in [-1, +1]:
 *   +1 = strong long
 *    0 = neutral
 *   -1 = strong short
 *
 * Data: 5m bars, 30 days (8640 bars)
 * Rebalance: every 12 bars = 1 hour
 * All periods: Feb-Mar 2026 (slight bull → slight bear)
 *
 * Key 5m signals unavailable at daily/hourly:
 * - Volume burst (last 12 bars vs prior 48 bars = 1h vs 4h avg)
 * - Micro-momentum (5m / 15m / 1h return hierarchy)
 * - Range expansion vs compression
 * - Candlestick body ratio (conviction vs indecision)
 */

'use strict';

function ema(prices, period) {
  const k = 2 / (period + 1);
  let val = prices[0];
  for (let i = 1; i < prices.length; i++) val = prices[i] * k + val * (1 - k);
  return val;
}

function sma(prices, period) {
  const s = prices.slice(-period);
  return s.reduce((a, b) => a + b, 0) / s.length;
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
  const std = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
  return (arr[n - 1] - mean) / std;
}

function scoreToken(data) {
  const { prices, volumes, highs, lows, opens, btcPrices } = data;
  const n  = prices.length;
  const bN = (btcPrices || []).length;

  if (n < 288 || bN < 288) return 0;

  // ── Core momentum: 1h and 4h only (avoid 5m/15m noise) ──────
  const ret12 = (prices[n-1] - prices[n-13]) / prices[n-13];  // 1h
  const ret48 = n >= 49 ? (prices[n-1] - prices[n-49]) / prices[n-49] : 0; // 4h

  // Strengthen alignment requirement - zero out if opposing signals
  const aligned = (ret12 > 0 && ret48 > 0) || (ret12 < 0 && ret48 < 0);
  if (!aligned) return 0;
  
  const momScore = Math.tanh(ret12 * 30) * 0.6 + Math.tanh(ret48 * 10) * 0.4;

  // ── Volume burst (12 bars vs 48 bars) ───────────────────────
  const vol12 = volumes.slice(-12).reduce((s, v) => s + v, 0) / 12;
  const vol48 = volumes.slice(-60, -12).reduce((s, v) => s + v, 0) / 48;
  const burst  = vol12 / (vol48 || 1);
  const dir12  = ret12 > 0 ? 1 : ret12 < 0 ? -1 : 0;
  const volSignal = Math.tanh((burst - 1.2) * dir12 * 4) * 0.25;

  // ── Relative strength vs BTC (4h horizon) ────────────────────
  const tokenRet48 = ret48;
  const btcRet48   = bN >= 49 ? (btcPrices[bN-1] - btcPrices[bN-49]) / btcPrices[bN-49] : 0;
  const relBTC     = Math.tanh((tokenRet48 - btcRet48) * 25) * 0.15;

  // ── VWAP deviation (1h window) ───────────────────────────────
  let sumPV = 0, sumV = 0;
  for (let i = n - 12; i < n; i++) {
    sumPV += prices[i] * volumes[i];
    sumV  += volumes[i];
  }
  const vwap = sumV > 0 ? sumPV / sumV : prices[n-1];
  const vwapDev = (prices[n-1] - vwap) / vwap;
  const vwapSignal = Math.tanh(vwapDev * 50) * 0.2;

  // ── BTC gate: stricter threshold + early exit on strong downtrend ────────────────
  const btcRet12 = bN >= 13 ? (btcPrices[bN-1] - btcPrices[bN-13]) / btcPrices[bN-13] : 0;
  let btcGate = 1.0;
  if (btcRet12 < -0.015) btcGate = 0.0;
  else if (btcRet12 < -0.010) btcGate = 0.1;
  else if (btcRet12 > 0.020) btcGate = 0.5;

  // ── Momentum magnitude filter: INCREASE threshold to 0.55 ──────
  if (Math.abs(momScore) < 0.55) return 0;

  const score = momScore + volSignal + relBTC + vwapSignal;
  return Math.max(-1, Math.min(1, score * btcGate));
}

module.exports = { scoreToken };