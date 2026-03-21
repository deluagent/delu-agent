/**
 * fetch_onchain.js — Fetch Base token price history via Alchemy Prices API
 *
 * Replaces Binance OHLCV fetching for autoresearch.
 * All tokens are live Base mainnet tokens — real onchain data.
 *
 * Limits:
 *   - 1h interval: max 30 days (721 bars)
 *   - Rate limit: ~10 req/s on free tier → 300ms between calls
 *
 * Output: data/history_onchain/{SYM}_alchemy_1h.json
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ALCHEMY_KEY  = (process.env.ALCHEMY_KEY || '').replace(/\s/g, '');
const PRICES_API   = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_KEY}`;
const HISTORY_DIR  = path.join(__dirname, '../data/history_onchain');

// Base ecosystem token universe — real onchain addresses
const TOKENS = [
  // Core infrastructure
  { sym: 'WETH',    addr: '0x4200000000000000000000000000000000000006' },
  { sym: 'cbBTC',   addr: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' },
  { sym: 'USDC',    addr: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  // DeFi
  { sym: 'AERO',    addr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
  { sym: 'WELL',    addr: '0xA88594D404727625A9437C3f886C7643872296AE' },
  // AI agents
  { sym: 'VIRTUAL', addr: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b' },
  { sym: 'AIXBT',   addr: '0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825' },
  // Memes / community
  { sym: 'BRETT',   addr: '0x532f27101965dd16442E59d40670FaF5eBB142E4' },
  { sym: 'DEGEN',   addr: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' },
  { sym: 'TOSHI',   addr: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4' },
  { sym: 'HIGHER',  addr: '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe' },
  { sym: 'MOCHI',   addr: '0xf6e932ca12afa26665dc4dde7e27be02a7c02e50' },
  // Gaming / social
  { sym: 'FARCAST', addr: '0x768be13e1680b5ebE0024C42c896E3db59ec0149' }, // FXS proxy
  // Trending tokens we've traded
  { sym: 'MOLT',    addr: '0xb695559b26bb2c9703ef1935c37aeae9526bab07' },
  { sym: 'KTA',     addr: '0xc0634090f2fe6c6d75e61be2b949464abb498973' },
  // Cross-chain bridged
  { sym: 'SOL_B',   addr: '0x311935cd80b76769bf2ecc9d8ab7635b2139cf82' }, // SOL on Base
  { sym: 'BLUE',    addr: '0xf895783b2931c919955e18b5e3343e7c7c456ba3' }, // BLUEAGENT
  { sym: 'LUKSO',   addr: '0x81040cfd2bb62062525d958ad01931988a590b07' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchToken(sym, addr) {
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
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.data?.length) return resolve(null);
          // Build OHLCV bars from price-per-hour data
          const prices = j.data.map(b => parseFloat(b.value) || 0);
          const avgChg = prices.reduce((s, p, i) => {
            if (i === 0 || prices[i-1] === 0) return s;
            return s + Math.abs(p - prices[i-1]) / prices[i-1];
          }, 0) / Math.max(1, prices.length - 1);

          const bars = j.data.map((b, i) => {
            const close = parseFloat(b.value) || 0;
            const open  = i > 0 ? parseFloat(j.data[i-1].value) || close : close;
            const high  = Math.max(open, close);
            const low   = Math.min(open, close);
            const pctChg = open > 0 ? Math.abs(close - open) / open : 0;
            const volume = avgChg > 0 ? pctChg / avgChg : 1;
            return { ts: new Date(b.timestamp).getTime(), open, high, low, close, volume };
          });
          resolve({ sym, addr, bars });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function main() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  console.log(`Fetching onchain price history from Alchemy (Base mainnet)...`);
  console.log(`Output: ${HISTORY_DIR}`);

  const results = { fetched: 0, failed: 0, tokens: [] };

  for (const { sym, addr } of TOKENS) {
    const file = path.join(HISTORY_DIR, `${sym}_alchemy_1h.json`);
    // Skip if fresh (< 1h old)
    if (fs.existsSync(file)) {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age < 60 * 60 * 1000) {
        process.stdout.write(`·`);
        results.fetched++;
        results.tokens.push(sym);
        continue;
      }
    }
    const result = await fetchToken(sym, addr);
    if (result?.bars?.length) {
      fs.writeFileSync(file, JSON.stringify({ sym, addr, bars: result.bars }));
      process.stdout.write(`✓`);
      results.fetched++;
      results.tokens.push(sym);
    } else {
      process.stdout.write(`✗`);
      results.failed++;
      console.log(` [${sym} failed]`);
    }
    await sleep(350); // respect rate limits
  }

  console.log(`\nDone: ${results.fetched} tokens fetched, ${results.failed} failed`);
  console.log(`Universe: ${results.tokens.join(', ')}`);

  // Write manifest
  const manifest = {
    fetchedAt:  new Date().toISOString(),
    tokens:     results.tokens,
    bars:       721,
    interval:   '1h',
    source:     'alchemy-base-mainnet',
    dataDir:    HISTORY_DIR,
  };
  fs.writeFileSync(path.join(HISTORY_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { fetchOnchainData: main, TOKENS };
