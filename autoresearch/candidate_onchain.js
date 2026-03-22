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
    const repeatScore = transferStats.repeatBuyers > 3 ? 0.4 : transferStats.repeatBuyers > 1 ? 0.15 : 0;
    const concentrationPenalty = transferStats.topBuyerConcentration > 0.5 ? -0.35 : transferStats.topBuyerConcentration > 0.3 ? -0.15 : 0;
    const velocityBoost = transferStats.transferVelocity > 80 && transferStats.topBuyerConcentration < 0.25 ? 0.25 : 0;
    smartWalletBoost = buyerScore + repeatScore + concentrationPenalty + velocityBoost;
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
  const regimeStabilityPenalty = volatilityRegime === "low" ? -0.15 : 0;

  const priceAboveSMA = prices[prices.length - 1] > sma20 ? 1 : -1;
  const distanceFromSMA = Math.abs(prices[prices.length - 1] - sma20) / sma20;
  const overextensionPenalty = distanceFromSMA > 0.08 && priceAboveSMA > 0 ? -0.20 : 0;

  let score;
  if (isMomentum && volatilityRegime !== "low") {
    score = sRS * 0.42 + sRSI * 0.16 + sVol * 0.14 + sTrend * 0.10 + sMomentum * 0.12 + smartWalletBoost * 0.08 + overextensionPenalty * 0.05;
  } else if (isMeanReversion && volatilityRegime !== "low") {
    score = sRS * 0.35 + sRSI * 0.20 + meanReversionBoost * 0.25 + smartWalletBoost * 0.10 + regimeStabilityPenalty * 0.10;
  } else {
    score = sRS * 0.30 + sRSI * 0.15 + sTrend * 0.20 + smartWalletBoost * 0.15 + regimeStabilityPenalty * 0.20;
  }

  return Math.max(-1, Math.min(1, score));
}

module.exports = { scoreToken };