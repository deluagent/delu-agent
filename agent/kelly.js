/**
 * Kelly Criterion position sizing
 * Half-Kelly is standard for live trading
 *
 * Kelly fraction = edge / variance
 * Half-Kelly = Kelly × 0.5
 * Position size = Half-Kelly × portfolio_value
 */

/**
 * Calculate position size using Half-Kelly
 *
 * @param {number} confidence    - Venice confidence (0-100)
 * @param {number} portfolioUsd  - Total portfolio value in USD
 * @param {number} winRate       - Historical win rate (0-1), default 0.55 until calibrated
 * @param {number} avgWin        - Average win as fraction (e.g., 0.12 = 12%)
 * @param {number} avgLoss       - Average loss as fraction (e.g., 0.05 = 5%)
 * @returns {object} { sizeUsd, sizePct, kellyFraction, halfKelly }
 */
function kellySize(confidence, portfolioUsd, opts = {}) {
  const {
    winRate = 0.55,          // default until we have history
    avgWin = 0.12,           // default 12% average win
    avgLoss = 0.05,          // default 5% stop loss
    maxPct = 0.25,           // never more than 25% per position
    minPct = 0.02,           // never less than 2% (dust)
  } = opts;

  // Confidence gate: scale down for lower confidence
  const confidenceMultiplier = Math.max(0, (confidence - 65) / 35);  // 0 at 65%, 1 at 100%

  // Kelly formula: f = (p × b - q) / b
  // where p = win rate, q = 1-p, b = avg_win/avg_loss
  const b = avgWin / avgLoss;
  const kelly = (winRate * b - (1 - winRate)) / b;
  const halfKelly = kelly * 0.5;

  // Apply confidence scaling
  const adjustedKelly = halfKelly * confidenceMultiplier;

  // Clamp to min/max
  const sizePct = Math.min(maxPct, Math.max(minPct, adjustedKelly));
  const sizeUsd = portfolioUsd * sizePct;

  return {
    sizeUsd: Math.round(sizeUsd * 100) / 100,
    sizePct: Math.round(sizePct * 1000) / 10,  // as percentage, 1 decimal
    kellyFraction: Math.round(kelly * 1000) / 10,
    halfKelly: Math.round(halfKelly * 1000) / 10,
    confidenceMultiplier: Math.round(confidenceMultiplier * 100)
  };
}

/**
 * Calculate correlation-adjusted position limit
 * If we already hold correlated tokens, reduce new position
 *
 * @param {array} openPositions - list of open positions with token names
 * @param {string} newToken     - token we want to add
 * @param {number} baseSize     - initial size from Kelly
 */
function correlationAdjust(openPositions, newToken, baseSize) {
  // Simplified: ETH-correlated tokens get 0.6x size if we already have ETH exposure
  const ethCorrelated = ['ETH', 'WETH', 'WBTC', 'BTC'];
  const baseCorrelated = ['TOSHI', 'BALD', 'AERODROME', 'AERO'];

  const hasEthExposure = openPositions.some(p => ethCorrelated.includes(p.token?.toUpperCase()));
  const hasBaseExposure = openPositions.some(p => baseCorrelated.includes(p.token?.toUpperCase()));

  let adjustment = 1.0;

  if (ethCorrelated.includes(newToken?.toUpperCase()) && hasEthExposure) {
    adjustment = 0.5;  // 50% of normal size when already ETH-correlated
  }

  if (baseCorrelated.includes(newToken?.toUpperCase()) && hasBaseExposure) {
    adjustment = 0.6;  // 60% of normal size when already Base-correlated
  }

  return {
    adjustedSize: Math.round(baseSize * adjustment * 100) / 100,
    adjustment,
    reason: adjustment < 1 ? 'correlation penalty applied' : 'no correlation overlap'
  };
}

/**
 * Calibrate Kelly params from historical log
 * Call after each resolved trade to update win rate / avg win / avg loss
 */
function calibrateFromLog(allocations) {
  const resolved = allocations.filter(a =>
    a.outcome !== null &&
    a.decision.action !== 'yield' &&
    a.decision.action !== 'hold'
  );

  if (resolved.length < 5) return null;  // not enough data

  const wins = resolved.filter(a => a.outcome?.correct === true);
  const losses = resolved.filter(a => a.outcome?.correct === false);

  const winRate = wins.length / resolved.length;
  const avgWin = wins.length > 0
    ? wins.reduce((s, a) => s + (a.outcome?.return_pct || 0), 0) / wins.length / 100
    : 0.12;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, a) => s + (a.outcome?.return_pct || 0), 0) / losses.length) / 100
    : 0.05;

  return { winRate, avgWin, avgLoss, sampleSize: resolved.length };
}

module.exports = { kellySize, correlationAdjust, calibrateFromLog };
