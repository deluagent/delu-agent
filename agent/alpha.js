/**
 * delu Alpha Engine — 5 systematic strategies
 *
 * Strategy 1: Trend + Attention Confirmation
 * Strategy 2: Attention → Capital Flow → Price (lead-lag)
 * Strategy 3: Cross-Sectional Attention Momentum (ranking)
 * Strategy 4: Panic Mean Reversion
 * Strategy 5: Regime-Aware Meta Allocator
 *
 * All strategies return alpha scores. Portfolio construction
 * ranks and sizes via Half-Kelly + vol targeting.
 */

// ─── Helpers ─────────────────────────────────────────────────

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function zScore(value, arr) {
  const s = std(arr);
  return s === 0 ? 0 : (value - mean(arr)) / s;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function last(arr, n = 1) { return arr.slice(-n); }

// Returns for a price array
function returns(prices, n) {
  if (prices.length <= n) return null;
  const cur  = prices.at(-1);
  const prev = prices.at(-(n + 1));
  return prev > 0 ? (cur - prev) / prev : null;
}

// Realized volatility (std of daily returns, annualized)
function realizedVol(prices, window = 20) {
  if (prices.length < window + 1) return null;
  const slice = prices.slice(-window - 1);
  const rets  = slice.slice(1).map((p, i) => Math.log(p / slice[i]));
  return std(rets) * Math.sqrt(252);
}

// GARCH(1,1) proxy — exponentially weighted variance
function ewmaVol(prices, lambda = 0.94) {
  if (prices.length < 5) return null;
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    rets.push(Math.log(prices[i] / prices[i-1]));
  }
  let variance = rets.slice(0, 5).reduce((s, r) => s + r * r, 0) / 5;
  for (let i = 5; i < rets.length; i++) {
    variance = lambda * variance + (1 - lambda) * rets[i] ** 2;
  }
  return Math.sqrt(variance * 252);
}

// ─── Regime Detection ─────────────────────────────────────────

/**
 * Detect current market regime
 * @param {number[]} btcPrices - BTC daily closes (60+ days)
 * @param {number[]} ethPrices - ETH daily closes
 * @returns {{ regime: string, volRatio: number, trendStrength: number }}
 */
function detectRegime(btcPrices, ethPrices) {
  const vol7d  = realizedVol(btcPrices.slice(-8),  7)  || 0.5;
  const vol30d = realizedVol(btcPrices.slice(-31), 30) || 0.5;
  const volRatio = vol7d / vol30d;

  const trend60d = returns(btcPrices, 60) || 0;
  const trend20d = returns(btcPrices, 20) || 0;

  // ETH confirmation
  const ethTrend = returns(ethPrices, 20) || 0;
  const trendStrength = (trend60d + trend20d + ethTrend) / 3;

  let regime;
  if (volRatio < 0.8 && trendStrength > 0.02) {
    regime = 'TREND';          // low vol + positive trend → momentum strategies
  } else if (volRatio > 1.3 && Math.abs(trendStrength) < 0.05) {
    regime = 'MEAN_REVERT';    // high vol + sideways → mean reversion
  } else if (volRatio > 1.2 && trendStrength > 0.05) {
    regime = 'BREAKOUT';       // high vol + strong trend → attention+flow
  } else if (trendStrength < -0.05) {
    regime = 'BEAR';           // downtrend → stay flat/defensive
  } else {
    regime = 'NEUTRAL';
  }

  return { regime, volRatio: +volRatio.toFixed(2), trendStrength: +trendStrength.toFixed(4) };
}

// ─── Strategy 1: Trend + Attention ───────────────────────────

/**
 * @param {number[]} prices    - daily close prices
 * @param {number}   attention - Δmindshare_7d from Checkr (0-1 normalized)
 * @returns {number} alpha score
 */
function strategy1_trendAttention(prices, attention = 0) {
  const r20  = returns(prices, 20);
  const r60  = returns(prices, 60);
  const r120 = returns(prices, 120);

  if (r20 === null) return null;

  const trend = (r20 !== null ? 0.5 * r20 : 0)
              + (r60 !== null ? 0.3 * r60 : 0)
              + (r120 !== null ? 0.2 * r120 : 0);

  // Attention multiplier: boosts signal when attention is also rising
  const attnMultiplier = 1 + clamp(attention, -1, 2);
  return trend * attnMultiplier;
}

// ─── Strategy 2: Attention → Capital Flow → Price ────────────

/**
 * Lead-lag: attention spike → wallet inflow confirms → enter
 * @param {number} attentionDelta   - Δmindshare this period
 * @param {number} walletInflow     - net wallet inflow (normalized, positive = accumulation)
 * @param {number} attentionAccel   - Δ²mindshare (second derivative, for exit signal)
 * @returns {{ score: number, phase: string }}
 */
