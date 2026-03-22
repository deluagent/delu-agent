/**
 * discover.js — Dynamic token discovery for delu agent
 *
 * Finds tokens going parabolic that aren't in the fixed universe.
 * Sources: Bankr trending + Checkr spikes → vet with GeckoTerminal → trade if passes.
 *
 * No fixed universe — reads the room every cycle.
 */

'use strict';

const https = require('https');
const { getTokenSignal } = require('./onchain_ohlcv');

const BANKR_API = process.env.BANKR_API_KEY;

// Minimum bars for signal computation
const MIN_BARS = 48;

// Vetting thresholds
const VET = {
  minLiquidityUSD:  50_000,    // must have >$50K liquidity
  maxFDV:           500_000_000, // ignore tokens with FDV > $500M (already pumped or too big)
  minFDV:           500_000,   // ignore micro-caps < $500K FDV (likely rugs)
  minAgeDays:       3,         // must be at least 3 days old (avoid launches)
  minVol24hUSD:     10_000,    // must have >$10K 24h volume (real activity)
  minVolLiqRatio:   0.05,      // vol/liq > 5% (active trading, not ghost pool)
  maxBuyerSellRatio: 0.25,     // buys/(buys+sells) must be > 25% (not pure dump)
};

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { Accept: 'application/json;version=20230302', ...headers } };
    const req = https.get(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch Bankr trending tokens — Base only, filter out stablecoins/bluechips
 * Returns array of { symbol, address, chain, txnCount24h, volume24h, priceChange24h }
 */

// Tokens to always skip — stablecoins, wrapped assets, DeFi bluechips
const SKIP_SYMS = new Set([
  'USDC','USDT','WETH','ETH','WBTC','CBBTC','DAI','DOLA','LUSD','FRAX','CRVUSD',
  'USR','PAXG','XAUT','AERO','WSTETH','STETH','RETH','CBETH','WEETH',
  'BRETT','TOSHI','DEGEN','HIGHER','IMAGINE','GOR','MINI','FORGE',
]);

async function fetchBankrTrending() {
  if (!BANKR_API) return [];
  const results = [];
  // Base only — ETH mainnet returns DeFi bluechips not meme coins
  for (const chain of ['base']) {
    try {
      const r = await get(`https://api.bankr.bot/v1/trending?chain=${chain}`, {
        Authorization: `Bearer ${BANKR_API}`,
      });
      const tokens = r.body?.data || r.body?.tokens || [];
      for (const t of tokens) {
        const sym = (t.symbol || t.ticker || '').toUpperCase();
        if (!sym || SKIP_SYMS.has(sym)) continue;
        results.push({
          symbol: sym,
          address: t.address || t.contractAddress || t.token_address,
          chain: 'base',
          txnCount24h: t.txnCount24h || t.transactions_24h || 0,
          volume24h: t.volume24h || t.volume_24h || 0,
          priceChange24h: t.priceChange24h || t.price_change_24h || 0,
        });
      }
    } catch (e) {
      console.warn(`  [discover] Bankr trending ${chain} error: ${e.message}`);
    }
  }
  return results;
}

/**
 * Vet a token via GeckoTerminal pool data
 * Returns vetting result or null if fails
 */
async function vetToken(symbol, address, chain) {
  try {
    const network = chain === 'base' ? 'base' : 'eth';

    // Search for pool by token address
    let poolAddr, poolData;
    if (address) {
      const r = await get(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`);
      poolData = r.body?.data?.[0];
    }

    if (!poolData) {
      // Fallback: search by symbol
      const r = await get(`https://api.geckoterminal.com/api/v2/search/pools?query=${symbol}&network=${network}&page=1`);
      poolData = r.body?.data?.[0];
    }

    if (!poolData) return null;

    const attrs = poolData.attributes;
    poolAddr = attrs.address;

    const liq      = parseFloat(attrs.reserve_in_usd || 0);
    const vol24h   = parseFloat(attrs.volume_usd?.h24 || 0);
    const fdv      = parseFloat(attrs.fdv_usd || 0);
    const change1h = parseFloat(attrs.price_change_percentage?.h1 || 0);
    const change24h = parseFloat(attrs.price_change_percentage?.h24 || 0);
    const buys24h  = attrs.transactions?.h24?.buys || 0;
    const sells24h = attrs.transactions?.h24?.sells || 0;
    const buyers   = attrs.transactions?.h24?.buyers || 0;
    const sellers  = attrs.transactions?.h24?.sellers || 0;
    const createdAt = attrs.pool_created_at ? new Date(attrs.pool_created_at) : null;
    const ageDays  = createdAt ? (Date.now() - createdAt.getTime()) / 86400000 : 0;
    const price    = parseFloat(attrs.base_token_price_usd || 0);
    const volLiq   = liq > 0 ? vol24h / liq : 0;
    const buyRatio = (buys24h + sells24h) > 0 ? buys24h / (buys24h + sells24h) : 0;

    const vet = {
      pass: true,
      reasons: [],
      symbol, address, chain, network, poolAddr, price,
      liq, vol24h, fdv, change1h, change24h, ageDays, volLiq, buyRatio, buys24h, sells24h, buyers, sellers,
    };

    if (liq < VET.minLiquidityUSD)    { vet.pass = false; vet.reasons.push(`liq $${Math.round(liq/1000)}K < $50K`); }
    if (fdv > VET.maxFDV)             { vet.pass = false; vet.reasons.push(`FDV $${Math.round(fdv/1e6)}M > $500M`); }
    if (fdv > 0 && fdv < VET.minFDV)  { vet.pass = false; vet.reasons.push(`FDV $${Math.round(fdv/1000)}K < $500K`); }
    if (ageDays < VET.minAgeDays)     { vet.pass = false; vet.reasons.push(`age ${ageDays.toFixed(1)}d < 3d`); }
    if (vol24h < VET.minVol24hUSD)    { vet.pass = false; vet.reasons.push(`vol $${Math.round(vol24h/1000)}K < $10K`); }
    if (volLiq < VET.minVolLiqRatio)  { vet.pass = false; vet.reasons.push(`vol/liq ${(volLiq*100).toFixed(1)}% < 5%`); }
    if (buyRatio < VET.maxBuyerSellRatio) { vet.pass = false; vet.reasons.push(`buyRatio ${(buyRatio*100).toFixed(0)}% < 25%`); }

    return vet;
  } catch (e) {
    return null;
  }
}

/**
 * Fetch recent hourly bars for a discovered token from GeckoTerminal
 * Returns array of OHLCV bars or []
 */
async function fetchDiscoveredBars(network, poolAddr, limit = 120) {
  try {
    const r = await get(
      `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddr}/ohlcv/hour?limit=${limit}`
    );
    const list = r.body?.data?.attributes?.ohlcv_list || [];
    return list.map(([ts, o, h, l, c, v]) => ({
      ts: ts * 1000, time: new Date(ts * 1000).toISOString(),
      open: +o, high: +h, low: +l, close: +c, volume: +v,
    })).sort((a, b) => a.ts - b.ts);
  } catch (e) {
    return [];
  }
}

/**
 * Compute a quick momentum score for a discovered token
 * Returns { score, signals } or null
 */
function scoreDiscovered(bars) {
  if (!bars || bars.length < MIN_BARS) return null;

  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const n = closes.length;

  // 24h return
  const ret24h = n >= 25 ? (closes[n-1] - closes[n-25]) / closes[n-25] : 0;
  // 4h return
  const ret4h  = n >= 5  ? (closes[n-1] - closes[n-5])  / closes[n-5]  : 0;

  // Volume burst (last 4h vs prior 24h avg)
  const vol4h   = volumes.slice(-4).reduce((s, v) => s + v, 0) / 4;
  const vol24h  = volumes.slice(-24).reduce((s, v) => s + v, 0) / 24;
  const volBurst = vol4h / (vol24h || 1);

  // OBV direction (12h)
  let obv = 0;
  const obvs = [];
  for (let i = 1; i < n; i++) {
    obv += volumes[i] * (closes[i] > closes[i-1] ? 1 : closes[i] < closes[i-1] ? -1 : 0);
    if (i >= n - 13) obvs.push(obv);
  }
  const obvRising = obvs.length >= 2 && obvs[obvs.length-1] > obvs[0];

  // Combined score
  const score = (
    Math.tanh(ret4h * 20)  * 0.35 +
    Math.tanh(ret24h * 5)  * 0.35 +
    Math.tanh((volBurst - 1) * (ret4h > 0 ? 2 : -2)) * 0.2 +
    (obvRising ? 0.1 : -0.05)
  );

  return {
    score: Math.max(-1, Math.min(1, score)),
    signals: {
      ret4h: (ret4h * 100).toFixed(2) + '%',
      ret24h: (ret24h * 100).toFixed(2) + '%',
      volBurst: volBurst.toFixed(2) + 'x',
      obvRising,
    },
  };
}

/**
 * Main discovery function — call once per agent cycle
 *
 * Returns array of discovery candidates:
 * [{
 *   symbol, address, chain, network, poolAddr, price,
 *   score, signals, vet,
 *   source: 'bankr_trending' | 'checkr_spike',
 * }]
 *
 * @param {string[]} knownSymbols - symbols already in fixed universe (skip duplicates)
 * @param {Object[]} checkrSpikes - from checkr.getSpikes() (optional)
 */
async function discover(knownSymbols = [], checkrSpikes = []) {
  const known = new Set(knownSymbols.map(s => s.toUpperCase()));
  const candidates = [];

  // ── Source 1: Bankr trending ──────────────────────────────────
  const trending = await fetchBankrTrending();
  for (const t of trending) {
    if (known.has(t.symbol)) continue;
    candidates.push({ ...t, source: 'bankr_trending', score: 0 });
  }

  // ── Source 2: Checkr spikes ───────────────────────────────────
  for (const spike of (checkrSpikes || [])) {
    const sym = (spike.symbol || spike.ticker || '').toUpperCase();
    if (!sym || known.has(sym) || candidates.find(c => c.symbol === sym)) continue;
    candidates.push({
      symbol: sym,
      address: spike.address || null,
      chain: 'base', // Checkr is Base-focused
      source: 'checkr_spike',
      attentionVelocity: spike.velocity || 0,
      score: 0,
    });
  }

  if (!candidates.length) return [];

  console.log(`  [discover] ${candidates.length} candidates from trending+spikes, vetting...`);

  // ── Vet each candidate ────────────────────────────────────────
  const results = [];
  for (const cand of candidates) {
    await sleep(500); // GT rate limit: 30 req/min
    const vet = await vetToken(cand.symbol, cand.address, cand.chain);
    if (!vet) {
      console.log(`  [discover] ${cand.symbol}: no pool data — skip`);
      continue;
    }

    if (!vet.pass) {
      console.log(`  [discover] ${cand.symbol}: ❌ ${vet.reasons.join(', ')}`);
      continue;
    }

    // Fetch bars and score
    await sleep(500);
    const bars = await fetchDiscoveredBars(vet.network, vet.poolAddr);
    const scored = scoreDiscovered(bars);

    if (!scored || scored.score <= 0) {
      console.log(`  [discover] ${cand.symbol}: ✓ vetted but score ${scored?.score?.toFixed(3) ?? 'n/a'} ≤ 0 — skip`);
      continue;
    }

    // Enrich with Alchemy transfer stats (buyer/seller/whale concentration)
    let transferStats = null;
    if (vet.address && vet.chain === 'base') {
      try {
        const alchSignal = await getTokenSignal(vet.address, 'base');
        transferStats = alchSignal?.transferStats || null;
        if (transferStats) {
          // Penalise whale concentration > 50% — likely rug
          if (transferStats.topBuyerConcentration > 0.6) {
            console.log(`  [discover] ${cand.symbol}: ❌ Alchemy whale concentration ${(transferStats.topBuyerConcentration*100).toFixed(0)}% — skip`);
            continue;
          }
        }
      } catch { /* Alchemy optional — skip on error */ }
    }

    const result = {
      ...cand,
      ...vet,
      score: scored.score,
      signals: scored.signals,
      barsAvailable: bars.length,
      transferStats,
    };

    console.log(`  [discover] ${cand.symbol}: ✅ score=${scored.score.toFixed(3)} | liq=$${Math.round(vet.liq/1000)}K | ${Object.entries(scored.signals).map(([k,v])=>k+'='+v).join(' ')}${transferStats ? ` | buyers=${transferStats.uniqueBuyers} whale=${(transferStats.topBuyerConcentration*100).toFixed(0)}%` : ''}`);
    results.push(result);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

module.exports = { discover, vetToken, scoreDiscovered, fetchDiscoveredBars };
