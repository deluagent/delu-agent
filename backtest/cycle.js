#!/usr/bin/env node
/**
 * delu 15-min learning cycle
 * Every 15 minutes:
 *   1. Fetch fresh OHLCV for key tokens
 *   2. Compute TA indicators (RSI, EMA, OBV, BBW, MACD)
 *   3. Detect signals + score patterns
 *   4. Ask Bankr for market context
 *   5. Log learnings to data/learnings.json
 *   6. Print what we learned and what we'd do
 *
 * No Checkr. No live trades. Pure learning.
 */

const fs = require('fs');
const path = require('path');

const LEARNINGS_FILE = path.join(__dirname, '../data/learnings.json');
const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── CoinGecko Data ───────────────────────────────────────────

const TOKENS = [
  // Binance (free, no auth) — major pairs
  { symbol: 'ETH',   source: 'binance', pair: 'ETHUSDT' },
  { symbol: 'BTC',   source: 'binance', pair: 'BTCUSDT' },
  // GeckoTerminal (free, no auth) — Base tokens by top pool address
  { symbol: 'BRETT', source: 'gecko',   pool: '0x4e92ff5fb4fba11f60ede7dcd15d2ad42be3c373', network: 'base' },
  { symbol: 'DEGEN', source: 'gecko',   pool: '0x2c4499335b8dc5cfba08a1dde92c7e31f58d1cf6', network: 'base' },
  { symbol: 'AERO',  source: 'gecko',   pool: '0x7902219e80510e2735a7d89e0b37a5d8a19c8ef6', network: 'base' },
];

// Binance: free, no API key, 1500 req/min limit
async function fetchBinance(pair, limit = 72) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const data = await res.json();
  return data.map(k => ({
    ts: k[0],
    time: new Date(k[0]),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5]
  }));
}

