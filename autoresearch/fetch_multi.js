/**
 * fetch_multi.js — Fetch 4h, 15m, 30m OHLCV data from Binance
 * 
 * 4h:  90 days = 540 bars
 * 30m: 30 days = 1440 bars
 * 15m: 15 days = 1440 bars
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const HISTORY_DIR = path.join(__dirname, '../data/history');

const TOKENS = [
  'BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOGE',
  'LINK','AAVE','UNI','ARB','OP','MATIC',
  'FET','AGIX','OCEAN','RNDR',
  'PEPE','SHIB','BONK','WIF',
  'NEAR','APT','SUI','INJ',
  'VIRTUAL','AIXBT','TAO','GRT','ARKM',
];

const TIMEFRAMES = [
  { interval: '4h',  limit: 540,  suffix: '4h'  },
  { interval: '30m', limit: 1440, suffix: '30m' },
  { interval: '15m', limit: 1440, suffix: '15m' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchBinance(sym, interval, limit) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${interval}&limit=${limit}`;
    const req = https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const klines = JSON.parse(data);
          if (!Array.isArray(klines)) return reject(new Error(`Bad response for ${sym}: ${data.slice(0,60)}`));
          resolve(klines.map(k => ({
            ts: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
          })));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  for (const { interval, limit, suffix } of TIMEFRAMES) {
    console.log(`\nFetching ${interval} bars (${limit} bars per token)...`);
    let done = 0, failed = 0;

    for (const sym of TOKENS) {
      const file = path.join(HISTORY_DIR, `${sym}_binance_${suffix}.json`);
      // Skip if fresh (< 2h old)
      if (fs.existsSync(file)) {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age < 2 * 60 * 60 * 1000) { process.stdout.write(`.`); done++; continue; }
      }
      try {
        const bars = await fetchBinance(sym, interval, limit);
        fs.writeFileSync(file, JSON.stringify(bars));
        process.stdout.write(`✓`);
        done++;
      } catch(e) {
        process.stdout.write(`✗`);
        failed++;
      }
      await sleep(300);
    }
    console.log(`\n  ${done} ok, ${failed} failed`);
  }
  console.log('\nDone.');
}

main().catch(console.error);
