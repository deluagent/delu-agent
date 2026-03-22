/**
 * discover_alchemy.js — Alchemy-native token discovery for Base
 *
 * Strategy: scan recent ERC20 transfer activity on Base to find tokens
 * getting unusual buy pressure from MULTIPLE wallets in the last 1-2 hours.
 *
 * This catches things BEFORE they show up on Checkr or Bankr rankings:
 *   - New wallets accumulating the same token
 *   - Transfer velocity spike (many txs in short window)
 *   - Low seller ratio (people buying, not dumping)
 *   - Contract not yet in our known universe
 *
 * Cross-references with GeckoTerminal to get price/liquidity data.
 */

'use strict';

const https = require('https');

const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
const BASE_RPC    = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const GT_BASE     = 'https://api.geckoterminal.com/api/v2';

// Known stablecoin/bluechip contracts to skip (Base)
const SKIP_CONTRACTS = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0x4200000000000000000000000000000000000006', // WETH
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631', // AERO
  '0x532f27101965dd16442e59d40670faf5ebb142e4', // BRETT
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC
]);

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', port: 443,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let r = ''; res.on('data', d => r += d);
      res.on('end', () => { try { resolve(JSON.parse(r)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json;version=20230302' } }, res => {
      let r = ''; res.on('data', d => r += d);
      res.on('end', () => { try { resolve(JSON.parse(r)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Scan recent ERC20 transfers on Base — find contracts with unusual buy pressure
 * Looks back ~2 hours (Base ~2 blocks/sec = ~7200 blocks/hr)
 */
async function scanRecentTransfers(lookbackBlocks = 14400) { // ~2 hours
  if (!ALCHEMY_KEY) return [];

  const blockRes = await post(BASE_RPC, {
    jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [],
  });
  const latest = parseInt(blockRes.result, 16);
  const fromBlock = '0x' + (latest - lookbackBlocks).toString(16);

  // Get recent ERC20 transfers (broad scan — no contract filter)
  const res = await post(BASE_RPC, {
    jsonrpc: '2.0', id: 1,
    method: 'alchemy_getAssetTransfers',
    params: [{
      fromBlock,
      toBlock: 'latest',
      category: ['erc20'],
      withMetadata: true,
      maxCount: '0x3e8', // 1000 transfers
      excludeZeroValue: true,
    }],
  });

  const transfers = res?.result?.transfers || [];
  const ZERO = '0x0000000000000000000000000000000000000000';

  // Group by contract address
  const byContract = {};
  for (const t of transfers) {
    const contract = t.rawContract?.address?.toLowerCase();
    if (!contract || SKIP_CONTRACTS.has(contract)) continue;
    if (t.from === ZERO || t.to === ZERO) continue; // skip mint/burn

    if (!byContract[contract]) byContract[contract] = {
      contract,
      asset: t.asset,
      txs: [], buyers: new Set(), sellers: new Set(), blockNums: [],
    };

    byContract[contract].txs.push(t);
    byContract[contract].buyers.add(t.to);
    byContract[contract].sellers.add(t.from);
    byContract[contract].blockNums.push(parseInt(t.blockNum, 16));
  }

  return byContract;
}

/**
 * Score a contract's transfer activity
 * Returns score 0-1, higher = more unusual buy pressure
 */
function scoreActivity(data) {
  const buyers  = data.buyers.size;
  const sellers = data.sellers.size;
  const txCount = data.txs.length;
  const total   = buyers + sellers;
  const buyRatio = total > 0 ? buyers / total : 0;

  // Transfer velocity: spread of block numbers
  const blocks = data.blockNums;
  const blockSpread = blocks.length > 1 ? Math.max(...blocks) - Math.min(...blocks) : 0;
  // Txs per 100 blocks = velocity
  const velocity = blockSpread > 0 ? (txCount / blockSpread) * 100 : 0;

  // Repeat buyers (same address bought multiple times)
  const buyerCounts = {};
  data.txs.forEach(t => { buyerCounts[t.to] = (buyerCounts[t.to] || 0) + 1; });
  const repeatBuyers = Object.values(buyerCounts).filter(c => c > 1).length;

  // Top buyer concentration
  const maxBuys = Math.max(...Object.values(buyerCounts));
  const topConcentration = txCount > 0 ? maxBuys / txCount : 1;

  let score = 0;

  // Reward: many unique buyers
  if (buyers >= 10) score += 0.25;
  else if (buyers >= 5) score += 0.15;

  // Reward: high buy ratio
  if (buyRatio > 0.65) score += 0.25;
  else if (buyRatio > 0.55) score += 0.15;

  // Reward: velocity
  if (velocity > 5) score += 0.20;
  else if (velocity > 2) score += 0.10;

  // Reward: repeat buyers (conviction)
  if (repeatBuyers >= 3) score += 0.15;

  // Penalise: whale concentration
  if (topConcentration > 0.4) score -= 0.25;
  else if (topConcentration > 0.25) score -= 0.10;

  return {
    score: Math.max(0, Math.min(1, score)),
    buyers, sellers, txCount, buyRatio, velocity, repeatBuyers, topConcentration,
  };
}

/**
 * Validate contract via GeckoTerminal — get symbol, price, liquidity
 */
async function validateWithGecko(contractAddress) {
  try {
    const r = await get(`${GT_BASE}/networks/base/tokens/${contractAddress}/pools?page=1`);
    const pool = r.data?.[0];
    if (!pool) return null;

    const attrs = pool.attributes;
    const liq    = parseFloat(attrs.reserve_in_usd || 0);
    const vol24h = parseFloat(attrs.volume_usd?.h24 || 0);
    const fdv    = parseFloat(attrs.fdv_usd || 0);
    const price  = parseFloat(attrs.base_token_price_usd || 0);
    const change1h  = parseFloat(attrs.price_change_percentage?.h1 || 0);
    const change24h = parseFloat(attrs.price_change_percentage?.h24 || 0);
    const created = attrs.pool_created_at ? new Date(attrs.pool_created_at) : null;
    const ageDays = created ? (Date.now() - created.getTime()) / 86400000 : 0;
    // Pool name format: "SYMBOL / WETH 1%" — take first part
    const symbol  = attrs.name?.split('/')?.[0]?.trim().toUpperCase()
                 || pool.relationships?.base_token?.data?.id?.split('_')[1]?.slice(0,10).toUpperCase()
                 || 'UNKNOWN';

    // Basic sanity filters
    if (liq < 30_000)      return null; // too illiquid
    if (fdv > 500_000_000) return null; // already too big
    if (fdv > 0 && fdv < 100_000) return null; // too small / rug risk
    if (ageDays < 1)       return null; // brand new = dangerous

    return { symbol, address: contractAddress, liq, vol24h, fdv, price, change1h, change24h, ageDays, poolId: pool.id };
  } catch { return null; }
}

/**
 * Main discovery function
 * Returns array of { symbol, address, score, activityScore, source, ... }
 */
async function discoverAlchemy(knownSymbols = []) {
  if (!ALCHEMY_KEY) {
    console.log('  [alchemy_discover] ALCHEMY_KEY not set — skipping');
    return [];
  }

  const known = new Set(knownSymbols.map(s => s.toUpperCase()));
  console.log('  [alchemy_discover] Scanning Base ERC20 transfers (2h window)...');

  let byContract;
  try {
    byContract = await scanRecentTransfers(14400);
  } catch (e) {
    console.warn('  [alchemy_discover] Scan failed:', e.message?.slice(0, 60));
    return [];
  }

  const contracts = Object.values(byContract);
  console.log(`  [alchemy_discover] ${contracts.length} contracts with activity`);

  // Score activity and take top candidates
  const scored = contracts
    .map(data => ({ data, ...scoreActivity(data) }))
    .filter(c => c.score > 0.3 && c.buyers >= 4 && c.buyRatio > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8); // top 8 by activity score

  const results = [];
  for (const c of scored) {
    await sleep(400); // GT rate limit
    const gecko = await validateWithGecko(c.data.contract);
    if (!gecko) continue;
    if (known.has(gecko.symbol)) continue;

    const combined = 0.5 * c.score + 0.3 * Math.min(1, gecko.liq / 200_000) + 0.2 * Math.min(1, gecko.vol24h / 50_000);

    console.log(`  [alchemy_discover] ✅ ${gecko.symbol} | activity=${c.score.toFixed(2)} buyers=${c.buyers} buyRatio=${(c.buyRatio*100).toFixed(0)}% | liq=$${Math.round(gecko.liq/1000)}K fdv=$${Math.round((gecko.fdv||0)/1000)}K age=${gecko.ageDays.toFixed(1)}d`);

    results.push({
      symbol:        gecko.symbol,
      address:       c.data.contract,
      chain:         'base',
      source:        'alchemy_discover',
      score:         combined,
      activityScore: c.score,
      buyers:        c.buyers,
      buyRatio:      c.buyRatio,
      velocity:      c.velocity,
      repeatBuyers:  c.repeatBuyers,
      ...gecko,
    });
  }

  results.sort((a, b) => b.score - a.score);
  console.log(`  [alchemy_discover] ${results.length} new tokens found`);
  return results;
}

module.exports = { discoverAlchemy };