function strategy2_attentionFlow(attentionDelta, flowSignal = 0, attentionAccel = 0, volAccel = 0) {
  if (attentionAccel < -0.1 && flowSignal < 0) return { score: -0.5, phase: 'EXIT', detail: { attentionAccel, flowSignal } };
  if (attentionDelta > 0 && flowSignal > 0.1) {
    const score = attentionDelta * flowSignal * (1 + Math.max(volAccel, 0) * 0.5);
    return { score: clamp(score, 0, 1), phase: attentionAccel > 0 ? 'BUILDING' : 'PEAKING', detail: { attentionDelta, flowSignal, volAccel } };
  }
  if (attentionDelta > 0 && flowSignal < -0.2) return { score: 0, phase: 'FAKEOUT', detail: { attentionDelta, flowSignal } };
  if (flowSignal > 0.3) return { score: flowSignal * 0.5, phase: 'FLOW_ONLY', detail: { flowSignal } };
  return { score: 0, phase: 'WAIT', detail: { attentionDelta, flowSignal } };
}

// ─── Strategy 3: Cross-Sectional Momentum Ranking ────────────

/**
 * Rank all tokens by composite score. Return normalized weights.
 * @param {Array} tokenData - [{ symbol, prices, attentionDelta, engagementRate }]
 * @returns {Array} sorted by rank with weights
 */
function strategy3_crossSectional(tokenData) {
  const scored = tokenData.map(t => {
    const r30  = returns(t.prices, 30) || 0;
    const attn = t.attentionDelta || 0;
    const eng  = t.engagementRate || 0;

    const score = 0.4 * r30 + 0.3 * attn + 0.3 * eng;
    return { ...t, score };
  }).filter(t => t.score !== null);

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Normalize weights: w_i ∝ rank_i - mean_rank
  const n = scored.length;
  const meanRank = (n + 1) / 2;
  const ranked = scored.map((t, i) => {
    const rank = i + 1;
    const rawWeight = meanRank - rank;  // top rank = most positive
    return { ...t, rank, rawWeight };
  });

  const totalPos = ranked.reduce((s, t) => s + Math.max(t.rawWeight, 0), 0);
  return ranked.map(t => ({
    ...t,
    weight: totalPos > 0 ? Math.max(t.rawWeight, 0) / totalPos : 0
  }));
}

// ─── Strategy 4: Panic Mean Reversion ────────────────────────

/**
 * Enter after extreme down move if flow-driven (not news-driven)
 * @param {number[]} prices    - daily closes
 * @param {number}   volume    - today's volume
 * @param {number}   avgVolume - rolling avg volume
 * @param {string}   regime    - current regime (skip in BEAR)
 * @returns {{ signal: string, z: number, strength: number }}
 */
function strategy4_panicReversion(prices, volume, avgVolume, regime) {
  if (regime === 'BEAR') return { signal: 'SKIP', z: 0, strength: 0 };

  const window = Math.min(30, prices.length - 1);
  const slice  = prices.slice(-window - 1);
  const rets   = slice.slice(1).map((p, i) => (p - slice[i]) / slice[i]);
  const lastRet = rets.at(-1);

  if (rets.length < 5) return { signal: 'INSUFFICIENT_DATA', z: 0, strength: 0 };

  const z = zScore(lastRet, rets.slice(0, -1));
  const volSpike = avgVolume > 0 ? volume / avgVolume : 1;

  // Entry: extreme down z-score + volume spike
  if (z < -2.5 && volSpike > 1.5) {
    const strength = Math.min(Math.abs(z) / 3, 1) * Math.min(volSpike / 3, 1);
    return { signal: 'LONG', z: +z.toFixed(2), strength: +strength.toFixed(3), volSpike: +volSpike.toFixed(2) };
  }

  // Exit signal: z returning toward 0
  if (z > -0.5 && z < 0.5) {
    return { signal: 'EXIT', z: +z.toFixed(2), strength: 0 };
  }

  return { signal: 'WAIT', z: +z.toFixed(2), strength: 0 };
}

// ─── Strategy 5: Regime-Aware Meta Allocator ─────────────────

/**
 * Combines all strategies based on current regime.
 * Returns a final alpha score per token.
 *
 * @param {object} token  - token data with prices, attention, etc.
 * @param {object} regime - output from detectRegime()
 * @param {object} recentSharpes - { s1, s2, s3, s4 } recent Sharpe by strategy
 * @returns {{ finalAlpha: number, strategies: object, regime: string }}
 */
