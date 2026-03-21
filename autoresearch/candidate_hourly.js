/**
 * candidate_hourly.js — Intraday signal candidate for hourly autoresearch
 *
 * This is the EVOLVING file for the hourly loop.
 * Signals tuned for 1h bars, 4h rebalance cadence.
 *
 * Key differences from daily candidate:
 *  - Shorter lookback windows (hours not days)
 *  - Volume burst detection (spikes vs 24h avg)
 *  - Momentum acceleration (rate of change of momentum)
 *  - Microstructure: high/low range compression as breakout precursor
 *  - 4h/24h/7d momentum hierarchy
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
  const { prices, volumes, highs, lows, btcPrices, flowSignal, attentionDelta } = data;
  const n = prices.length;
  if (n < 48) return 0;  // need at least 48h of data

  // ── Momentum signals (multi-horizon) ────────────────────────
  // 4h return (immediate momentum)
  const ret4h  = n >= 5  ? (prices[n-1] - prices[n-5])  / prices[n-5]  : 0;
  // 24h return
  const ret24h = n >= 25 ? (prices[n-1] - prices[n-25]) / prices[n-25] : 0;
  // 7d return (168h)
  const ret7d  = n >= 169 ? (prices[n-1] - prices[n-169]) / prices[n-169] : 0;

  // Momentum score: weight recent more heavily
  const momScore = 0.5 * Math.tanh(ret4h * 20) + 0.3 * Math.tanh(ret24h * 8) + 0.2 * Math.tanh(ret7d * 3);

  // ── EMA trend ────────────────────────────────────────────────
  // 12h EMA vs 48h EMA (fast/slow crossover on hourly bars)
  const ema12  = ema(prices.slice(-12),  12);
  const ema48  = ema(prices.slice(-48),  48);
  const ema168 = n >= 168 ? ema(prices.slice(-168), 168) : ema48;
  const emaGap12_48  = (ema12 - ema48) / ema48;
  const emaGap48_168 = (ema48 - ema168) / ema168;

  // Trend alignment: both fast>slow = strong uptrend
  const trendScore = Math.tanh(emaGap12_48 * 15) * 0.6 + Math.tanh(emaGap48_168 * 10) * 0.4;

  // ── Volume confirmation ──────────────────────────────────────
  // Volume surge: last 4h vs 24h average
  const vol4h_avg  = volumes.slice(-4).reduce((s, v) => s + v, 0) / 4;
  const vol24h_avg = volumes.slice(-24).reduce((s, v) => s + v, 0) / 24;
  const volRatio   = vol24h_avg > 0 ? vol4h_avg / vol24h_avg : 1;
  // Volume surge during upward price move = real demand
  const volConfirm = ret4h > 0 && volRatio > 1.5 ? Math.log(volRatio) * 0.3 : 0;

  // ── OBV momentum ────────────────────────────────────────────
  // OBV over last 24h vs prior 24h
  let obv = 0, obvArr = [];
  const obvWindow = Math.min(n, 48);
  for (let i = n - obvWindow; i < n; i++) {
    obv += volumes[i] * (prices[i] > prices[i-1] ? 1 : prices[i] < prices[i-1] ? -1 : 0);
    obvArr.push(obv);
  }
  const obvMom = obvArr.length >= 24
    ? (obvArr.slice(-1)[0] - obvArr[Math.floor(obvArr.length/2)]) / (Math.abs(obvArr[Math.floor(obvArr.length/2)]) + 1)
    : 0;
  const obvScore = Math.tanh(obvMom * 5) * 0.3;

  // ── Range compression (breakout precursor) ──────────────────
  // Narrow range in last 4h vs 24h → coiling for a move
  const range4h  = Math.max(...highs.slice(-4))  - Math.min(...lows.slice(-4));
  const range24h = Math.max(...highs.slice(-24)) - Math.min(...lows.slice(-24));
  const rangeRatio = range24h > 0 ? range4h / range24h : 1;
  // Low range ratio + price near top of range = bullish coil
  const priceInRange = range24h > 0 ? (prices[n-1] - Math.min(...lows.slice(-24))) / range24h : 0.5;
  const coilScore = rangeRatio < 0.3 && priceInRange > 0.7 ? 0.15 : 0;

  // ── Momentum acceleration ────────────────────────────────────
  // Is the 4h momentum increasing vs 4h ago?
  const ret4h_prev = n >= 9 ? (prices[n-5] - prices[n-9]) / prices[n-9] : 0;
  const momAccel   = ret4h - ret4h_prev;
  const accelScore = Math.tanh(momAccel * 30) * 0.1;

  // ── BTC correlation gate ─────────────────────────────────────
  // Don't fight BTC: if BTC strongly down, reduce alt signal
  const btcN = btcPrices.length;
  const btcRet4h = btcN >= 5 ? (btcPrices[btcN-1] - btcPrices[btcN-5]) / btcPrices[btcN-5] : 0;
  const btcGate  = btcRet4h < -0.02 ? 0.6 : 1.0;  // 40% penalty if BTC down >2% in 4h

  // ── Flow & attention boost ───────────────────────────────────
  const flowBoost = (flowSignal || 0) * 0.1;
  const attnBoost = Math.min(0.1, (attentionDelta || 0) * 0.02);

  // ── Combined score ───────────────────────────────────────────
  const raw = (
    momScore   * 0.30 +
    trendScore * 0.25 +
    obvScore   * 0.20 +
    volConfirm * 0.15 +
    coilScore  +
    accelScore +
    flowBoost  +
    attnBoost
  ) * btcGate;

  // Normalise to [0, 1]
  return Math.max(0, Math.min(1, (raw + 0.5) / 1.2));
}

module.exports = { scoreToken };
