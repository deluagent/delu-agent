/**
 * fetch_hourly.js — Fetch and cache hourly OHLCV for all major tokens
 *
 * Source: Binance spot API (free, no key)
 * Interval: 1h, 180 days = 4320 bars per token
 * Output: data/history/{SYM}_binance_hourly.json
 *
 * Run once to build cache, then periodically to refresh.
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const HISTORY_DIR = path.join(__dirname, '../data/history');
const TOKENS = [
  'BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOGE','TRX','HBAR',
  'LINK','AAVE','UNI','MKR','CRV','COMP','SNX','BAL','YFI','SUSHI',
  'ARB','OP','MATIC','STX','IMX',
  'FET','AGIX','OCEAN','RNDR',
  'PEPE','SHIB','BONK','WIF','FLOKI',
  'NEAR','APT','SUI','INJ','ATOM','DOT','ALGO',
  'LTC','BCH','FIL','ETC','XLM',
  'SAND','MANA','AXS','1INCH',
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse error for ${url}: ${data.slice(0,100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHourly(sym, bars = 4320) {
  // Binance: max 1000 per request, so paginate
  const allBars = [];
  let endTime = Date.now();
  const limit = 1000;
  const needed = bars;

  while (allBars.length < needed) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&endTime=${endTime}&limit=${limit}`;
    const raw = await get(url);
    if (!raw?.length) break;
    // raw: [openTime, open, high, low, close, volume, ...]
    const parsed = raw.map(b => ({
      ts:     b[0],
      time:   new Date(b[0]).toISOString(),
      open:   parseFloat(b[1]),
      high:   parseFloat(b[2]),
      low:    parseFloat(b[3]),
      close:  parseFloat(b[4]),
      volume: parseFloat(b[5]),
    }));
    // Prepend (we're fetching backwards)
    allBars.unshift(...parsed);
    endTime = raw[0][0] - 1; // go further back
    if (raw.length < limit) break; // no more data
    await sleep(100); // rate limit
  }

  // Deduplicate and sort ascending
  const seen = new Set();
  const unique = allBars.filter(b => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; });
  unique.sort((a, b) => a.ts - b.ts);
  return unique.slice(-needed); // last N bars
}

async function main() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const forceRefresh = args.includes('--refresh');
  const BARS = 4320; // 180 days of hourly

  console.log(`Fetching ${BARS} hourly bars for ${TOKENS.length} tokens...`);

  let done = 0, skipped = 0, failed = 0;

  for (const sym of TOKENS) {
    const outFile = path.join(HISTORY_DIR, `${sym}_binance_hourly.json`);

    // Skip if recent cache exists (< 2h old) and not forced
    if (!forceRefresh && fs.existsSync(outFile)) {
      const stat = fs.statSync(outFile);
      const ageH = (Date.now() - stat.mtimeMs) / 3600000;
      if (ageH < 2) {
        process.stdout.write(`  ${sym} (cached)\n`);
        skipped++;
        continue;
      }
    }

    try {
      process.stdout.write(`  ${sym}... `);
      const bars = await fetchHourly(sym, BARS);
      const out = { fetchedAt: Date.now(), symbol: sym, interval: '1h', bars };
      fs.writeFileSync(outFile, JSON.stringify(out));
      process.stdout.write(`${bars.length} bars ✓\n`);
      done++;
      await sleep(300); // polite rate limiting
    } catch(e) {
      process.stdout.write(`FAILED: ${e.message}\n`);
      failed++;
    }
  }

  console.log(`\nDone: ${done} fetched, ${skipped} cached, ${failed} failed`);
  if (done > 0) console.log(`Output: ${HISTORY_DIR}/{SYM}_binance_hourly.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
