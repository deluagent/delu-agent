/**
 * trending_entry.js — Onchain entry signal for Base trending tokens
 *
 * Uses Bankr trending + GeckoTerminal OHLCV (no Binance needed).
 * Detects tokens in early momentum before they hit rank 1.
 *
 * Signal logic:
 *   - Rank acceleration: token rising in rank across cycles (8→5→3 = buy)
 *   - Where-in-move: ret6h < 40% of ret24h = still early
 *   - Volume/liquidity momentum: vol/liq rising = demand building
 *   - Txn acceleration: txns this cycle > prior cycle = accumulation
 *
 * Stores snapshots in data/trending_snapshots.jsonl
 * Returns: array of { symbol, address, score, reason, entryPrice, poolAddress }
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { getTokenSignal } = require('./onchain_ohlcv');

const SNAPSHOTS_FILE = path.join(__dirname, '../data/trending_snapshots.jsonl');

// Entry thresholds
const ENTRY = {
  minLiquidity:   40_000,   // $40K min liquidity
  maxMarketCap: 5_000_000,  // $5M max mcap — want early movers not established
  minTxns:          300,    // minimum 24h transactions
  minVolLiq:        0.08,   // vol/liq > 8%
  maxPc24h:          80,    // not already up >80% in 24h
  minPc24h:           3,    // must have some momentum
  minScore:         0.40,   // minimum combined score to flag
};

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Accept: 'application/json;version=20230302', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('GT timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Snapshot store ─────────────────────────────────────────────
function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_FILE)) return [];
  return fs.readFileSync(SNAPSHOTS_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function saveSnapshot(snap) {
  fs.appendFileSync(SNAPSHOTS_FILE, JSON.stringify(snap) + '\n');
}

function getPriorSnapshot(symbol, maxAgeMs = 45 * 60 * 1000) {
  const snaps = loadSnapshots().filter(s => s.symbol === symbol);
  if (!snaps.length) return null;
  const latest = snaps[snaps.length - 1];
  if (Date.now() - latest.ts > maxAgeMs) return null;
  return latest;
}

function getPriorRank(symbol) {
  // Look up to 3 prior cycles
  const snaps = loadSnapshots()
    .filter(s => s.symbol === symbol && Date.now() - s.ts < 3 * 60 * 60 * 1000)
    .slice(-3);
  return snaps.map(s => s.rank);
}

// ── GeckoTerminal pool lookup + OHLCV ─────────────────────────
async function getPoolData(tokenAddress) {
  const poolsRes = await get(
    `https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}/pools?page=1`
  );
  const pools = poolsRes?.data || [];
  if (!pools.length) return null;

  // Best pool by liquidity
  const best = pools
    .filter(p => p.attributes?.reserve_in_usd > ENTRY.minLiquidity)
    .sort((a, b) => (b.attributes?.reserve_in_usd || 0) - (a.attributes?.reserve_in_usd || 0))[0];
  if (!best) return null;

  const poolAddr = best.attributes?.address;
  const liq = best.attributes?.reserve_in_usd || 0;
  const currentPrice = parseFloat(best.attributes?.base_token_price_usd || 0);

  await sleep(300);

  const ohlcvRes = await get(
    `https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddr}/ohlcv/hour?limit=48&aggregate=1`
  );
  const ohlcv = (ohlcvRes?.data?.attributes?.ohlcv_list || []).sort((a, b) => a[0] - b[0]);

  return { poolAddr, liq, currentPrice, ohlcv };
}

const { scoreTokenHourly } = require('./quant_score');

// ── Score a single trending token — FULL QUANT BRAIN ─────────
// Uses the evolved candidate.js logic (same weights, hourly-adapted lookbacks)
// Augmented with onchain-only signals: buyer ratio, rank acceleration
function scoreEntry(token, rank, ohlcv, priorRanks, priorSnap, transferStats) {
  const n = ohlcv.length;
  if (n < 6) return { score: 0, reason: 'not enough OHLCV data' };

  // Extract arrays for quant brain
  const prices  = ohlcv.map(b => b[4]);  // close
  const volumes = ohlcv.map(b => b[5]);  // volume
  const highs   = ohlcv.map(b => b[2]);  // high

  // Simple price stats for context display
  const now  = prices[n - 1];
  const h1   = prices[Math.max(0, n - 2)];
  const h6   = prices[Math.max(0, n - 7)];
  const h24  = prices[Math.max(0, n - 25)];

  const ret1h  = h1  > 0 ? (now - h1)  / h1  : 0;
  const ret6h  = h6  > 0 ? (now - h6)  / h6  : 0;
  const ret24h = h24 > 0 ? (now - h24) / h24 : 0;
  const moveFrac = ret24h > 0.01 ? Math.max(0, ret6h) / ret24h : 1;

  // Run full quant brain
  const quantScore = scoreTokenHourly({
    prices,
    volumes,
    highs,
    flowSignal: 0, // no perp funding for Base microcaps — neutral
    uniqueBuyers:  transferStats?.uniqueBuyers  ?? null,
    uniqueSellers: transferStats?.uniqueSellers ?? null,
    buyRatio:      transferStats?.buyRatio      ?? null,
    trendingRank:  rank,
    priorRanks,
  });

  // Map raw quant score to 0–1 range (quant returns ~-0.1 to +0.3 for good tokens)
  // Scale: 0 → 0.30, 0.05 → 0.55, 0.10 → 0.70, 0.20+ → 1.0
  const normalizedQuant = Math.max(0, Math.min(1, (quantScore + 0.05) / 0.20));

  // Blend: 70% quant brain, 30% move-timing (where-in-the-move — not in daily model)
  const moveScore = moveFrac < 0.25 ? 1.0
                  : moveFrac < 0.40 ? 0.75
                  : moveFrac < 0.60 ? 0.45
                  : 0.10;
  const score = 0.70 * normalizedQuant + 0.30 * moveScore;

  const reason = [
    `rank=${rank}(${priorRanks.length ? priorRanks.join('→') : '?'}→${rank})`,
    `quant=${quantScore.toFixed(4)}`,
    `ret1h=${(ret1h*100).toFixed(1)}%`,
    `ret6h=${(ret6h*100).toFixed(1)}%`,
    `ret24h=${(ret24h*100).toFixed(1)}%`,
    `move=${(moveFrac*100).toFixed(0)}%done`,
    `v/l=${(token.volume24h/(token.liquidity||1)).toFixed(2)}`,
    `txns=${token.txnCount24h}`,
  ].join(' ');

  return { score, reason, ret1h, ret6h, ret24h, moveFrac, quantScore };
}

// ── Main: run every agent cycle ───────────────────────────────
async function getTrendingEntries(bankrApiKey) {
  const results = [];
  const ts = Date.now();

  let trendingTokens = [];
  try {
    const res = await get('https://api.bankr.bot/v1/trending?chain=base', {
      Authorization: `Bearer ${bankrApiKey}`,
    });
    trendingTokens = (res.tokens || [])
      .filter(t => !['USDC', 'WETH', 'USDT', 'WBTC'].includes(t.symbol?.toUpperCase()));
  } catch (e) {
    console.warn('  [trending_entry] Bankr fetch error:', e.message);
    return [];
  }

  for (const [i, token] of trendingTokens.entries()) {
    const rank = i + 1;
    const sym = (token.symbol || '').toUpperCase();

    // Quick pre-filter — skip obvious non-starters
    if (token.liquidity < ENTRY.minLiquidity) continue;
    if (token.txnCount24h < ENTRY.minTxns) continue;
    if (token.priceChange24h > ENTRY.maxPc24h) continue;
    if (token.priceChange24h < ENTRY.minPc24h) continue;

    const priorSnap = getPriorSnapshot(sym);
    const priorRanks = getPriorRank(sym);

    // Save snapshot regardless (before price fetch)
    saveSnapshot({
      ts, symbol: sym, rank,
      price: token.priceUSD,
      pc24h: token.priceChange24h,
      txns: token.txnCount24h,
      vol: token.volume24h,
      liq: token.liquidity,
      mcap: token.marketCap,
    });

    // Fetch Alchemy price history + transfer stats
    let signal = null;
    try {
      signal = await getTokenSignal(token.address, 48);
    } catch (e) {
      console.warn(`  [trending_entry] Alchemy error for ${sym}:`, e.message);
    }

    if (!signal) continue;

    // Build OHLCV-compatible array for scoreEntry
    const ohlcv = signal.bars.map(b => [b.ts, b.open, b.high, b.low, b.close, b.volume]);

    const { score, reason, ret1h, ret6h, ret24h, moveFrac, quantScore } = scoreEntry(
      token, rank, ohlcv, priorRanks, priorSnap, signal.transferStats
    );
    const finalScore = score;

    if (finalScore >= ENTRY.minScore) {
      results.push({
        symbol: sym,
        address: token.address,
        rank,
        score: finalScore,
        reason: reason + (signal.transferStats ? ` buyers=${signal.transferStats.uniqueBuyers} buyRatio=${signal.transferStats.buyRatio.toFixed(2)}` : ''),
        entryPrice: signal.currentPrice || token.priceUSD,
        liquidity: token.liquidity,
        marketCap: token.marketCap,
        volume24h: token.volume24h,
        txnCount24h: token.txnCount24h,
        priceChange24h: token.priceChange24h,
        ret1h, ret6h, ret24h, moveFrac,
        quantScore: quantScore ?? null,
        transferStats: signal.transferStats,
        priorRanks,
        source: 'bankr_trending', // Bankr onchain txn count → Alchemy OHLCV scored
      });
    }

    await sleep(200); // Alchemy rate limit buffer
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  if (results.length) {
    console.log(`  [trending_entry] ${results.length} entry candidate(s):`);
    for (const r of results) {
      console.log(`    ${r.symbol} score=${r.score.toFixed(2)} ${r.reason}`);
    }
  } else {
    console.log('  [trending_entry] No entry candidates this cycle');
  }

  return results;
}

module.exports = { getTrendingEntries };
