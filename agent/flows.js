/**
 * Wallet flow signals via DexScreener
 * Free, no API key, gives buy/sell pressure per token
 *
 * Net buy pressure = (buys - sells) / (buys + sells)
 * > 0 = accumulation (bullish flow)
 * < 0 = distribution (bearish flow)
 *
 * This is Strategy 2's W_t (wallet inflow factor)
 */

// Token addresses on Base for our universe
const TOKEN_ADDRESSES = {
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
  BRETT:   '0x532f27101965dd16442e59d40670faf5ebb142e4',
  DEGEN:   '0x4ed4e862860bed51a9570b96d89af5e1b0efefed',
  AERO:    '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
  CLANKER: '0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb',
  ODAI:    '0x0086cFF0c1E5D17b19F5bCd4c8840a5B4251D959',
  JUNO:    '0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07',
  FELIX:   '0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07',
  CLAWD:   '0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07',
  CLAWNCH: '0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be',
};

/**
 * Fetch flow data for a batch of tokens from DexScreener
 * Max ~10 addresses per call
 * @param {string[]} symbols
 * @returns {Object} { SYMBOL: { netBuyPct, buys, sells, vol24h, liq, priceUsd } }
 */
async function getFlows(symbols) {
  const addresses = symbols
    .map(s => TOKEN_ADDRESSES[s])
    .filter(Boolean);

  if (addresses.length === 0) return {};

  const url = `https://api.dexscreener.com/latest/dex/tokens/${addresses.join(',')}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`DexScreener ${r.status}`);
  const data = await r.json();

  const result = {};
  const seen = new Set();

  for (const pair of (data.pairs || [])) {
    const sym = pair.baseToken?.symbol?.toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);

    const txns = pair.txns?.h24 || {};
    const buys  = txns.buys  || 0;
    const sells = txns.sells || 0;
    const total = buys + sells;
    const netBuyPct = total > 0 ? (buys - sells) / total : 0;

    // 1h flow
    const txns1h = pair.txns?.h1 || {};
    const buys1h  = txns1h.buys  || 0;
    const sells1h = txns1h.sells || 0;
    const total1h = buys1h + sells1h;
    const netBuyPct1h = total1h > 0 ? (buys1h - sells1h) / total1h : 0;

    result[sym] = {
      netBuyPct:    +netBuyPct.toFixed(4),    // -1 to +1, 24h
      netBuyPct1h:  +netBuyPct1h.toFixed(4),  // -1 to +1, 1h
      buys,
      sells,
      buys1h,
      sells1h,
      vol24h:       pair.volume?.h24  || 0,
      vol1h:        pair.volume?.h1   || 0,
      liq:          pair.liquidity?.usd || 0,
      priceUsd:     parseFloat(pair.priceUsd) || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      // Accumulation signal: price flat/down but buyers dominating
      accumulating: netBuyPct > 0.10 && (pair.priceChange?.h24 || 0) < 20,
      distributing: netBuyPct < -0.10,
    };
  }

  return result;
}

/**
 * Get flow for all tokens in our Base universe
 * Batched into groups of 8 to respect URL length
 */
async function getAllFlows() {
  const symbols = Object.keys(TOKEN_ADDRESSES);
  const batchSize = 8;
  const result = {};

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    try {
      const flows = await getFlows(batch);
      Object.assign(result, flows);
    } catch(e) {
      console.warn(`[flows] batch ${i} failed: ${e.message}`);
    }
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return result;
}

/**
 * Compute the Strategy 2 wallet inflow factor W_t
 * Normalized to [0, 1] for positive flow, 0 for negative
 * @param {object} flow - from getFlows()
 * @returns {number} W_t
 */
function walletInflowFactor(flow) {
  if (!flow) return 0;
  // Combine 24h and 1h flows (1h more recent = higher weight)
  const combined = 0.4 * flow.netBuyPct + 0.6 * flow.netBuyPct1h;
  return Math.max(0, combined);  // only positive = accumulation
}

/**
 * Liquidity quality score — penalize thin markets
 * @param {object} flow
 * @returns {number} 0-1, 1 = liquid enough to trade
 */
function liquidityScore(flow) {
  if (!flow) return 0;
  const liq = flow.liq;
  if (liq < 50000)  return 0.1;   // < $50K: very risky
  if (liq < 200000) return 0.4;   // < $200K: risky
  if (liq < 500000) return 0.7;   // < $500K: ok
  return 1.0;                     // >= $500K: liquid enough
}

module.exports = { getFlows, getAllFlows, walletInflowFactor, liquidityScore, TOKEN_ADDRESSES };