// GeckoTerminal: free, no API key, pool OHLCV
async function fetchGecko(network, pool, limit = 72) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/hour?limit=${limit}&token=base`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json;version=20230302' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
  const json = await res.json();
  const ohlcv = json?.data?.attributes?.ohlcv_list || [];
  return ohlcv.reverse().map(([ts, o, h, l, c, v]) => ({
    ts: ts * 1000,
    time: new Date(ts * 1000),
    open: +o, high: +h, low: +l, close: +c, volume: +v
  }));
}

async function fetchBars(token) {
  if (token.source === 'binance') return fetchBinance(token.pair, 72);
  if (token.source === 'gecko')   return fetchGecko(token.network, token.pool, 72);
  throw new Error(`Unknown source: ${token.source}`);
}

// ─── Indicators ───────────────────────────────────────────────

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return closes.map(() => null);
  const out = closes.map(() => null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= n; avgL /= n;
  out[n] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgG = (avgG * (n-1) + Math.max(d, 0)) / n;
    avgL = (avgL * (n-1) + Math.max(-d, 0)) / n;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function ema(closes, n) {
  const k = 2 / (n + 1);
  let prev = closes[0];
  return closes.map(c => { prev = c * k + prev * (1 - k); return prev; });
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const fastEMA = ema(closes, fast);
  const slowEMA = ema(closes, slow);
  const macdLine = fastEMA.map((v, i) => v - slowEMA[i]);
  const signalLine = ema(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function obv(closes, volumes) {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) out.push(out[i-1] + volumes[i]);
    else if (closes[i] < closes[i-1]) out.push(out[i-1] - volumes[i]);
    else out.push(out[i-1]);
  }
  return out;
}

function bbWidth(closes, n = 20) {
  return closes.map((_, i) => {
    if (i < n) return null;
    const sl = closes.slice(i - n, i);
    const mean = sl.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(sl.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    return (std * 4) / mean;
  });
}

// ─── Signal Scoring ───────────────────────────────────────────

function score(bars) {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const n = closes.length;
  const i = n - 1;

  const R = rsi(closes);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const { histogram } = macd(closes);
  const O = obv(closes, volumes);
  const BB = bbWidth(closes);

  const cur = {
    price:    closes[i],
    rsi:      R[i] != null ? +R[i].toFixed(1) : null,
    ema9:     +e9[i].toFixed(6),
    ema21:    +e21[i].toFixed(6),
    ema50:    +e50[i].toFixed(6),
    macdHist: +histogram[i].toFixed(6),
    obv:      O[i],
    bbw:      BB[i] != null ? +BB[i].toFixed(4) : null,
  };

  const signals = [];
  let bullPoints = 0, bearPoints = 0;

  // EMA stack
  if (cur.ema9 > cur.ema21 && cur.ema21 > cur.ema50) { signals.push('EMA_BULLISH_STACK'); bullPoints += 2; }
  if (cur.ema9 < cur.ema21 && cur.ema21 < cur.ema50) { signals.push('EMA_BEARISH_STACK'); bearPoints += 2; }

  // EMA 9/21 crossover (last 2 bars)
  if (i > 0 && e9[i-1] < e21[i-1] && e9[i] > e21[i]) { signals.push('EMA_9_21_BULLISH_CROSS'); bullPoints += 3; }
  if (i > 0 && e9[i-1] > e21[i-1] && e9[i] < e21[i]) { signals.push('EMA_9_21_BEARISH_CROSS'); bearPoints += 3; }

  // RSI
  if (cur.rsi != null) {
    if (cur.rsi < 35) { signals.push('RSI_OVERSOLD'); bullPoints += 2; }
    if (cur.rsi > 65) { signals.push('RSI_OVERBOUGHT'); bearPoints += 2; }
    if (cur.rsi > 50 && R[i-4] < 50) { signals.push('RSI_CROSSED_50_UP'); bullPoints += 1; }
    if (cur.rsi < 50 && R[i-4] > 50) { signals.push('RSI_CROSSED_50_DOWN'); bearPoints += 1; }
  }

  // RSI divergence (bullish: price lower, RSI higher)
  if (i >= 10 && cur.rsi != null && R[i-10] != null) {
    if (closes[i] < closes[i-10] && R[i] > R[i-10]) { signals.push('RSI_BULLISH_DIV'); bullPoints += 3; }
    if (closes[i] > closes[i-10] && R[i] < R[i-10]) { signals.push('RSI_BEARISH_DIV'); bearPoints += 3; }
  }

  // MACD histogram slope
  if (i > 0) {
    const histSlope = histogram[i] - histogram[i-1];
    if (histSlope > 0 && histogram[i] < 0) { signals.push('MACD_HIST_RISING_NEG'); bullPoints += 1; }
    if (histSlope > 0 && histogram[i] > 0) { signals.push('MACD_HIST_RISING_POS'); bullPoints += 2; }
    if (histSlope < 0 && histogram[i] > 0) { signals.push('MACD_HIST_FALLING_POS'); bearPoints += 1; }
  }

  // OBV divergence: price flat/down, OBV up = accumulation
  if (i >= 6) {
    const priceChg = (closes[i] - closes[i-6]) / closes[i-6];
    const obvChg = O[i-6] !== 0 ? (O[i] - O[i-6]) / Math.abs(O[i-6]) : 0;
    if (priceChg < 0.01 && obvChg > 0.05) { signals.push('OBV_ACCUMULATION'); bullPoints += 3; }
    if (priceChg > -0.01 && obvChg < -0.05) { signals.push('OBV_DISTRIBUTION'); bearPoints += 3; }
  }

  // BB squeeze (potential breakout)
  if (cur.bbw != null && i >= 20) {
    const bbSlice = BB.slice(i-20, i).filter(v => v != null);
    const p20 = [...bbSlice].sort((a,b) => a-b)[Math.floor(bbSlice.length * 0.2)];
    if (cur.bbw <= p20) { signals.push('BB_SQUEEZE'); bullPoints += 1; }
  }

  // Price above/below key EMAs
  if (closes[i] > cur.ema50) bullPoints += 1; else bearPoints += 1;

  const bias = bullPoints > bearPoints ? 'BULLISH'
             : bearPoints > bullPoints ? 'BEARISH'
             : 'NEUTRAL';
  const conviction = Math.abs(bullPoints - bearPoints);

  return { cur, signals, bullPoints, bearPoints, bias, conviction };
}

// ─── Bankr Market Context ─────────────────────────────────────

async function bankrContext() {
  const key = process.env.BANKR_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch('https://api.bankr.bot/agent/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ prompt: 'what are the top trending tokens and market sentiment on base right now? brief summary' }),
      signal: AbortSignal.timeout(8000)
    });
    const { jobId } = await resp.json();
    await new Promise(r => setTimeout(r, 12000));
    const poll = await fetch(`https://api.bankr.bot/agent/job/${jobId}`, {
      headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(8000)
    });
    const data = await poll.json();
    return data.response || null;
  } catch (e) {
    return null;
  }
}

// ─── Learning Log ─────────────────────────────────────────────

function loadLearnings() {
  if (!fs.existsSync(LEARNINGS_FILE)) return { cycles: [], patterns: {}, stats: {} };
  return JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'));
}

function saveLearning(entry) {
  const db = loadLearnings();
  db.cycles.push(entry);
  // keep last 200 cycles
  if (db.cycles.length > 200) db.cycles = db.cycles.slice(-200);

  // update pattern frequency
  for (const sig of entry.signals || []) {
    if (!db.patterns[sig]) db.patterns[sig] = { count: 0, bullish: 0, bearish: 0, neutral: 0 };
    db.patterns[sig].count++;
    db.patterns[sig][entry.bias?.toLowerCase() || 'neutral']++;
  }

  // token stats
  const t = entry.token;
  if (!db.stats[t]) db.stats[t] = { cycles: 0, bullish: 0, bearish: 0, neutral: 0, avgConviction: 0 };
  db.stats[t].cycles++;
  db.stats[t][entry.bias?.toLowerCase() || 'neutral']++;
  db.stats[t].avgConviction = (
    (db.stats[t].avgConviction * (db.stats[t].cycles - 1) + entry.conviction) / db.stats[t].cycles
  );

  fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(db, null, 2));
  return db;
}

