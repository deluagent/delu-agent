/**
 * position_monitor.js — Live position intelligence
 *
 * For every open position, pull Alchemy data every cycle and answer:
 *   - Is new volume entering? (confirms thesis)
 *   - Is momentum accelerating or dying?
 *   - Should we tighten/loosen the trailing stop?
 *   - Is the position at risk (volume drying up + price fading)?
 *
 * Returns a structured assessment per position for Venice.
 */

const fs   = require('fs');
const path = require('path');
const { getTokenSignal, getCurrentPrice, getHourlyBars } = require('./onchain_ohlcv');
const { scoreTokenHourly } = require('./quant_score');

const POSITIONS_FILE = path.join(__dirname, '../data/positions.json');

const BINANCE_PRICE_URL  = sym => `https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`;
const BINANCE_KLINES_URL = (sym, interval, limit) =>
  `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${interval}&limit=${limit}`;

// ATR trailing stop params — auto-evolved by autoresearch/loop_stops.js
// DO NOT edit manually — will be overwritten when loop finds improvement
const ATR_MULT        = 2.7;   // ATR multiplier for trail (from peak)
const ATR_BARS        = 14;    // ATR period
const HARD_SL_ATR_MULT = 3;  // ATR multiplier for pre-trail hard SL
const HARD_SL_MIN_PCT  = 10;    // minimum hard SL % for micro-caps
const HARD_SL_MAX_PCT  = 15;   // absolute max loss % (floor)
const ACTIVATE_AT      = 0.5;  // % gain to activate trail

/**
 * Fetch recent OHLCV bars for majors from Binance
 */
