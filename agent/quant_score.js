/**
 * quant_score.js — Full evolved quant brain for Base trending tokens
 *
 * Same logic as autoresearch/candidate.js (the evolved daily model),
 * adapted to work on short Alchemy hourly bars (48–168 bars available).
 *
 * Key adaptations:
 *  - Lookbacks scaled down: 7d → 12h, 20d → 24h, 60d → 48h
 *  - BTC regime: uses btcPrices if available, else uses token's own trend
 *  - Vol annualization: sqrt(24*365) for hourly instead of sqrt(252) for daily
 *  - All signal WEIGHTS unchanged — same candidate.js logic
 */

// ── Helpers ──────────────────────────────────────────────────

function pctChange(prices, lookback) {
  const n = prices.length;
  if (n <= lookback) return 0;
  const prev = prices[n - 1 - lookback];
  return prev === 0 ? 0 : (prices[n - 1] - prev) / prev;
}

function realizedVol(prices, window = 14) {
  const n = prices.length;
  if (n < window + 1) return 0.5;
  const rets = [];
  for (let i = n - window; i < n; i++) {
    if (prices[i - 1] > 0) rets.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (rets.length === 0) return 0.5;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  // Annualize as hourly vol (8760 hours/year)
  return Math.sqrt(variance * 8760);
}

function sma(arr, period) {
  const n = arr.length;
  if (n < period) return arr[n - 1] || 0;
  return arr.slice(n - period).reduce((s, p) => s + p, 0) / period;
}

function emaVal(prices, period) {
  const k = 2 / (period + 1);
  let e = prices[0];
  for (let i = 1; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

function emaGap(prices, fast = 12, slow = 26) {
  const n = prices.length;
  if (n < slow) return 0;
  const slice = prices.slice(Math.max(0, n - slow * 3));
  const f = emaVal(slice, fast);
  const s = emaVal(slice, slow);
  return s === 0 ? 0 : (f - s) / s;
}

function zScore(prices, window = 20) {
  const n = prices.length;
  if (n < window) return 0;
  const slice = prices.slice(n - window);
  const mean = slice.reduce((s, p) => s + p, 0) / window;
  const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / window);
  return std === 0 ? 0 : (prices[n - 1] - mean) / std;
}

function calculateObvSig(prices, volumes, window = 20) {
  const n = prices.length;
  if (n < window + 1 || volumes.length < n) return 0;
  let obvDelta = 0;
  let totalVol = 0;
  for (let i = n - window; i < n; i++) {
    totalVol += volumes[i];
    if (prices[i] > prices[i - 1])       obvDelta += volumes[i];
    else if (prices[i] < prices[i - 1])  obvDelta -= volumes[i];
  }
  return totalVol > 0 ? obvDelta / totalVol : 0;
}

// ── Main scorer (same logic as candidate.js, hourly-adapted lookbacks) ──────

/**
 * scoreTokenHourly(data) → number
 *
 * data = {
 *   prices:    float[]  — hourly closes, oldest first (48+ bars ideal)
 *   volumes:   float[]  — hourly volumes (same length)
 *   highs:     float[]  — hourly highs
 *   btcPrices: float[]  — BTC hourly closes (optional, for regime)
 *   flowSignal: number  — funding rate z-score [-1,+1] (default 0)
 *   // Extra fields from Alchemy (augment score)
 *   uniqueBuyers:  number
 *   uniqueSellers: number
 *   buyRatio:      number   (0–1)
 *   trendingRank:  number   (1=top, 10=bottom)
 *   priorRanks:    number[] — previous rank readings for acceleration
 * }
 */
function scoreTokenHourly(data) {
  const {
    prices,
    volumes    = [],
    highs      = [],
    btcPrices  = [],
    flowSignal = 0,
    // Alchemy-only extras
    uniqueBuyers  = null,
    uniqueSellers = null,
    buyRatio      = null,
    trendingRank  = 5,
    priorRanks    = [],
  } = data;

  const n = prices.length;
  // Need at least 26 bars for EMA; ideally 48
  if (n < 20) return 0;

  // ── Adapted lookbacks for hourly data ──────────────────────
  // Daily → Hourly mapping:
  //  3d  → 6h  bars
  //  7d  → 24h bars (cap at n-1)
  //  20d → 48h bars (cap at n-1)
  //  60d → full available window
  const lb3  = Math.min(6,    n - 1);
  const lb7  = Math.min(24,   n - 1);
  const lb20 = Math.min(48,   n - 1);
  const lb60 = Math.min(n-1,  n - 1);

  const vol = realizedVol(prices, Math.min(14, n - 1));

  const r7  = pctChange(prices, lb7);
  const r3  = pctChange(prices, lb3);
  const r20 = pctChange(prices, lb20);
  const r60 = pctChange(prices, lb60);
  const r1  = pctChange(prices, 1);

  // ── Regime detection ──────────────────────────────────────
  // Cap vol for regime/gate logic — Base microcaps are naturally high-vol.
  // Annualized hourly vol >2.0 (200%) still behaves like "high vol" bucket.
  const volCapped = Math.min(vol, 2.5);

  // For Base microcap trending tokens (no BTC price series provided):
  // We DO NOT apply BTC regime penalty — these are cross-sectional alpha opportunities
  // that can outperform in any macro regime (CLANKER +625% during BTC BEAR, etc.)
  // The caller should only pass btcPrices when doing macro-regime filtering on majors.
  let regimeMult = 1.0;
  let isBear = false;
  if (btcPrices.length >= 50) {
    const btc50  = sma(btcPrices, 50);
    const btc200 = sma(btcPrices, Math.min(200, btcPrices.length));
    if (btc50 < btc200) {
      isBear = true;
      regimeMult = volCapped > 0.75 ? 0.05 : 0.20;
    }
  }
  // No BTC data → no macro penalty. Token's own trend filter (ema gate below) is sufficient.

  // ── Falling knife protection ──────────────────────────────
  if (r7 < -0.20) return 0;

  // ── Trend strength filter ─────────────────────────────────
  const ema = emaGap(prices, 6, 18); // 6/18h EMA (≈12/26d scaled)
  if (Math.abs(ema) < 0.03) return 0;

  // ── r3 gate (evolved: r3>0.10 when vol>0.75) ─────────────
  // For Base microcaps, annualized hourly vol is naturally very high (>1.0).
  // Scale the threshold: vol>3 → 2% over 6h; vol>1.5 → 5%; vol>0.75 → 10%
  const r3Threshold = volCapped > 2.0 ? 0.02 : volCapped > 1.5 ? 0.05 : 0.10;
  if (volCapped > 0.75 && r3 < r3Threshold) return 0;

  // ── Momentum ─────────────────────────────────────────────
  const momentum = volCapped > 0.75
    ? (0.60 * r3 + 0.40 * r7) / (1 + volCapped)
    : (0.30 * r7 + 0.40 * r20 + 0.30 * r60) / (1 + volCapped);

  // ── Trend ─────────────────────────────────────────────────
  const trend = 0.20 * ema;

  // ── Mean reversion ────────────────────────────────────────
  const z = zScore(prices, Math.min(20, n));
  const meanRev = z < -1.8 ? 0.10 : (z > 2.5 ? -0.08 : 0);

  // ── Vol penalty ───────────────────────────────────────────
  // Daily model: penalizes vol > 0.6. For Base microcaps, high vol is normal.
  // Cap penalty at 0.08 to prevent it overwhelming positive signals.
  const volPenalty = Math.max(-0.08, -0.20 * Math.max(volCapped - 0.6, 0));

  // ── Funding signal ────────────────────────────────────────
  const fundingBoost = isBear
    ? (flowSignal > 0 ? 0.15 * flowSignal : -0.15 * Math.abs(flowSignal))
    : 0.10 * flowSignal;

  // ── OBV + volume surge ────────────────────────────────────
  const obvSig  = calculateObvSig(prices, volumes, Math.min(15, n - 1));
  const relVol  = volumes.length > 0
    ? volumes[n - 1] / (sma(volumes, Math.min(15, n)) || 1)
    : 1;
  const obvBoost = 0.06 * obvSig * Math.min(relVol, 2.0); // cap at 2.0 (evolved)

  // ── Volume confirmation (evolved signal) ──────────────────
  const vol20avg   = volumes.length >= 20 ? sma(volumes, 20) : 0;
  const relVolume  = vol20avg > 0 ? volumes[n - 1] / vol20avg : 1;
  const volConfirm = r1 > 0.03
    ? (relVolume > 1.5 ? 0.05 : relVolume < 0.8 ? -0.04 : 0)
    : 0;

  // ── 52w proximity (ATH momentum quality) ─────────────────
  const high52        = Math.max(...prices.slice(Math.max(0, n - Math.min(252, n))));
  const pctFromHigh   = (high52 - prices[n - 1]) / (high52 || 1);
  const highProximity = !isBear && pctFromHigh < 0.12 ? 0.01 : 0;

  // ── OBV divergence ────────────────────────────────────────
  const obv20        = calculateObvSig(prices, volumes, Math.min(20, n - 1));
  const priceChange  = prices[n - 1] - prices[n - Math.min(20, n - 1)];
  const obvDivergence = obv20 > 0 && priceChange < 0 ? -0.02
    : obv20 < 0 && priceChange > 0 ?  0.02
    : 0;

  // ── ATR penalty ───────────────────────────────────────────
  const atr        = highs.length >= 14 ? realizedVol(highs, 14) : vol;
  const atrPenalty = atr > 0.8 ? -0.03 : 0;

  // ── Alchemy augments (not in daily model — onchain-only) ──
  // Buyer dominance: more unique buyers than sellers = accumulation
  let buyerSignal = 0;
  if (buyRatio !== null) {
    if (buyRatio > 0.60)       buyerSignal =  0.08;
    else if (buyRatio > 0.55)  buyerSignal =  0.04;
    else if (buyRatio < 0.40)  buyerSignal = -0.06;
    else if (buyRatio < 0.45)  buyerSignal = -0.03;
  }

  // Rank acceleration: improving rank = momentum confirmation
  let rankSignal = 0;
  if (priorRanks.length >= 2) {
    const prevRank = priorRanks[priorRanks.length - 1];
    const rankDelta = prevRank - trendingRank; // positive = improving (rank 5→3 = delta +2)
    if (rankDelta > 0)       rankSignal =  0.04 * Math.min(rankDelta / 3, 1);
    else if (rankDelta < 0)  rankSignal = -0.03 * Math.min(Math.abs(rankDelta) / 3, 1);
  }

  // ── Combined (same structure as candidate.js) ─────────────
  const raw = momentum + trend + meanRev + volPenalty + fundingBoost
    + obvBoost + volConfirm + highProximity + obvDivergence + atrPenalty
    + buyerSignal + rankSignal;

  return raw * regimeMult;
}

module.exports = { scoreTokenHourly };
