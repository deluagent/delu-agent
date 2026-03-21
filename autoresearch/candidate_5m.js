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

  // Need at least 288 bars (1 day of 5m) for meaningful signals
  if (n < 288 || bN < 288) return 0;

  // ── Micro-momentum hierarchy ─────────────────────────────────
  // 5m (1 bar), 15m (3 bars), 1h (12 bars), 4h (48 bars)
  const ret1  = (prices[n-1] - prices[n-2])  / prices[n-2];   // 5m
  const ret3  = (prices[n-1] - prices[n-4])  / prices[n-4];   // 15m
  const ret12 = (prices[n-1] - prices[n-13]) / prices[n-13];  // 1h
  const ret48 = n >= 49 ? (prices[n-1] - prices[n-49]) / prices[n-49] : 0; // 4h

  // Hierarchy: all pointing same direction = conviction
  const momScore = Math.tanh(ret1*200)*0.15
                 + Math.tanh(ret3*80)*0.25
                 + Math.tanh(ret12*30)*0.35
                 + Math.tanh(ret48*10)*0.25;

  // ── Volume burst ─────────────────────────────────────────────
  // Last 12 bars (1h) vs prior 48 bars (4h avg)
  const vol12 = volumes.slice(-12).reduce((s, v) => s + v, 0) / 12;
  const vol48 = volumes.slice(-60, -12).reduce((s, v) => s + v, 0) / 48;
  const burst  = vol12 / (vol48 || 1);
  const dir12  = ret12 > 0 ? 1 : ret12 < 0 ? -1 : 0;
  const volSignal = Math.tanh((burst - 1) * dir12 * 3) * 0.2;

  // ── Relative strength vs BTC ─────────────────────────────────
  const tokenRet48 = ret48;
  const btcRet48   = bN >= 49 ? (btcPrices[bN-1] - btcPrices[bN-49]) / btcPrices[bN-49] : 0;
  const relBTC     = Math.tanh((tokenRet48 - btcRet48) * 20) * 0.2;

  // ── Range compression/expansion ──────────────────────────────
  // Tight range (coiling) before breakout = signal
  const hiLo12  = Math.max(...highs.slice(-12)) - Math.min(...lows.slice(-12));
  const hiLo48  = Math.max(...highs.slice(-60,-12)) - Math.min(...lows.slice(-60,-12));
  const rangeRatio = hiLo12 / (hiLo48 || 1);
  // Breakout: range just expanded AND direction is up
  const breakout = rangeRatio > 1.5 && ret12 > 0 ? 0.1 : 0;

  // ── BTC gate ─────────────────────────────────────────────────
  const btcRet12 = bN >= 13 ? (btcPrices[bN-1] - btcPrices[bN-13]) / btcPrices[bN-13] : 0;
  const btcGate  = btcRet12 < -0.015 ? 0.5 : 1.0; // halve score if BTC dumping >1.5% this hour

  const score = (momScore + volSignal + relBTC + breakout) * btcGate;
  return Math.max(-1, Math.min(1, score));
}

module.exports = { scoreToken };