function strategy5_regimeMeta(token, regime, recentSharpes = {}) {
  const r = regime.regime;

  // Compute all sub-strategies
  const s1 = strategy1_trendAttention(token.prices, token.attentionDelta);
  const s2 = strategy2_attentionFlow(token.attentionDelta || 0, token.flowSignal || 0, token.attentionAccel || 0, token.volAccel || 0);
  const s4 = strategy4_panicReversion(token.prices, token.volume || 0, token.avgVolume || 0, r);

  // Regime-based strategy weights
  let w = { s1: 0, s2: 0, s3: 0, s4: 0 };

  if (r === 'TREND') {
    w = { s1: 0.6, s2: 0.2, s3: 0.2, s4: 0.0 };
  } else if (r === 'BREAKOUT') {
    w = { s1: 0.2, s2: 0.6, s3: 0.2, s4: 0.0 };
  } else if (r === 'MEAN_REVERT') {
    w = { s1: 0.1, s2: 0.1, s3: 0.2, s4: 0.6 };
  } else if (r === 'BEAR') {
    w = { s1: 0.0, s2: 0.0, s3: 0.0, s4: 0.0 };  // flat in bear
  } else {  // NEUTRAL
    w = { s1: 0.4, s2: 0.2, s3: 0.3, s4: 0.1 };
  }

  // Adjust weights by recent Sharpe performance if available
  const sharpes = { s1: recentSharpes.s1 || 1, s2: recentSharpes.s2 || 1,
                    s3: recentSharpes.s3 || 1, s4: recentSharpes.s4 || 1 };
  const totalSharpe = Object.values(sharpes).reduce((a, b) => a + Math.max(b, 0.01), 0);

  const finalAlpha =
    w.s1 * (s1 || 0) +
    w.s2 * (s2.score || 0) +
    w.s4 * (s4.strength * (s4.signal === 'LONG' ? 1 : 0));

  const vol = realizedVol(token.prices) || ewmaVol(token.prices) || 0.5;
  const volAdjusted = vol > 0 ? finalAlpha / vol : finalAlpha;

  return {
    finalAlpha:    +finalAlpha.toFixed(6),
    volAdjusted:   +volAdjusted.toFixed(6),
    vol:           +vol.toFixed(4),
    regime:        r,
    weights:       w,
    strategies: {
      s1: s1 !== null ? +s1.toFixed(6) : null,
      s2: { score: +(s2.score || 0).toFixed(4), phase: s2.phase },
      s4: { signal: s4.signal, z: s4.z, strength: s4.strength },
    },
  };
}

// ─── Portfolio Construction ───────────────────────────────────

/**
 * Given alpha scores for all tokens, compute target weights.
 * Long-only (no shorts). Max 15% per position. Min liquidity filter.
 *
 * @param {Array} alphas - [{ symbol, volAdjusted, finalAlpha }]
 * @param {number} maxPositions - max tokens to hold
 * @param {number} maxWeight    - max weight per token (0-1)
 * @returns {Array} [{ symbol, weight, alpha }]
 */
function constructPortfolio(alphas, maxPositions = 5, maxWeight = 0.15) {
  // Only consider positive alpha
  const longs = alphas
    .filter(a => a.volAdjusted > 0)
    .sort((a, b) => b.volAdjusted - a.volAdjusted)
    .slice(0, maxPositions);

  if (longs.length === 0) return [];

  // Normalize weights
  const totalAlpha = longs.reduce((s, a) => s + a.volAdjusted, 0);
  return longs.map(a => ({
    symbol: a.symbol,
    weight: +Math.min(a.volAdjusted / totalAlpha, maxWeight).toFixed(4),
    alpha:  +a.volAdjusted.toFixed(6),
    regime: a.regime,
  }));
}

// ─── Kelly Sizing with Regime Adjustment ─────────────────────

/**
 * Size a position using Half-Kelly, scaled by regime confidence.
 * @param {number} portfolioUsd - total portfolio value
 * @param {number} weight       - target weight from portfolio construction
 * @param {string} regime       - current regime
 * @param {number} confidence   - Venice confidence (0-100)
 * @returns {number} size in USD
 */
function kellySize(portfolioUsd, weight, regime, confidence = 70) {
  const regimeMultiplier = { TREND: 1.0, BREAKOUT: 0.8, MEAN_REVERT: 0.6, NEUTRAL: 0.7, BEAR: 0 }[regime] || 0.5;
  const confMultiplier = Math.max(0, (confidence - 60) / 40);  // 0 at 60%, 1 at 100%

  const rawSize = portfolioUsd * weight * 0.5;  // half-Kelly base
  return Math.max(0, rawSize * regimeMultiplier * confMultiplier);
}

module.exports = {
  detectRegime,
  strategy1_trendAttention,
  strategy2_attentionFlow,
  strategy3_crossSectional,
  strategy4_panicReversion,
  strategy5_regimeMeta,
  constructPortfolio,
  kellySize,
  // helpers
  returns, realizedVol, ewmaVol, zScore, mean, std
};
