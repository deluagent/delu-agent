#!/usr/bin/env node
/**
 * Data fetcher using CoinGecko CLI (cg)
 * - Full 365d daily history per token (cached, refreshed every 6h)
 * - Recent 7d hourly bars (refreshed every cycle)
 * - Trending tokens (refreshed every cycle)
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const CG       = `${process.env.HOME}/.local/bin/cg`;
const CACHE_DIR = path.join(__dirname, '../data/history');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// CoinGecko IDs for all tokens we track
const TOKEN_IDS = {
  // Majors
  ETH:     'ethereum',
  BTC:     'bitcoin',
  SOL:     'solana',
  BNB:     'binancecoin',
  ARB:     'arbitrum',
  OP:      'optimism',
  LINK:    'chainlink',
  AAVE:    'aave',
  // Base ecosystem
  VIRTUAL: 'virtual-protocol',
  BRETT:   'based-brett',
  DEGEN:   'degen-base',
  AERO:    'aerodrome-finance',
  CLANKER: 'clanker',
  // Smaller Base tokens (may not all be on CoinGecko)
  VIRTUAL2: 'virtual-protocol',
};

// Tokens that need GeckoTerminal fallback (not on CoinGecko free tier)
const GECKO_TERMINAL_FALLBACK = {
  ODAI:    { pool: '0xbf0f716999378af289863d0c7eb961793993a641a0a943ccc6bb45cb5713b3fb', network: 'base' },
  JUNO:    { pool: '0x1635213e2b19e459a4132df40011638b65ae7510a35d6a88c47ebf94912c7f2e', network: 'base' },
  FELIX:   { pool: '0x6e19027912db90892200a2b08c514921917bc55d7291ec878aa382c193b50084', network: 'base' },
  CLAWD:   { pool: '0xCD55381a53da35Ab1D7Bc5e3fE5F76cac976FAc3',                              network: 'base' },
  CLAWNCH: { pool: '0x07Da9c5d35028f578dFac5BE6e5Aaa8a835704F6',                              network: 'base' },
};

function cg(args, timeout = 15000) {
  try {
    const out = execSync(`${CG} ${args} -o json`, { timeout, stdio: ['pipe','pipe','pipe'] });
    return JSON.parse(out.toString().trim());
  } catch (e) {
    const msg = e.stderr?.toString() || e.message;
    // Parse rate limit retry time
    const retryMatch = msg.match(/retry after (\d+) seconds/i);
    throw Object.assign(new Error(`cg ${args}: ${msg.slice(0,100)}`), {
      rateLimited: msg.includes('rate_limit'),
      retryAfter: retryMatch ? parseInt(retryMatch[1]) : 0,
    });
  }
}

// Convert CoinGecko history response to bars array
function cgHistoryToBars(data, tf = '1d') {
  const prices  = data.prices  || [];
  const volumes = data.total_volumes || [];
  return prices.map(([ts, price], i) => ({
    ts, time: new Date(ts).toISOString(), tf,  // store as string for JSON safety
    open:   i > 0 ? prices[i-1][1] : price,
    high:   price,
    low:    price,
    close:  price,
    volume: volumes[i]?.[1] || 0,
  }));
}

// Parse bars from cache (time is string → Date)
function parseBars(bars) {
  return bars.map(b => ({ ...b, time: new Date(b.time) }));
}

// Fetch and cache 365d daily history for a token
function fetchDailyHistory(symbol, forceRefresh = false) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_daily.json`);
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  // Use cache if fresh enough
  if (!forceRefresh && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const age    = Date.now() - cached.fetchedAt;
    if (age < SIX_HOURS) return parseBars(cached.bars);
  }

  const id = TOKEN_IDS[symbol];
  if (!id) return null;

  const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to   = new Date().toISOString().slice(0, 10);

  try {
    const data = cg(`history ${id} --from ${from} --to ${to}`);
    if (data.error) throw new Error(data.message || data.error);
    const bars = cgHistoryToBars(data, '1d');
    if (bars.length === 0) throw new Error('empty history');
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), symbol, bars }, null, 2));
    return bars;
  } catch (e) {
    // If rate limited, return cached even if stale
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return parseBars(cached.bars);
    }
    throw e;
  }
}

// Fetch recent 7d hourly bars (for live signal)
function fetchRecentHourly(symbol) {
  const id = TOKEN_IDS[symbol];
  if (!id) return null;

  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to   = new Date().toISOString().slice(0, 10);

  const data = cg(`history ${id} --from ${from} --to ${to}`);
  if (data.error) throw new Error(data.message || data.error);
  return cgHistoryToBars(data, '1h');
}

// Get current prices for multiple tokens at once (1 API call)
function fetchCurrentPrices(symbols) {
  const ids = symbols.map(s => TOKEN_IDS[s]).filter(Boolean).join(',');
  if (!ids) return {};
  const data = cg(`price --ids ${ids}`);
  if (data.error) throw new Error(data.message || data.error);
  // Remap back to symbols
  const result = {};
  for (const symbol of symbols) {
    const id = TOKEN_IDS[symbol];
    if (id && data[id]) result[symbol] = data[id].usd;
  }
  return result;
}

// Get trending coins from CoinGecko
function fetchTrending() {
  const data = cg('trending');
  if (data.error) throw new Error(data.message || data.error);
  return (data.coins || []).map(c => ({
    symbol:  c.item?.symbol,
    name:    c.item?.name,
    id:      c.item?.id,
    rank:    c.item?.market_cap_rank,
    score:   c.item?.score,
  }));
}

// Fetch top gainers from markets
function fetchMarkets(limit = 250) {
  const data = cg(`markets --total ${limit}`);
  if (data.error) throw new Error(data.message || data.error);
  return (Array.isArray(data) ? data : []).map(c => ({
    symbol:       c.symbol?.toUpperCase(),
    id:           c.id,
    price:        c.current_price,
    change24h:    c.price_change_percentage_24h,
    volume24h:    c.total_volume,
    marketCap:    c.market_cap,
    rank:         c.market_cap_rank,
  }));
}

// Binance pairs for tokens available there (unlimited, no auth)
const BINANCE_PAIRS = {
  ETH: 'ETHUSDT', BTC: 'BTCUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT',
  ARB: 'ARBUSDT', OP: 'OPUSDT', LINK: 'LINKUSDT', AAVE: 'AAVEUSDT',
};

// Fetch full daily history via Binance (no rate limits, 1000 bars = ~2.7 years)
async function fetchBinanceHistory(symbol, days = 365) {
  const pair = BINANCE_PAIRS[symbol];
  if (!pair) return null;
  const cacheFile = path.join(CACHE_DIR, `${symbol}_binance.json`);
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - cached.fetchedAt < TWO_HOURS) return parseBars(cached.bars);
  }

  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${Math.min(days, 1000)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  const data = await r.json();
  const bars = data.map(k => ({
    ts: k[0], time: new Date(k[0]).toISOString(), tf: '1d',
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), symbol, bars }, null, 2));
  return parseBars(bars);
}

// Fetch recent hourly bars via Binance (no rate limits)
async function fetchBinanceHourly(symbol, hours = 168) {
  const pair = BINANCE_PAIRS[symbol];
  if (!pair) return null;
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=${Math.min(hours, 1000)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Binance hourly ${r.status}`);
  const data = await r.json();
  return data.map(k => ({
    ts: k[0], time: new Date(k[0]), tf: '1h',
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));
}

// GeckoTerminal fallback for tokens not on CoinGecko
async function fetchGeckoTerminal(symbol, days = 180) {
  const cfg = GECKO_TERMINAL_FALLBACK[symbol];
  if (!cfg) return null;
  const url = `https://api.geckoterminal.com/api/v2/networks/${cfg.network}/pools/${cfg.pool}/ohlcv/day?limit=${days}&token=base`;
  const r = await fetch(url, { headers: { Accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`GT ${r.status}`);
  const json = await r.json();
  const list = json?.data?.attributes?.ohlcv_list || [];
  if (list.length === 0) throw new Error('empty');
  return list.reverse().map(([ts, o, h, l, c, v]) => ({
    ts: ts * 1000, time: new Date(ts * 1000), tf: '1d',
    open: +o, high: +h, low: +l, close: +c, volume: +v
  }));
}

// Token contract addresses on Base for DexScreener lookup
const BASE_ADDRESSES = {
  // Base tokens
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
  BRETT:   '0x532f27101965dd16442E59d40670FaF5eBb142E4',
  DEGEN:   '0x4ed4E862860bed51a9570b96d89af5e1B0Efefed',
  AERO:    '0x940181a94A35A4569E4529A3CDfb74e38FD98631',
  CLANKER: '0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb',
  ODAI:    '0x0086cFF0c1E5D17b19F5bCd4c8840a5B4251D959',
  JUNO:    '0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07',
  FELIX:   '0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07',
  CLAWD:   '0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07',
  CLAWNCH: '0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be',
  // Majors (for DexScreener fallback)
  LINK:    '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196',  // LINK on Base
  AAVE:    '0x18c64B9F0a3dB32A6A2B15c6a88B9D4A4E5d79e5',  // AAVE on Base
};

/**
 * Fetch buy/sell flow data from DexScreener (free, no auth)
 * Returns flow signal: (buys - sells) / (buys + sells) → [-1, +1]
 */