async function getBinanceBars(sym, interval = '1h', limit = 50) {
  try {
    const r = await fetch(BINANCE_KLINES_URL(sym, interval, limit), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const klines = await r.json();
    return klines.map(k => ({ high: +k[2], low: +k[3], close: +k[4] }));
  } catch { return null; }
}

/**
 * Calculate ATR(14) from OHLCV bars
 */
function calcATR(bars, period = ATR_BARS) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high, low = bars[i].low, prevClose = bars[i-1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

/**
 * Load and save positions
 */
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch { return []; }
}
function savePositions(positions) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

/**
 * Get current price for a position
 * For Base tokens: Alchemy. For majors: Binance.
 */
async function getLivePrice(position) {
  // Base token with contract address → Alchemy
  if (position.contractAddress) {
    try {
      return await getCurrentPrice(position.contractAddress);
    } catch { return null; }
  }
  // Major token → Binance (map wrapped tokens)
  const SYM_MAP = { CBBTC: 'BTC', WBTC: 'BTC', WETH: 'ETH', WSOL: 'SOL' };
  const rawSym = position.sym?.toUpperCase();
  const sym = SYM_MAP[rawSym] || rawSym;
  if (!sym || sym === 'USDC') return 1;
  try {
    const r = await fetch(BINANCE_PRICE_URL(sym), { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    return parseFloat(j.price) || null;
  } catch { return null; }
}

/**
 * Assess a single open position.
 * Returns { sym, currentPrice, pnlPct, quantScore, volumeTrend, signal, recommendation }
 */
async function assessPosition(position) {
  const sym          = position.sym;
  const entryPrice   = position.entryPrice || 0;
  const contractAddr = position.contractAddress;

  let currentPrice   = null;
  let signal         = null;
  let quantScore     = null;
  let volumeTrend    = 'unknown';
  let recommendation = 'hold'; // hold | tighten | exit

  // Get current price
  currentPrice = await getLivePrice(position);
  const pnlPct = currentPrice && entryPrice
    ? (currentPrice - entryPrice) / entryPrice * 100
    : null;

  // For Base tokens with contract address: get full Alchemy signal
  if (contractAddr) {
    try {
      signal = await getTokenSignal(contractAddr, 48);
      if (signal && signal.bars.length >= 20) {
        const prices  = signal.bars.map(b => b.close);
        const volumes = signal.bars.map(b => b.volume);
        const highs   = signal.bars.map(b => b.high);
        const n = prices.length;

        quantScore = scoreTokenHourly({
          prices, volumes, highs,
          buyRatio:     signal.transferStats?.buyRatio ?? null,
          uniqueBuyers: signal.transferStats?.uniqueBuyers ?? null,
        });

        // Volume trend: compare last 6h vs prior 6h
        const recentVol = volumes.slice(-6).reduce((s, v) => s + v, 0);
        const priorVol  = volumes.slice(-12, -6).reduce((s, v) => s + v, 0);
        volumeTrend = priorVol > 0
          ? (recentVol / priorVol > 1.2 ? 'increasing' : recentVol / priorVol < 0.7 ? 'declining' : 'stable')
          : 'unknown';

        // Recommendation logic
        if (quantScore < -0.05 && volumeTrend === 'declining') {
          recommendation = 'tighten'; // momentum fading — tighten stop
        } else if (quantScore < -0.10) {
          recommendation = 'exit';    // strong reversal signal
        } else if (quantScore > 0.05 && volumeTrend === 'increasing') {
          recommendation = 'hold';    // thesis intact, let it run
        }
      }
    } catch (e) {
      console.warn(`  [position_monitor] Alchemy failed for ${sym}: ${e.message?.slice(0,50)}`);
    }
  }

  return {
    sym,
    contractAddress: contractAddr || null,
    entryPrice,
    currentPrice,
    pnlPct: pnlPct !== null ? parseFloat(pnlPct.toFixed(2)) : null,
    quantScore: quantScore !== null ? parseFloat(quantScore.toFixed(4)) : null,
    volumeTrend,
    transferStats:  signal?.transferStats || null,
    ret1h:  signal?.ret1h  ?? null,
    ret6h:  signal?.ret6h  ?? null,
    recommendation,
    source: position.source || 'universe',
  };
}

/**
 * Assess all open positions in parallel (with rate limit)
 */
/**
 * Check and update ATR trailing stop for a position.
 * Updates peakPrice, atrStop, atrValue in the position object.
 * Returns { triggered: bool, reason, stopPrice, currentPrice, atr }
 */
async function checkAtrStop(pos) {
  const currentPrice = await getLivePrice(pos);
  if (!currentPrice || !pos.entryPrice) return { triggered: false };

  // Fetch bars for ATR calculation
  // Map wrapped tokens to their Binance equivalents
  const BINANCE_SYM_MAP = { CBBTC: 'BTC', WBTC: 'BTC', WETH: 'ETH', WSOL: 'SOL' };
  let bars = null;
  if (pos.contractAddress) {
    // Base token — use Alchemy hourly bars
    try {
      const raw = await getHourlyBars(pos.contractAddress);
      bars = raw?.map(b => ({ high: b.high, low: b.low, close: b.close })) || null;
    } catch { /* fall through */ }
  }
  if (!bars) {
    // Major token — Binance 1h bars
    const binanceSym = BINANCE_SYM_MAP[pos.sym?.toUpperCase()] || pos.sym?.toUpperCase();
    bars = await getBinanceBars(binanceSym);
  }

  const atr = bars ? calcATR(bars) : null;

  // Update peak price
  const prevPeak = pos.peakPrice || pos.entryPrice;
  const newPeak  = Math.max(prevPeak, currentPrice);
  const peakPct  = (newPeak - pos.entryPrice) / pos.entryPrice * 100;

  // ── Stop logic ────────────────────────────────────────────────
  //
  // For micro-cap Base tokens (contractAddress present), a fixed -3% hard SL
  // is way too tight — normal spread+slippage+volatility wicks through it
  // immediately, stopping out valid positions before they can run.
  //
  // Strategy:
  //   - activateAt: trail activates after +0.5% gain (was +1%)
  //   - Before trail active: hard SL = entry - 2×ATR (ATR-based, not fixed %)
  //     · if no ATR: use -15% for contract tokens, -5% for majors
  //     · floor: never worse than -20% (prevents runaway loss if ATR is huge)
  //   - After trail active: peak - ATR_MULT×ATR (unchanged, 2.5×ATR from peak)
  //     · floor: entry - 2×ATR (don't let trail drop below initial hard SL)

  const activateAt  = pos.activateAt || ACTIVATE_AT;
  const trailPct    = pos.trailPct   || 5;
  const trailActive = peakPct >= activateAt;
  const isMicroCap  = !!pos.contractAddress;

  // ATR-based hard SL using evolved constants
  const hardSlMultiplier = HARD_SL_ATR_MULT;
  const minHardSlPct     = isMicroCap ? HARD_SL_MIN_PCT / 100 : 0.07;
  const atrHardSlPrice   = atr
    ? Math.min(pos.entryPrice - hardSlMultiplier * atr, pos.entryPrice * (1 - minHardSlPct))
    : pos.entryPrice * (1 - (isMicroCap ? HARD_SL_MIN_PCT / 100 * 2 : 0.07));

  // Absolute floor: never lose more than HARD_SL_MAX_PCT
  const absoluteFloor = pos.entryPrice * (1 - HARD_SL_MAX_PCT / 100);
  const hardSlPrice   = Math.max(atrHardSlPrice, absoluteFloor);

  let stopPrice;
  if (trailActive && atr) {
    stopPrice = newPeak - ATR_MULT * atr;
    // Trail floor: don't let trail drop below the initial hard SL
    stopPrice = Math.max(stopPrice, hardSlPrice);
  } else if (trailActive) {
    // No ATR — fixed % trail
    stopPrice = newPeak * (1 - trailPct / 100);
  } else {
    // Pre-trail: ATR-based hard SL
    stopPrice = hardSlPrice;
  }

  const triggered = currentPrice <= stopPrice;
  const pnlPct    = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;

  // Human-readable stop description
  const hardSlPct = ((pos.entryPrice - hardSlPrice) / pos.entryPrice * 100).toFixed(1);
  const stopDesc  = atr
    ? `2×ATR hard SL (-${hardSlPct}%)`
    : `fixed hard SL (-${hardSlPct}%)`;

  return {
    triggered,
    currentPrice,
    stopPrice,
    peakPrice:   newPeak,
    peakPct,
    pnlPct,
    atr,
    trailActive,
    hardSlPrice,
    hardSlPct: parseFloat(hardSlPct),
    reason: triggered
      ? (trailActive ? `ATR trail stop hit (${ATR_MULT}×ATR from peak)` : `${stopDesc} hit`)
      : 'holding',
  };
}

/**
 * Run ATR stop checks on all open positions.
 * Sells triggered positions via Bankr. Updates positions.json.
 * Returns list of triggered symbols.
 */
async function runAtrStops(openPositions, bankr, DRY_RUN = false) {
  if (!openPositions.length) return [];
  const triggered = [];

  console.log(`\n[atr-stops] Checking ${openPositions.length} position(s)...`);

  const allPositions = loadPositions();

  for (const pos of openPositions) {
    try {
      const check = await checkAtrStop(pos);
      const atrStr  = check.atr ? `ATR=${check.atr.toFixed(6)}` : 'ATR=n/a';
      const stopStr = check.stopPrice ? `stop=$${check.stopPrice.toFixed(6)}` : '';
      const pnlStr  = check.pnlPct != null ? `${check.pnlPct >= 0 ? '+' : ''}${check.pnlPct.toFixed(2)}%` : '?';
      const trailStr = check.trailActive ? '🟢trail' : `🔴hardSL(-${check.hardSlPct}%)`;
      console.log(`  ${pos.sym.padEnd(6)} price=$${check.currentPrice?.toFixed(6)} ${pnlStr} ${trailStr} ${stopStr} ${atrStr} peak=$${check.peakPrice?.toFixed(6)}`);

      // Update peakPrice in positions.json
      const idx = allPositions.findIndex(p => p.sym === pos.sym && p.status === 'open');
      if (idx >= 0) {
        allPositions[idx].peakPrice  = check.peakPrice;
        allPositions[idx].peakPct    = parseFloat((check.peakPct || 0).toFixed(4));
        allPositions[idx].atrStop    = check.stopPrice ? parseFloat(check.stopPrice.toFixed(8)) : null;
        allPositions[idx].atrValue   = check.atr ? parseFloat(check.atr.toFixed(8)) : null;
        allPositions[idx].lastChecked = new Date().toISOString();
      }

      if (check.triggered) {
        console.log(`  🛑 ${pos.sym} STOP TRIGGERED — ${check.reason} | price=$${check.currentPrice?.toFixed(6)} stop=$${check.stopPrice?.toFixed(6)}`);
        triggered.push({ sym: pos.sym, reason: check.reason, pnlPct: check.pnlPct, currentPrice: check.currentPrice });

        if (!DRY_RUN && bankr) {
          try {
            // Sell entire position back to USDC
            const qty = pos.qty || null;
            const sellMsg = qty
              ? `Sell all ${qty} ${pos.sym} → USDC (ATR stop)`
              : `Sell all ${pos.sym} → USDC (ATR stop)`;
            console.log(`  [bankr] ${sellMsg}`);
            await bankr.execute({ action: 'sell', asset: pos.sym, contractAddress: pos.contractAddress, size_pct: 100 }, 27);
            if (idx >= 0) {
              allPositions[idx].status      = 'closed';
              allPositions[idx].closeReason = 'atr_stop';
              allPositions[idx].closedAt    = new Date().toISOString();
              allPositions[idx].closePrice  = check.currentPrice;
              allPositions[idx].pnlPct      = parseFloat((check.pnlPct || 0).toFixed(2));
            }
          } catch(e) {
            console.warn(`  [bankr] Sell failed for ${pos.sym}: ${e.message?.slice(0,60)}`);
          }
        }
      }
    } catch(e) {
      console.warn(`  [atr-stops] ${pos.sym} check failed: ${e.message?.slice(0,60)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  savePositions(allPositions);
  return triggered;
}

async function monitorPositions(openPositions) {
  if (!openPositions.length) return [];

  console.log(`\n[position_monitor] Assessing ${openPositions.length} open position(s)...`);

  const results = [];
  for (const pos of openPositions) {
    try {
      const assessment = await assessPosition(pos);
      const pnlStr = assessment.pnlPct !== null ? `${assessment.pnlPct > 0 ? '+' : ''}${assessment.pnlPct.toFixed(1)}%` : '?%';
      const quantStr = assessment.quantScore !== null ? `quant=${assessment.quantScore.toFixed(3)}` : '';
      console.log(`  ${pos.sym.padEnd(6)} ${pnlStr} ${quantStr} vol=${assessment.volumeTrend} → ${assessment.recommendation}`);
      results.push(assessment);
    } catch (e) {
      console.warn(`  [position_monitor] ${pos.sym}: ${e.message?.slice(0,50)}`);
    }
    await new Promise(r => setTimeout(r, 300)); // small delay between Alchemy calls
  }

  return results;
}

module.exports = { monitorPositions, assessPosition, getLivePrice, runAtrStops, checkAtrStop };
