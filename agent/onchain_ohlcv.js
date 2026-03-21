/**
 * onchain_ohlcv.js — Alchemy-powered price history for any Base token
 *
 * Uses:
 *   - Alchemy Prices API (tokens/historical): hourly price data
 *   - Alchemy Transfers API (alchemy_getAssetTransfers): buyer/seller counts
 *
 * Works for ANY Base token (microcaps, new launches, trending memes)
 * No Binance listing required. No GT rate limits.
 */

'use strict';

const https = require('https');

const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
const BASE_RPC    = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const PRICES_API  = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_KEY}`;

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const b = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(b),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Alchemy timeout')); });
    req.write(b);
    req.end();
  });
}

/**
 * Get hourly price bars for a Base token via Alchemy Prices API
 * Returns: [{ time, open, high, low, close, ts }]  (open=close=value, no true OHLC from this API)
 */
async function getHourlyBars(tokenAddress, hours = 48) {
  if (!ALCHEMY_KEY) throw new Error('ALCHEMY_KEY not set');
  const now   = new Date();
  const start = new Date(now - hours * 3600 * 1000);

  const res = await post(`${PRICES_API}/tokens/historical`, {
    network:   'base-mainnet',
    address:   tokenAddress,
    startTime: start.toISOString(),
    endTime:   now.toISOString(),
    interval:  '1h',
  });

  const data = res?.data || [];
  if (!data.length) return [];

  // Build OHLCV-compatible bars
  // Alchemy gives one price per hour — use as close price
  // Approximate open = prior bar's close
  // Volume proxy: use price-change magnitude as activity proxy (1 = avg activity)
  // This lets OBV/volume signals work even without true volume data
  const closes = data.map(b => parseFloat(b.value) || 0);
  const avgAbsChange = closes.reduce((s, c, i) => {
    if (i === 0) return s;
    const prev = closes[i - 1];
    return s + (prev > 0 ? Math.abs(c - prev) / prev : 0);
  }, 0) / Math.max(1, closes.length - 1);

  return data.map((b, i) => {
    const close = parseFloat(b.value) || 0;
    const open  = i > 0 ? parseFloat(data[i - 1].value) || close : close;
    const high  = Math.max(open, close);
    const low   = Math.min(open, close);
    // Volume proxy: relative price change vs average (so "big" bars show higher volume)
    const pctChg = open > 0 ? Math.abs(close - open) / open : 0;
    const volProxy = avgAbsChange > 0 ? pctChg / avgAbsChange : 1;
    return {
      time:  b.timestamp,
      ts:    new Date(b.timestamp).getTime(),
      open, high, low, close,
      volume: volProxy, // relative activity proxy (1 = average bar)
    };
  });
}

/**
 * Get current price for a Base token
 */
async function getCurrentPrice(tokenAddress) {
  const bars = await getHourlyBars(tokenAddress, 2);
  return bars.length ? bars[bars.length - 1].close : 0;
}

/**
 * Get transfer stats for a Base token (last N blocks ≈ 24h)
 * Returns: { totalTxs, uniqueBuyers, uniqueSellers, buyRatio, pageKey }
 */
async function getTransferStats(tokenAddress, blocks = 43200) {
  if (!ALCHEMY_KEY) return null;

  const blockRes = await post(BASE_RPC, {
    jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [],
  });
  const latestBlock = parseInt(blockRes.result, 16);

  const res = await post(BASE_RPC, {
    jsonrpc: '2.0', id: 1,
    method: 'alchemy_getAssetTransfers',
    params: [{
      fromBlock: '0x' + (latestBlock - blocks).toString(16),
      toBlock:   'latest',
      contractAddresses: [tokenAddress],
      category:  ['erc20'],
      withMetadata: false,
      maxCount:  '0x64', // 100 transfers
    }],
  });

  const transfers = res?.result?.transfers || [];
  const ZERO = '0x0000000000000000000000000000000000000000';

  // Exclude mint/burn
  const real = transfers.filter(t => t.from !== ZERO && t.to !== ZERO);
  const buyers  = new Set(real.map(t => t.to));
  const sellers = new Set(real.map(t => t.from));
  const total   = buyers.size + sellers.size;

  return {
    totalTxs:     real.length,
    uniqueBuyers:  buyers.size,
    uniqueSellers: sellers.size,
    buyRatio:      total > 0 ? buyers.size / total : 0.5,
  };
}

/**
 * Full signal for a trending token:
 * Returns {
 *   bars,           // hourly price bars (48h)
 *   ret1h, ret6h, ret12h, ret24h, ret48h,
 *   moveFrac,       // ret6h/ret24h — how much of the move is done
 *   momentum,       // recent hourly candle quality
 *   transferStats,  // buyer/seller counts
 *   currentPrice,
 * }
 */
async function getTokenSignal(tokenAddress, hours = 48) {
  const [bars, transferStats] = await Promise.allSettled([
    getHourlyBars(tokenAddress, hours),
    getTransferStats(tokenAddress),
  ]);

  const b = bars.status === 'fulfilled' ? bars.value : [];
  const ts = transferStats.status === 'fulfilled' ? transferStats.value : null;

  if (b.length < 6) return null;

  const n = b.length;
  const prices = b.map(x => x.close);
  const now    = prices[n - 1];

  const safe = (i) => prices[Math.max(0, n - 1 - i)] || now;

  const ret1h  = (now - safe(1))  / safe(1);
  const ret6h  = (now - safe(6))  / safe(6);
  const ret12h = (now - safe(12)) / safe(12);
  const ret24h = (now - safe(24)) / safe(24);
  const ret48h = (now - safe(47)) / safe(47);

  // Where in the move (last 6h vs last 24h)
  const moveFrac = ret24h > 0.005 ? Math.max(0, ret6h) / ret24h : 1;

  // Momentum quality: last 4 hourly candles
  const lastCandles = b.slice(-4).map(c => (c.close - c.open) / c.open);
  const posCandles  = lastCandles.filter(r => r > 0).length;
  const latestCandle = lastCandles[lastCandles.length - 1] || 0;

  return {
    bars:          b,
    currentPrice:  now,
    ret1h, ret6h, ret12h, ret24h, ret48h,
    moveFrac,
    posCandles,    // out of 4
    latestCandle,  // last hourly return
    transferStats: ts,
  };
}

module.exports = { getHourlyBars, getCurrentPrice, getTransferStats, getTokenSignal };
