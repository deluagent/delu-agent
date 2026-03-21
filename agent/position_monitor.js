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

const { getTokenSignal, getCurrentPrice } = require('./onchain_ohlcv');
const { scoreTokenHourly } = require('./quant_score');

const BINANCE_PRICE_URL = sym =>
  `https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`;

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
  // Major token → Binance
  const sym = position.sym?.toUpperCase();
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

module.exports = { monitorPositions, assessPosition, getLivePrice };