async function fetchFlowSignal(symbol) {
  const addr = BASE_ADDRESSES[symbol];
  if (!addr) return null;

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`DexScreener ${r.status}`);
    const d = await r.json();
    const pairs = (d.pairs || []).filter(p => p.chainId === 'base');
    if (pairs.length === 0) return null;

    // Use highest-liquidity pair
    const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const txns = pair.txns || {};

    // Aggregate across time windows (weight recent more)
    const h1  = txns.h1  || {};
    const h6  = txns.h6  || {};
    const h24 = txns.h24 || {};

    const buys  = (h1.buys  || 0) * 3 + (h6.buys  || 0) * 2 + (h24.buys  || 0);
    const sells = (h1.sells || 0) * 3 + (h6.sells  || 0) * 2 + (h24.sells || 0);
    const total = buys + sells;

    const flowSignal = total > 0 ? (buys - sells) / total : 0;  // [-1, +1]
    const buyRatio   = total > 0 ? buys / total : 0.5;

    // Volume trend: h1 vol vs h24 vol / 24 (is volume accelerating?)
    const volH1  = pair.volume?.h1  || 0;
    const volH24 = pair.volume?.h24 || 0;
    const volAccel = volH24 > 0 ? (volH1 / (volH24 / 24)) - 1 : 0;  // > 0 = accelerating

    return {
      symbol,
      flowSignal:  +flowSignal.toFixed(4),   // core signal
      buyRatio:    +buyRatio.toFixed(4),
      buys24h:     h24.buys  || 0,
      sells24h:    h24.sells || 0,
      volAccel:    +volAccel.toFixed(4),     // volume acceleration
      vol24h:      volH24,
      liquidity:   pair.liquidity?.usd || 0,
      priceChange: {
        h1:  pair.priceChange?.h1  || 0,
        h6:  pair.priceChange?.h6  || 0,
        h24: pair.priceChange?.h24 || 0,
      },
    };
  } catch(e) {
    return null;
  }
}

/**
 * Batch fetch flow signals for multiple tokens
 * Respects DexScreener's rate limit with small delays
 */
async function fetchAllFlowSignals(symbols) {
  const results = {};
  for (const sym of symbols) {
    const signal = await fetchFlowSignal(sym);
    if (signal) results[sym] = signal;
    await new Promise(r => setTimeout(r, 300));  // 300ms between calls
  }
  return results;
}

module.exports = {
  TOKEN_IDS,
  BINANCE_PAIRS,
  GECKO_TERMINAL_FALLBACK,
  fetchDailyHistory,
  fetchRecentHourly,
  fetchCurrentPrices,
  fetchTrending,
  fetchMarkets,
  fetchBinanceHistory,
  fetchBinanceHourly,
  fetchGeckoTerminal,
  fetchFlowSignal,
  fetchAllFlowSignals,
  BASE_ADDRESSES,
};
