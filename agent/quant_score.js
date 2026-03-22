/**
 * quant_score.js — Promoted from onchain autoresearch exp 2302
 * val=10.319 aud=30.485 combined=20.402
 * Base tokens, Alchemy 1h data, 2026-03-22T07:57:30.329Z
 */

// Diagnostic: Add regime stability check and recover from failed momentum acceleration signal

function scoreToken(data) {
  const { prices, volumes, highs, lows, btcPrices, transferStats } = data;
  if (!prices || prices.length < 20) return 0;

  const rsi8 = rsi(prices, 8);
  const rsi14 = rsi(prices, 14);
  const sma8 = sma(prices, 8);
  const sma20 = sma(prices, 20);
  const rs = relStrength(prices, btcPrices, 8);

  const volatility = Math.sqrt(
    prices.slice(-8).reduce((sum, p, i, arr) => {
      if (i === 0) return sum;
      return sum + Math.pow((p - arr[i - 1]) / arr[i - 1], 2);
    }, 0) / 8
  );

  const sRS = (rs - 1) * 0.5;
  const sRSI = (rsi8 - 50) / 50 * 0.4;
  const sVol = Math.min(volatility * 2, 0.5);

  let smartWalletBoost = 0;
  if (transferStats) {
    const buyerScore = Math.min(transferStats.uniqueBuyers / 50, 1) * 0.3;
    const repeatScore = transferStats.repeatBuyers > 3 ? 0.4 : 0;
    const concentrationPenalty = transferStats.topBuyerConcentration > 0.4 ? -0.2 : 0;
    smartWalletBoost = buyerScore + repeatScore + concentrationPenalty;
  }

  const trend = sma8 > sma20 ? 1 : -1;
  const sTrend = trend * (Math.abs(sma8 - sma20) / sma20) * 0.25;

  const isMomentum = rsi8 > 55 && rsi8 < 75 && volatility > 0.008;
  const isMeanReversion = rsi8 < 40 || rsi8 > 70;

  const momentum = (prices[prices.length - 1] - prices[prices.length - 5]) / prices[prices.length - 5];
  const momentumAccel = Math.abs(momentum) > 0.015 ? Math.sign(momentum) : 0;
  const sMomentum = momentumAccel * (isMomentum ? 0.20 : 0.06);

  let meanReversionBoost = 0;
  if (isMeanReversion && rsi8 < 32) {
    meanReversionBoost = 0.35;
  } else if (isMeanReversion && rsi8 > 68) {
    meanReversionBoost = -0.30;
  }

  const volatilityRegime = volatility > 0.012 ? "high" : volatility < 0.005 ? "low" : "normal";
  const regimeStabilityPenalty = volatilityRegime === "low" ? -0.08 : 0;

  let score;
  if (isMomentum && volatilityRegime !== "low") {
    score = sRS * 0.42 + sRSI * 0.16 + sVol * 0.14 + sTrend * 0.10 + sMomentum * 0.12 + smartWalletBoost * 0.06;
  } else {
    score = sRS * 0.38 + sRSI * 0.24 + sVol * 0.12 + sTrend * 0.14 + smartWalletBoost * 0.10 + meanReversionBoost * 0.02;
  }

  score += regimeStabilityPenalty;

  return Math.max(-1, Math.min(1, score));
}

function rsi(prices, period) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const avg_gain = gains / period;
  const avg_loss = losses / period;
  const rs = avg_loss === 0 ? 100 : avg_gain === 0 ? 0 : avg_gain / avg_loss;
  return 100 - (100 / (1 + rs));
}

function sma(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  return prices.slice(-period).reduce((s, p) => s + p, 0) / period;
}

function relStrength(prices, refPrices, period) {
  if (prices.length < period || !refPrices || refPrices.length < period) return 1;
  const priceRet = (prices[prices.length - 1] - prices[prices.length - 1 - period]) / prices[prices.length - 1 - period];
  const refRet = (refPrices[refPrices.length - 1] - refPrices[refPrices.length - 1 - period]) / refPrices[refPrices.length - 1 - period];
  return refRet !== 0 ? priceRet / refRet : 1;
}


function scoreTokenHourly(data) { return scoreToken(data); }
module.exports = { scoreToken, scoreTokenHourly };