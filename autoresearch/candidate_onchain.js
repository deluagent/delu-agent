/**
 * candidate_onchain.js — Onchain signal candidate (Base tokens, Alchemy data)
 *
 * Returns score in [-1, +1]
 * Data: Alchemy Base mainnet 1h price history (30 days, ~720 bars)
 * Universe: WETH, AERO, VIRTUAL, AIXBT, BRETT, DEGEN, TOSHI, KTA, MOLT, etc.
 *
 * Available signals:
 *   prices[]    — hourly close prices (real onchain from Alchemy)
 *   volumes[]   — relative activity proxy (price-change magnitude)
 *   highs[]     — hourly high (approx: max of open/close)
 *   lows[]      — hourly low  (approx: min of open/close)
 *   btcPrices[] — WETH prices (reference token on Base)
 *   transferStats — smart wallet signals (latest snapshot):
 *     .uniqueBuyers         — distinct wallets that bought (last 500 txs)
 *     .transferVelocity     — total transfer count (higher = more active)
 *     .repeatBuyers         — wallets that bought 3+ times (accumulation signal)
 *     .topBuyerConcentration — 0=distributed, 1=one whale dominates
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
  const { prices, volumes, btcPrices, transferStats } = data;
  if (!prices || prices.length < 48) return 0;

  const weth = btcPrices || prices;

  // RSI-8 (Nunchi #1 — proven on hourly intraday data)
  const rsi8 = rsi(prices, 8);

  // Relative strength vs WETH: 12h and 48h
  const rs12 = relStrength(prices, weth, 12);
  const rs48 = relStrength(prices, weth, 48);

  // Volume (price-change proxy): recent vs baseline
  const volNow  = volumes ? volumes.slice(-4).reduce((s, v) => s + v, 0) / 4 : 1;
  const volBase = volumes ? volumes.slice(-48).reduce((s, v) => s + v, 0) / 48 : 1;
  const volRatio = volBase > 0 ? volNow / volBase : 1;

  // Trend
  const sma12 = sma(prices, 12);
  const sma48 = sma(prices, 48);
  const trend = sma12 > sma48 ? 1 : -1;

  // Smart wallet accumulation signal
  // repeatBuyers > 2 = wallets accumulating (bullish)
  // topBuyerConcentration > 0.3 = single whale dominating (can be pump-and-dump risk)
  let smartWalletBoost = 0;
  if (transferStats) {
    const accumulationSignal = Math.min(1, (transferStats.repeatBuyers || 0) / 5);
    const concentrationRisk  = transferStats.topBuyerConcentration > 0.3 ? -0.2 : 0;
    smartWalletBoost = accumulationSignal * 0.3 + concentrationRisk;
  }

  // Score
  const sRSI  = (50 - rsi8) / 50;
  const sRS   = Math.max(-1, Math.min(1, (rs12 * 0.6 + rs48 * 0.4) * 15));
  const sVol  = Math.min(1, Math.max(-0.5, (volRatio - 1) * 0.5));
  const sTrend = trend * 0.3;

  const score = sRS * 0.40 + sRSI * 0.25 + sVol * 0.10 + sTrend * 0.10 + smartWalletBoost * 0.15;
  return Math.max(-1, Math.min(1, score));
}

module.exports = { scoreToken };
