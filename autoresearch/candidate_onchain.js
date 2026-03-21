/**
 * candidate_onchain.js — Onchain signal candidate (Base tokens, Alchemy 1h data)
 *
 * Returns score in [-1, +1]
 * Data: Alchemy Base mainnet 1h price history (30 days, 720 bars)
 * Universe: WETH, AERO, VIRTUAL, AIXBT, BRETT, DEGEN, TOSHI, KTA, MOLT, etc.
 * 
 * Key difference from daily candidate:
 *   - Volume proxy = relative price change (Alchemy has no raw volume)
 *   - btcPrices = WETH prices (reference token on Base)
 *   - Shorter lookbacks (48h instead of 30d)
 */

'use strict';

function sma(prices, period) {
  const n = Math.min(period, prices.length);
  return prices.slice(-n).reduce((s, p) => s + p, 0) / n;
}

function rsi(prices, period) {
  if (prices.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / period) / (l / period));
}

function relStrength(prices, ref, period) {
  if (prices.length < period || ref.length < period) return 0;
  const n = prices.length, r = ref.length;
  const tokenRet = prices[n-1] > 0 ? (prices[n-1] - prices[n-period]) / prices[n-period] : 0;
  const refRet   = ref[r-1]   > 0 ? (ref[r-1]   - ref[r-period])   / ref[r-period]   : 0;
  return tokenRet - refRet;
}

function scoreToken(data) {
  const { prices, volumes, btcPrices } = data;
  if (!prices || prices.length < 48) return 0;

  const weth = btcPrices || prices; // WETH as reference on Base

  // RSI-8 (Nunchi #1 hypothesis — proven on hourly data)
  const rsi8 = rsi(prices, 8);

  // Relative strength vs WETH: 12h and 48h windows
  const rs12 = relStrength(prices, weth, 12);
  const rs48 = relStrength(prices, weth, 48);

  // Volume (price-change proxy from Alchemy): recent vs baseline
  const volNow  = volumes ? volumes.slice(-4).reduce((s, v) => s + v, 0) / 4 : 1;
  const volBase = volumes ? volumes.slice(-48).reduce((s, v) => s + v, 0) / 48 : 1;
  const volRatio = volBase > 0 ? volNow / volBase : 1;

  // Trend: 12h vs 48h SMA
  const sma12 = sma(prices, 12);
  const sma48 = sma(prices, 48);
  const trend = sma12 > sma48 ? 1 : -1;

  // Score components
  const sRSI  = (50 - rsi8) / 50;                                         // [-1, +1]
  const sRS   = Math.max(-1, Math.min(1, (rs12 * 0.6 + rs48 * 0.4) * 15)); // [-1, +1]
  const sVol  = Math.min(1, Math.max(-0.5, (volRatio - 1) * 0.5));
  const sTrend = trend * 0.3;

  const score = sRS * 0.45 + sRSI * 0.25 + sVol * 0.15 + sTrend * 0.15;
  return Math.max(-1, Math.min(1, score));
}

module.exports = { scoreToken };
