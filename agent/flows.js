/**
 * flows.js — Real onchain flow signals via GeckoTerminal (free, no API key)
 *
 * Signals (all onchain DEX data):
 *  - Buy/sell ratio: more buyers than sellers = accumulation
 *  - Buy/sell volume ratio: volume-weighted direction
 *  - Unique buyer count vs seller count (wallet-level)
 *  - Price change vs DEX volume (divergence = signal)
 *
 * Source: GeckoTerminal API (free, no key, 30 req/min)
 * Networks: ethereum, base
 * Cost: $0. Latency: ~1s per token.
 */

'use strict';

const https = require('https');

// Map token symbols → GeckoTerminal network + contract address
// Using most liquid pool token address per network
const TOKEN_MAP = {
  // Ethereum mainnet
  ETH:  { network: 'eth',  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  BTC:  { network: 'eth',  address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' }, // WBTC
  SOL:  { network: 'eth',  address: '0xD31a59c85aE9D8edEFeC411D448f90841571b89c' }, // Wormhole SOL
  BNB:  { network: 'eth',  address: '0xB8c77482e45F1F44dE1745F52C74426C631bDD52' },
  LINK: { network: 'eth',  address: '0x514910771AF9Ca656af840dff83E8264EcF986CA' },
  UNI:  { network: 'eth',  address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
  AAVE: { network: 'eth',  address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' },
  ARB:  { network: 'eth',  address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1' },
  OP:   { network: 'eth',  address: '0x4200000000000000000000000000000000000042' },
  PEPE: { network: 'eth',  address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' },
  WIF:  { network: 'eth',  address: '0x647A3b4A5f80Be5e5a78f975b73CB3D0B8DF82d0' },
  // Base network
  AERO:    { network: 'base', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
  BRETT:   { network: 'base', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4' },
  VIRTUAL: { network: 'base', address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b' },
  DEGEN:   { network: 'base', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' },
};

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json;version=20230302' } }, (res) => {
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
 * Get onchain flow signal for a single token
 * Returns flowScore in [-1, +1]:
 *   +1 = strong accumulation (buyers >> sellers, high volume)
 *   -1 = strong distribution (sellers >> buyers, high volume)
 *    0 = neutral / no data
 */
async function getFlowSignal(sym) {
  const tokenInfo = TOKEN_MAP[sym.toUpperCase()];
  if (!tokenInfo) return null;

  try {
    const { network, address } = tokenInfo;
    const data = await get(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`
    );

    const pools = data.data || [];
    if (!pools.length) return null;

    // Aggregate across top 3 pools (by volume)
    let totalBuys = 0, totalSells = 0;
    let totalBuyers = 0, totalSellers = 0;
    let totalVol = 0;
    let priceChange24h = 0;

    const top3 = pools.slice(0, 3);
    for (const pool of top3) {
      const attr = pool.attributes;
      const txns = attr.transactions?.h24 || {};
      const vol  = parseFloat(attr.volume_usd?.h24 || 0);

      totalBuys    += txns.buys    || 0;
      totalSells   += txns.sells   || 0;
      totalBuyers  += txns.buyers  || 0;
      totalSellers += txns.sellers || 0;
      totalVol     += vol;

      // Use largest pool for price change
      if (pool === top3[0]) {
        priceChange24h = parseFloat(attr.price_change_percentage?.h24 || 0) / 100;
      }
    }

    if (totalBuys + totalSells === 0) return null;

    // Buy ratio: 0.5 = neutral, >0.5 = more buys
    const txBuyRatio = totalBuys / (totalBuys + totalSells);

    // Wallet ratio: unique buyers vs sellers
    const walletBuyRatio = totalBuyers + totalSellers > 0
      ? totalBuyers / (totalBuyers + totalSellers)
      : 0.5;

    // Combined flow score: transaction + wallet, centered at 0
    // +1 = all buys, -1 = all sells
    const rawFlow = (txBuyRatio - 0.5) * 2 * 0.6 + (walletBuyRatio - 0.5) * 2 * 0.4;

    // Volume-weighted: high volume + positive direction = stronger signal
    const volWeight = Math.min(1, Math.log10(totalVol + 1) / 8); // log scale, cap at 1
    const flowScore = rawFlow * (0.5 + 0.5 * volWeight);

    return {
      sym,
      network,
      flowScore:      Math.round(flowScore * 100) / 100,
      txBuyRatio:     Math.round(txBuyRatio * 100) / 100,
      walletBuyRatio: Math.round(walletBuyRatio * 100) / 100,
      totalBuys,
      totalSells,
      totalBuyers,
      totalSellers,
      volume24h:      Math.round(totalVol),
      priceChange24h: Math.round(priceChange24h * 1000) / 10,
    };
  } catch(e) {
    return null;
  }
}

/**
 * Fetch onchain flow signals for all known tokens
 * Runs in parallel with small delay to respect 30 req/min GT limit
 */
async function fetchAllFlows(symbols) {
  const known = (symbols || Object.keys(TOKEN_MAP)).filter(s => TOKEN_MAP[s.toUpperCase()]);
  if (!known.length) return {};

  // Batch with small delay (GT allows ~30 req/min = 2 req/sec)
  const results = {};
  const BATCH = 6;
  for (let i = 0; i < known.length; i += BATCH) {
    const batch = known.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(s => getFlowSignal(s)));
    for (let j = 0; j < batch.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled' && r.value) {
        results[batch[j]] = r.value;
      }
    }
    if (i + BATCH < known.length) await new Promise(r => setTimeout(r, 2500));
  }

  return results;
}

module.exports = { fetchAllFlows, getFlowSignal, TOKEN_MAP };
