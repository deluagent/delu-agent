/**
 * bankr_market.js — Bankr onchain market data signals
 *
 * Uses Bankr's /v1/trending endpoint (free, uses existing BANKR_API_KEY)
 * Returns trending tokens on Base + Ethereum with onchain DEX metrics.
 *
 * Signals extracted:
 *  - txnMomentum: transaction count spike vs expected (high txns = attention)
 *  - volumeScore: normalized DEX volume 0-1
 *  - trendingRank: position in trending list (1 = hottest)
 *  - priceChange24h: raw 24h price change %
 *
 * Complements:
 *  - Checkr: social/CT attention
 *  - GeckoTerminal flows: buy/sell ratio
 *  - Bankr trending: raw onchain txn activity
 */

'use strict';

const https = require('https');

function get(path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.bankr.bot',
      path,
      headers: { 'X-API-Key': apiKey },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse error: ${data.slice(0,100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Fetch trending tokens from Bankr for a given chain
 * Returns array of { symbol, priceUSD, volume24h, priceChange24h, txnCount24h, marketCap, liquidity }
 */
async function fetchTrending(chain = 'base', apiKey) {
  const data = await get(`/v1/trending?chain=${chain}`, apiKey);
  return data.tokens || [];
}

/**
 * Build attention map from Bankr trending data
 * Returns: { SYM: { trendingRank, txnCount24h, volume24h, priceChange24h, volumeScore, txnScore } }
 *
 * Designed to be merged with Checkr attention map.
 */
async function getBankrAttention(apiKey) {
  const [baseTokens, ethTokens] = await Promise.allSettled([
    fetchTrending('base', apiKey),
    fetchTrending('mainnet', apiKey),
  ]);

  const allTokens = [
    ...(baseTokens.status === 'fulfilled' ? baseTokens.value : []),
    ...(ethTokens.status === 'fulfilled'  ? ethTokens.value  : []),
  ];

  if (!allTokens.length) return {};

  // Normalize volume and txn count across all trending tokens
  const maxVol  = Math.max(...allTokens.map(t => t.volume24h   || 0), 1);
  const maxTxns = Math.max(...allTokens.map(t => t.txnCount24h || 0), 1);

  const attention = {};
  allTokens.forEach((token, idx) => {
    const sym = token.symbol?.toUpperCase();
    if (!sym) return;

    const volumeScore = (token.volume24h   || 0) / maxVol;
    const txnScore    = (token.txnCount24h || 0) / maxTxns;

    // Combined bankr signal: volume + transaction activity
    // txnScore weighted higher — txn count is harder to fake than volume
    const bankrSignal = txnScore * 0.6 + volumeScore * 0.4;

    // Spike flag: top 3 by txn count = notable onchain activity
    const isSpike = idx < 3 && txnScore > 0.3;

    attention[sym] = {
      trendingRank:  idx + 1,
      txnCount24h:   token.txnCount24h,
      volume24h:     Math.round(token.volume24h || 0),
      priceChange24h: token.priceChange24h,
      marketCap:     Math.round(token.marketCap || 0),
      liquidity:     Math.round(token.liquidity || 0),
      volumeScore:   Math.round(volumeScore * 100) / 100,
      txnScore:      Math.round(txnScore * 100) / 100,
      bankrSignal:   Math.round(bankrSignal * 100) / 100,
      isSpike,
      dexId:         token.dexId,
    };
  });

  return attention;
}

module.exports = { getBankrAttention, fetchTrending };
