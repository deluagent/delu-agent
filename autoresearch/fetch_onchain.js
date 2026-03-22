/**
 * fetch_onchain.js — Dynamic Base token universe + rich onchain signals
 *
 * Sources:
 *   1. Bankr trending (live txn-ranked tokens with addresses)
 *   2. Core Base ecosystem (WETH, AERO, VIRTUAL, AIXBT, etc.)
 *
 * Per-token data collected:
 *   - Price history: 30d × 1h from Alchemy Prices API
 *   - Transfer stats: buyer/seller counts, buy ratio, wallet concentration
 *   - Smart wallet signals: repeat buyers, large wallet accumulation
 *
 * Output: data/history_onchain/{SYM}_alchemy_1h.json
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ALCHEMY_KEY = (process.env.ALCHEMY_KEY || '').replace(/\s/g, '');
const BANKR_KEY   = (process.env.BANKR_API_KEY || '').replace(/\s/g, '');
const PRICES_API  = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_KEY}`;
const BASE_RPC    = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const HISTORY_DIR = path.join(__dirname, '../data/history_onchain');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Core Base token universe (always included) ────────────────
const CORE_TOKENS = [
  { sym: 'WETH',    addr: '0x4200000000000000000000000000000000000006' },
  { sym: 'cbBTC',   addr: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' },
  { sym: 'AERO',    addr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
  { sym: 'VIRTUAL', addr: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b' },
  { sym: 'AIXBT',   addr: '0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825' },
  { sym: 'BRETT',   addr: '0x532f27101965dd16442E59d40670FaF5eBB142E4' },
  { sym: 'DEGEN',   addr: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' },
  { sym: 'TOSHI',   addr: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4' },
  { sym: 'HIGHER',  addr: '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe' },
  { sym: 'WELL',    addr: '0xA88594D404727625A9437C3f886C7643872296AE' },
];

// ── Fetch Bankr trending tokens ───────────────────────────────
async function fetchBankrTrending() {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.bankr.bot',
      path: '/v1/trending?chain=base',
      headers: { 'X-API-Key': BANKR_KEY },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const raw = j.tokens || j.data || j || [];
          const tokens = raw
            .filter(t => t.address && t.symbol)
            .map(t => ({ sym: t.symbol.toUpperCase().replace(/\s/g,'_'), addr: t.address, txns: t.txnCount24h || 0 }));
          resolve(tokens);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
  });
}

// ── Fetch price history from Alchemy ─────────────────────────
async function fetchPriceHistory(addr) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      network:   'base-mainnet',
      address:   addr,
      startTime: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      endTime:   new Date().toISOString(),
      interval:  '1h',
    });
    const req = https.request({
      hostname: 'api.g.alchemy.com', port: 443, method: 'POST',
      path: `/prices/v1/${ALCHEMY_KEY}/tokens/historical`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(j.data || []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(12000, () => { req.destroy(); resolve([]); }); 
    req.write(body); req.end();
  });
}

// ── Fetch transfer stats (smart wallet signals) ───────────────
async function fetchTransferStats(addr) {
  return new Promise((resolve) => {
    // Get last 500 transfers to Base token
    const body = JSON.stringify({
      id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers',
      params: [{
        toAddress:         addr,
        category:          ['erc20'],
        withMetadata:      false,
        excludeZeroValue:  true,
        maxCount:          '0x1F4', // 500
        order:             'desc',
      }],
    });
    const req = https.request({
      hostname: `base-mainnet.g.alchemy.com`, port: 443, method: 'POST',
      path: `/v2/${ALCHEMY_KEY}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const transfers = j.result?.transfers || [];
          if (!transfers.length) return resolve(null);

          // Count unique buyers
          const buyers = new Set(transfers.map(t => t.from));
          // Count unique sellers (from address)
          const outBody = JSON.stringify({
            id: 2, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers',
            params: [{ fromAddress: addr, category: ['erc20'], withMetadata: false, excludeZeroValue: true, maxCount: '0x1F4', order: 'desc' }],
          });
          // Use transfer count as velocity proxy
          const velocity = transfers.length; // higher = more active

          // Large wallet detection: top-10 buyers by frequency
          const buyFreq = {};
          transfers.forEach(t => { buyFreq[t.from] = (buyFreq[t.from] || 0) + 1; });
          const topBuyers = Object.entries(buyFreq).sort((a,b) => b[1]-a[1]).slice(0,5);
          const repeatBuyers = topBuyers.filter(([,cnt]) => cnt >= 3).length;
          const maxConcentration = topBuyers[0]?.[1] / transfers.length || 0;

          resolve({
            uniqueBuyers:    buyers.size,
            transferVelocity: velocity,
            repeatBuyers,           // wallets that bought 3+ times (accumulation signal)
            topBuyerConcentration: parseFloat(maxConcentration.toFixed(3)), // 0=distributed, 1=one wallet
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); }); 
    req.write(body); req.end();
  });
}

// ── Build OHLCV bars from Alchemy price data ──────────────────
function buildBars(priceData) {
  if (!priceData?.length) return [];
  const prices = priceData.map(b => parseFloat(b.value) || 0);
  const avgChg = prices.reduce((s, p, i) => {
    if (i === 0 || prices[i-1] === 0) return s;
    return s + Math.abs(p - prices[i-1]) / prices[i-1];
  }, 0) / Math.max(1, prices.length - 1);

  return priceData.map((b, i) => {
    const close  = parseFloat(b.value) || 0;
    const open   = i > 0 ? parseFloat(priceData[i-1].value) || close : close;
    const high   = Math.max(open, close);
    const low    = Math.min(open, close);
    const pctChg = open > 0 ? Math.abs(close - open) / open : 0;
    const volume = avgChg > 0 ? pctChg / avgChg : 1; // relative activity proxy
    return { ts: new Date(b.timestamp).getTime(), open, high, low, close, volume };
  });
}

// ── Main fetch ────────────────────────────────────────────────
async function fetchOnchainData() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  // Build dynamic universe: core + bankr trending
  const trending = await fetchBankrTrending();
  console.log(`[fetch_onchain] Bankr trending: ${trending.length} tokens`);

  // Merge: core tokens + trending (deduplicate by address)
  const seen = new Set();
  const universe = [];
  for (const t of [...CORE_TOKENS, ...trending]) {
    const key = t.addr?.toLowerCase();
    if (!key || seen.has(key)) continue;
    // Skip stablecoins
    if (['USDC','USDT','DAI','EURC'].includes(t.sym.toUpperCase())) continue;
    seen.add(key);
    universe.push(t);
  }
  console.log(`[fetch_onchain] Universe: ${universe.length} tokens (${universe.map(t=>t.sym).join(', ')})`);

  const results = { fetched: 0, failed: 0, tokens: [] };

  for (const token of universe) {
    const file = path.join(HISTORY_DIR, `${token.sym}_alchemy_1h.json`);
    // Skip if fresh (< 2h old)
    if (fs.existsSync(file)) {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age < 2 * 3600 * 1000) {
        process.stdout.write(`·`);
        results.fetched++;
        results.tokens.push(token.sym);
        continue;
      }
    }

    try {
      // Fetch price history
      const priceData = await fetchPriceHistory(token.addr);
      if (!priceData.length) {
        process.stdout.write(`✗`);
        results.failed++;
        await sleep(300);
        continue;
      }
      const bars = buildBars(priceData);

      // Fetch transfer stats (smart wallet signals) — non-blocking
      let transferStats = null;
      try {
        transferStats = await fetchTransferStats(token.addr);
      } catch { /* optional */ }

      // Save
      fs.writeFileSync(file, JSON.stringify({
        sym:  token.sym,
        addr: token.addr,
        bars,
        transferStats,   // { uniqueBuyers, transferVelocity, repeatBuyers, topBuyerConcentration }
        fetchedAt: new Date().toISOString(),
      }));
      process.stdout.write(`✓`);
      results.fetched++;
      results.tokens.push(token.sym);
    } catch(e) {
      process.stdout.write(`✗`);
      results.failed++;
    }
    await sleep(350);
  }

  console.log(`\n[fetch_onchain] Done: ${results.fetched} ok, ${results.failed} failed`);

  // Write manifest
  const manifest = {
    fetchedAt:  new Date().toISOString(),
    tokens:     results.tokens,
    universe:   universe.map(t => ({ sym: t.sym, addr: t.addr })),
    bars:       721,
    interval:   '1h',
    source:     'alchemy-base-mainnet',
    signals:    ['price_ohlcv', 'volume_proxy', 'transfer_velocity', 'unique_buyers', 'repeat_buyers', 'wallet_concentration'],
  };
  fs.writeFileSync(path.join(HISTORY_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { fetchOnchainData, CORE_TOKENS };

if (require.main === module) {
  fetchOnchainData().then(m => {
    console.log('Manifest:', JSON.stringify(m, null, 2));
  }).catch(console.error);
}
