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

  // ── RSI-8 for short-term momentum (intraday sweet spot) ──────
  const rsi8 = computeRSI(prices, 8);
  const rsiSignal = rsi8 > 65 ? 1 : rsi8 < 35 ? -1 : 0;

  // ── Bollinger Bands width compression (breakout precursor) ───
  const bb20 = computeBB(prices, 20, 2);
  const bbWidth = bb20.upper - bb20.lower;
  const bbWidthMA = computeSimpleMA(prices.slice(-50).map((p, i) => {
    const b = computeBB(prices.slice(0, Math.max(20, i - 18)), 20, 2);
    return b.upper - b.lower;
  }), 20);
  const bbCompression = bbWidth < bbWidthMA * 0.5 ? 1 : 0;

  // ── Simple price momentum (last 4h vs last 24h) ──────────────
  const mom4h = (prices[n-1] - prices[n-5]) / prices[n-5];
  const mom24h = (prices[n-1] - prices[n-48]) / prices[n-48];
  const momSignal = mom4h > mom24h * 0.5 ? 1 : mom4h < mom24h * -0.5 ? -1 : 0;

  // ── Volume burst (simple threshold) ──────────────────────────
  const vol4h  = volumes.slice(-4).reduce((s, v) => s + v, 0) / 4;
  const vol48h = volumes.slice(-48).reduce((s, v) => s + v, 0) / 48;
  const volBurst = vol4h > vol48h * 1.5 ? 1 : vol4h < vol48h * 0.65 ? -1 : 0;

  // ── Price above/below 20-SMA (trend filter) ──────────────────
  const sma20 = computeSimpleMA(prices, 20);
  const trendSignal = prices[n-1] > sma20 ? 1 : prices[n-1] < sma20 ? -1 : 0;

  // ── Ensemble voting (strict majority: need 3+ of 5 signals) ───
  const signals = [rsiSignal, bbCompression, momSignal, volBurst, trendSignal];
  const voteSum = signals.reduce((s, sig) => s + sig, 0);
  const ensembleScore = voteSum >= 3 ? 1 : voteSum <= -3 ? -1 : 0;

  return ensembleScore;
}

function computeRSI(prices, period) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i-1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain > 0 ? 100 : 0;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function computeBB(prices, period, stdDev) {
  if (prices.length < period) return { upper: 0, lower: 0, middle: 0 };
  const middle = computeSimpleMA(prices.slice(-period), period);
  let sumSq = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    sumSq += Math.pow(prices[i] - middle, 2);
  }
  const std = Math.sqrt(sumSq / period);
  return {
    upper: middle + std * stdDev,
    lower: middle - std * stdDev,
    middle: middle
  };
}

function computeSimpleMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  let sum = 0;
  for (let i = Math.max(0, prices.length - period); i < prices.length; i++) {
    sum += prices[i];
  }
  return sum / Math.min(period, prices.length);
}

module.exports = { scoreToken };