// ─── Cycle ───────────────────────────────────────────────────

async function runCycle() {
  const ts = new Date().toISOString();
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`[cycle] ${ts}`);
  console.log(`${'─'.repeat(52)}`);

  const results = [];

  for (let t = 0; t < TOKENS.length; t++) {
    const token = TOKENS[t];
    if (t > 0) await new Promise(r => setTimeout(r, 7000)); // CoinGecko rate limit

    let bars;
    try {
      bars = await fetchBars(token); // 72 hourly bars
    } catch (e) {
      console.warn(`[${token.symbol}] fetch failed: ${e.message}`);
      continue;
    }

    if (bars.length < 30) { console.warn(`[${token.symbol}] too few bars`); continue; }

    const { cur, signals, bullPoints, bearPoints, bias, conviction } = score(bars);

    // 1h and 24h price change
    const p1h = bars.length >= 2 ? ((bars.at(-1).close - bars.at(-2).close) / bars.at(-2).close * 100).toFixed(2) : null;
    const p24h = bars.length >= 25 ? ((bars.at(-1).close - bars.at(-25).close) / bars.at(-25).close * 100).toFixed(2) : null;

    const entry = {
      timestamp: ts,
      token: token.symbol,
      price: cur.price,
      p1h: p1h ? +p1h : null,
      p24h: p24h ? +p24h : null,
      rsi: cur.rsi,
      macdHist: cur.macdHist,
      bbw: cur.bbw,
      signals,
      bullPoints,
      bearPoints,
      bias,
      conviction,
    };

    const db = saveLearning(entry);
    results.push({ token: token.symbol, entry, db });

    // Print signal summary
    const tag = bias === 'BULLISH' ? '🟢' : bias === 'BEARISH' ? '🔴' : '⚪';
    console.log(`${tag} ${token.symbol.padEnd(6)} $${cur.price.toFixed(4).padStart(12)} | RSI=${cur.rsi?.toFixed(0).padStart(3) ?? '---'} | 1h=${p1h?.padStart(6) ?? '-----'}% | 24h=${p24h?.padStart(6) ?? '-----'}% | ${bias}(${conviction}) | ${signals.slice(0,3).join(', ')}`);
  }

  // Pattern insights every 10 cycles
  const db = loadLearnings();
  if (db.cycles.length % 10 === 0 && db.cycles.length > 0) {
    console.log('\n📊 PATTERN INSIGHTS (top signals by frequency):');
    const sorted = Object.entries(db.patterns)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8);
    for (const [sig, data] of sorted) {
      const bullPct = Math.round(data.bullish / data.count * 100);
      console.log(`  ${sig.padEnd(28)} count=${data.count} bullish_pct=${bullPct}%`);
    }

    // Token biases
    console.log('\n📊 TOKEN BIAS SUMMARY:');
    for (const [tok, s] of Object.entries(db.stats)) {
      const bullPct = Math.round(s.bullish / s.cycles * 100);
      console.log(`  ${tok.padEnd(8)} cycles=${s.cycles} bullish=${bullPct}% avgConviction=${s.avgConviction.toFixed(1)}`);
    }
  }

  // Bankr context every 4 cycles (~1h)
  if (db.cycles.length % 4 === 0) {
    console.log('\n🏦 Bankr market context...');
    const ctx = await bankrContext();
    if (ctx) {
      console.log(ctx.slice(0, 400));
      // append to learnings
      db.bankr_snapshots = db.bankr_snapshots || [];
      db.bankr_snapshots.push({ timestamp: ts, context: ctx });
      if (db.bankr_snapshots.length > 50) db.bankr_snapshots = db.bankr_snapshots.slice(-50);
      fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(db, null, 2));
    } else {
      console.log('  (unavailable)');
    }
  }

  console.log(`\n[cycle] done — total cycles: ${db.cycles.length} | watching: ${TOKENS.map(t => t.symbol).join(', ')}`);
}

// ─── Entry ────────────────────────────────────────────────────

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

console.log('═'.repeat(52));
console.log('delu learning cycle — every 15 min');
console.log(`Tokens: ${TOKENS.map(t => t.symbol).join(', ')}`);
console.log(`Indicators: RSI(14), EMA(9/21/50), MACD(12/26/9), OBV, BBW(20)`);
console.log(`Bankr context: every ~1h`);
console.log('═'.repeat(52));

runCycle().catch(console.error);
setInterval(() => runCycle().catch(console.error), INTERVAL_MS);
