/**
 * stops.js — Dynamic trailing stop sizing
 *
 * Instead of fixed 5%, use ATR-based trailing stop:
 * - Volatile tokens (pumping 50%+) get wider stops
 * - Calm tokens get tighter stops
 * - Always respect minimum floor (3%) and maximum ceiling (15%)
 *
 * This is the "Kelly for stops" idea — match stop width to volatility
 */

'use strict';

/**
 * Compute ATR-based trailing stop percentage
 *
 * @param {number[]} closes  - recent close prices
 * @param {number[]} highs   - recent high prices
 * @param {number[]} lows    - recent low prices
 * @param {string}   regime  - current regime state
 * @returns {object} { trailPct, activateAt, rationale }
 */
function dynamicTrailStop(closes, highs, lows, regime = 'RANGE_WIDE') {
  const n = closes.length;
  if (n < 14 || !highs.length || !lows.length) {
    return { trailPct: 5, activateAt: 1, rationale: 'default (no data)' };
  }

  // ATR(14) — average true range
  let atrSum = 0;
  for (let i = n - 14; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
    atrSum += tr;
  }
  const atr = atrSum / 14;
  const atrPct = (atr / closes[n - 1]) * 100;

  // 24h price change (pump detection)
  const change24h = closes.length >= 24
    ? ((closes[n-1] - closes[n-25]) / closes[n-25]) * 100
    : 0;

  // Base stop = 1.5× ATR percentage (standard quant practice)
  let trailPct = Math.round(atrPct * 1.5 * 10) / 10;

  // Pump adjustment: if token is up >20% in 24h, widen stop (chasing breakout)
  if (change24h > 50) {
    trailPct = Math.max(trailPct, 12); // volatile pump — wide stop
  } else if (change24h > 20) {
    trailPct = Math.max(trailPct, 8);  // strong move — medium wide
  } else if (change24h > 10) {
    trailPct = Math.max(trailPct, 6);  // normal move — slight widening
  }

  // Regime adjustment
  if (regime.startsWith('BULL_HOT')) {
    trailPct = Math.max(trailPct, 7);   // trending hard — don't get shaken out
    trailPct = Math.min(trailPct, 15);
  } else if (regime.startsWith('BULL_COOL')) {
    trailPct = Math.max(trailPct, 5);
    trailPct = Math.min(trailPct, 10);
  } else if (regime === 'BEAR') {
    trailPct = Math.min(trailPct, 5);   // bear: keep stops tight, protect capital
    trailPct = Math.max(trailPct, 3);
  } else {
    // RANGE
    trailPct = Math.max(trailPct, 4);
    trailPct = Math.min(trailPct, 8);
  }

  // Hard floor/ceiling
  trailPct = Math.max(3, Math.min(15, trailPct));

  // Activate earlier when volatile (trail starts protecting at +1% for calm, +2% for volatile)
  const activateAt = atrPct > 5 ? 2 : 1;

  return {
    trailPct:   Math.round(trailPct * 10) / 10,
    activateAt,
    atrPct:     Math.round(atrPct * 100) / 100,
    change24h:  Math.round(change24h * 10) / 10,
    rationale:  `ATR=${atrPct.toFixed(2)}% 24h=${change24h.toFixed(1)}% regime=${regime}`,
  };
}

module.exports = { dynamicTrailStop };
