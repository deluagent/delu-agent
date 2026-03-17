#!/usr/bin/env node
/**
 * delu 15-min learning + execution cycle
 *
 * Every 15 min:
 *   1. Fetch OHLCV for all tokens (Binance majors + GeckoTerminal Base tokens)
 *   2. Compute full TA: RSI, EMA(9/21/50), MACD, OBV, BBW, VWAP
 *   3. Score signals, detect patterns
 *   4. Log learnings
 *   5. If high-conviction signal on a major → execute via Bankr (small size)
 *   6. Every ~1h: ask Bankr for market context
 *
 * No Checkr. Price + volume only.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');

const DATA_DIR       = path.join(__dirname, '../data');
const LEARNINGS_FILE = path.join(DATA_DIR, 'learnings.json');
const TRADES_FILE    = path.join(DATA_DIR, 'cycle_trades.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Token List ───────────────────────────────────────────────
// Binance: majors (free, no auth, unlimited)
// GeckoTerminal: Base tokens by highest-vol pair address

const TOKENS = [
  // ── MAJORS (Binance) ──
  { symbol: 'ETH',     source: 'binance', pair: 'ETHUSDT',  limit: 168 }, // 7d hourly
  { symbol: 'BTC',     source: 'binance', pair: 'BTCUSDT',  limit: 168 },
  { symbol: 'SOL',     source: 'binance', pair: 'SOLUSDT',  limit: 168 },
  { symbol: 'BNB',     source: 'binance', pair: 'BNBUSDT',  limit: 72  },
  { symbol: 'ARB',     source: 'binance', pair: 'ARBUSDT',  limit: 72  },
  { symbol: 'OP',      source: 'binance', pair: 'OPUSDT',   limit: 72  },
  { symbol: 'LINK',    source: 'binance', pair: 'LINKUSDT', limit: 72  },
  { symbol: 'AAVE',    source: 'binance', pair: 'AAVEUSDT', limit: 72  },

  // ── BASE TOKENS (GeckoTerminal) ──
  { symbol: 'VIRTUAL', source: 'gecko', pool: '0x3f0296BF652e19bca772EC3dF08b32732F93014A', network: 'base', limit: 72 },
  { symbol: 'CLANKER', source: 'gecko', pool: '0xd23FE2DB317e1A96454a2D1c7e8fc0DbF19BB000', network: 'base', limit: 72 },
  { symbol: 'ODAI',    source: 'gecko', pool: '0xbf0f716999378af289863d0c7eb961793993a641a0a943ccc6bb45cb5713b3fb', network: 'base', limit: 72 },
  { symbol: 'JUNO',    source: 'gecko', pool: '0x1635213e2b19e459a4132df40011638b65ae7510a35d6a88c47ebf94912c7f2e', network: 'base', limit: 72 },
  { symbol: 'FELIX',   source: 'gecko', pool: '0x6e19027912db90892200a2b08c514921917bc55d7291ec878aa382c193b50084', network: 'base', limit: 72 },
  { symbol: 'CLAWD',   source: 'gecko', pool: '0xCD55381a53da35Ab1D7Bc5e3fE5F76cac976FAc3',                              network: 'base', limit: 72 },
  { symbol: 'CLAWNCH', source: 'gecko', pool: '0x07Da9c5d35028f578dFac5BE6e5Aaa8a835704F6',                              network: 'base', limit: 72 },
  { symbol: 'BRETT',   source: 'gecko', pool: '0x4e92ff5fb4fba11f60ede7dcd15d2ad42be3c373',                              network: 'base', limit: 72 },
  { symbol: 'DEGEN',   source: 'gecko', pool: '0x2c4499335b8dc5cfba08a1dde92c7e31f58d1cf6',                              network: 'base', limit: 72 },
  { symbol: 'AERO',    source: 'gecko', pool: '0x7902219e80510e2735a7d89e0b37a5d8a19c8ef6',                              network: 'base', limit: 72 },
];

// Majors we can actually trade via Bankr (small size)
const TRADEABLE = new Set(['ETH', 'BTC', 'SOL', 'AAVE', 'LINK', 'VIRTUAL', 'AERO', 'BRETT', 'DEGEN']);

// ─── Data Sources ─────────────────────────────────────────────

// Fetch daily bars (for historical pattern analysis, up to 365 days)
async function fetchBinanceDaily(pair, days = 365) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${Math.min(days, 1000)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Binance daily ${r.status}`);
  const d = await r.json();
  return d.map(k => ({
    ts: k[0], time: new Date(k[0]), tf: '1d',
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));
}

// Fetch hourly bars (for recent signal confirmation, last 7 days)
async function fetchBinanceHourly(pair, hours = 168) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=${Math.min(hours, 1000)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Binance hourly ${r.status}`);
  const d = await r.json();
  return d.map(k => ({
    ts: k[0], time: new Date(k[0]), tf: '1h',
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));
}

// GeckoTerminal daily (up to 180 days for Base tokens)
async function fetchGeckoDaily(network, pool, days = 180) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/day?limit=${Math.min(days, 180)}&token=base`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json;version=20230302' },
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error(`GeckoTerminal ${r.status}`);
  const json = await r.json();
  const list = json?.data?.attributes?.ohlcv_list || [];
  if (list.length === 0) throw new Error('empty ohlcv');
  return list.reverse().map(([ts, o, h, l, c, v]) => ({
    ts: ts * 1000, time: new Date(ts * 1000), tf: '1d',
    open: +o, high: +h, low: +l, close: +c, volume: +v
  }));
}

// GeckoTerminal hourly (last 7 days for recent signal)
async function fetchGeckoHourly(network, pool, hours = 168) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/hour?limit=${Math.min(hours, 1000)}&token=base`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json;version=20230302' },
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error(`GeckoTerminal hourly ${r.status}`);
  const json = await r.json();
  const list = json?.data?.attributes?.ohlcv_list || [];
  if (list.length === 0) throw new Error('empty ohlcv (hourly)');
  return list.reverse().map(([ts, o, h, l, c, v]) => ({
    ts: ts * 1000, time: new Date(ts * 1000), tf: '1h',
    open: +o, high: +h, low: +l, close: +c, volume: +v
  }));
}

// Returns { daily, hourly } — daily for pattern analysis, hourly for live signal
async function fetchBars(token) {
  if (token.source === 'binance') {
    const [daily, hourly] = await Promise.all([
      fetchBinanceDaily(token.pair, 365),
      fetchBinanceHourly(token.pair, 168),
    ]);
    return { daily, hourly };
  }
  if (token.source === 'gecko') {
    const daily  = await fetchGeckoDaily(token.network, token.pool, 180);
    await new Promise(r => setTimeout(r, 1500));
    const hourly = await fetchGeckoHourly(token.network, token.pool, 168);
    return { daily, hourly };
  }
  throw new Error('unknown source');
}

// ─── Technical Indicators ─────────────────────────────────────

function calcRSI(closes, n = 14) {
  const out = closes.map(() => null);
  if (closes.length < n + 1) return out;
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

function calcEMA(closes, n) {
  const k = 2 / (n + 1);
  let prev = closes[0];
  return closes.map(c => { prev = c * k + prev * (1 - k); return prev; });
}

function calcMACD(closes, fast = 12, slow = 26, sig = 9) {
  const eFast = calcEMA(closes, fast);
  const eSlow = calcEMA(closes, slow);
  const line   = eFast.map((v, i) => v - eSlow[i]);
  const signal = calcEMA(line, sig);
  const hist   = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function calcOBV(closes, volumes) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    obv.push(closes[i] > closes[i-1] ? obv[i-1] + volumes[i]
           : closes[i] < closes[i-1] ? obv[i-1] - volumes[i]
           : obv[i-1]);
  }
  return obv;
}

function calcBBW(closes, n = 20) {
  return closes.map((_, i) => {
    if (i < n) return null;
    const sl   = closes.slice(i - n, i);
    const mean = sl.reduce((a, b) => a + b) / n;
    const std  = Math.sqrt(sl.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    return (std * 4) / mean;
  });
}

function calcVWAP(bars) {
  // Session VWAP (running, last 24 bars)
  const n = Math.min(24, bars.length);
  const slice = bars.slice(-n);
  const totalVol = slice.reduce((s, b) => s + b.volume, 0);
  if (totalVol === 0) return bars.at(-1).close;
  return slice.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0) / totalVol;
}

// ─── Historical Backtest (daily bars) ────────────────────────

function backtest(daily, symbol) {
  const closes  = daily.map(b => b.close);
  const volumes = daily.map(b => b.volume);
  const RSI  = calcRSI(closes);
  const e9   = calcEMA(closes, 9);
  const e21  = calcEMA(closes, 21);
  const { hist } = calcMACD(closes);
  const OBV  = calcOBV(closes, volumes);

  const trades = [];
  let position = null;

  for (let i = 30; i < closes.length; i++) {
    let entryScore = 0;
    // Entry conditions
    if (e9[i-1] < e21[i-1] && e9[i] >= e21[i]) entryScore += 3;       // EMA cross
    if (RSI[i] != null && RSI[i] < 40) entryScore += 2;                // oversold
    if (i >= 8 && OBV[i] > OBV[i-8] && closes[i] <= closes[i-8] * 1.01) entryScore += 3; // OBV accum
    if (i >= 10 && closes[i] < closes[i-10] && RSI[i] > RSI[i-10] && RSI[i] != null) entryScore += 2; // RSI bull div

    // Exit conditions
    let exitScore = 0;
    if (e9[i-1] > e21[i-1] && e9[i] <= e21[i]) exitScore += 3;        // EMA death cross
    if (RSI[i] != null && RSI[i] > 70) exitScore += 2;                 // overbought
    if (hist[i] < 0 && hist[i-1] >= 0) exitScore += 2;                // MACD cross down

    if (!position && entryScore >= 4) {
      position = { entry: closes[i], entryIdx: i, entryDate: daily[i].time };
    } else if (position && (exitScore >= 3 || i === closes.length - 1)) {
      const ret = (closes[i] - position.entry) / position.entry * 100;
      const holdDays = i - position.entryIdx;
      trades.push({
        entryDate: position.entryDate.toISOString().slice(0, 10),
        exitDate:  daily[i].time.toISOString().slice(0, 10),
        entryPrice: +position.entry.toPrecision(6),
        exitPrice:  +closes[i].toPrecision(6),
        returnPct:  +ret.toFixed(2),
        holdDays,
        win: ret > 0,
      });
      position = null;
    }
  }

  if (trades.length === 0) return null;
  const wins    = trades.filter(t => t.win);
  const avgRet  = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;
  const totalRet = trades.reduce((s, t) => s + t.returnPct, 0);
  const winRate = Math.round(wins.length / trades.length * 100);
  const avgHold = Math.round(trades.reduce((s, t) => s + t.holdDays, 0) / trades.length);
  const returns = trades.map(t => t.returnPct / 100);
  const mean    = returns.reduce((a, b) => a + b) / returns.length;
  const std     = Math.sqrt(returns.reduce((s, r) => s + (r-mean)**2, 0) / returns.length);
  const sharpe  = std > 0 ? +(mean / std * Math.sqrt(252)).toFixed(2) : null;

  return {
    trades: trades.slice(-5), // last 5 only for log
    totalTrades: trades.length,
    winRate,
    avgRetPct:  +avgRet.toFixed(2),
    totalRetPct: +totalRet.toFixed(2),
    avgHoldDays: avgHold,
    sharpe,
    bestTrade:  trades.reduce((a, b) => b.returnPct > a.returnPct ? b : a),
    worstTrade: trades.reduce((a, b) => b.returnPct < a.returnPct ? b : a),
    dataFrom:   daily[0].time.toISOString().slice(0, 10),
    dataTo:     daily.at(-1).time.toISOString().slice(0, 10),
    days:       daily.length,
  };
}

// ─── Signal Scoring ───────────────────────────────────────────

function scoreToken(bars) {
  // Use hourly bars for live signal; daily for HTF context
  const hourly  = bars.hourly || bars;
  const daily   = bars.daily  || bars;
  const closes  = hourly.map(b => b.close);
  const volumes = hourly.map(b => b.volume);
  const dCloses = daily.map(b => b.close);
  const i = closes.length - 1;

  const RSI  = calcRSI(closes);
  const e9   = calcEMA(closes, 9);
  const e21  = calcEMA(closes, 21);
  const e50  = calcEMA(closes, 50);
  const { hist } = calcMACD(closes);
  const OBV  = calcOBV(closes, volumes);
  const BBW  = calcBBW(closes);
  const vwap = calcVWAP(hourly);

  // Daily HTF bias (trend direction from monthly view)
  const dRSI = calcRSI(dCloses);
  const de21 = calcEMA(dCloses, 21);
  const de50 = calcEMA(dCloses, 50);
  const di   = dCloses.length - 1;
  const htfBull = di > 0 && de21[di] > de50[di] && dRSI[di] > 50;
  const htfBear = di > 0 && de21[di] < de50[di] && dRSI[di] < 50;

  const cur = {
    price: closes[i],
    rsi:   RSI[i]  != null ? +RSI[i].toFixed(1)  : null,
    ema9:  +e9[i].toFixed(8),
    ema21: +e21[i].toFixed(8),
    ema50: +e50[i].toFixed(8),
    macdH: +hist[i].toFixed(8),
    obv:   OBV[i],
    bbw:   BBW[i] != null ? +BBW[i].toFixed(4) : null,
    vwap:  +vwap.toFixed(8),
  };

  const signals = [];
  let bull = 0, bear = 0;

  // ── EMA stack ──
  if (cur.ema9 > cur.ema21 && cur.ema21 > cur.ema50) { signals.push('EMA_BULL_STACK'); bull += 2; }
  if (cur.ema9 < cur.ema21 && cur.ema21 < cur.ema50) { signals.push('EMA_BEAR_STACK'); bear += 2; }

  // ── EMA 9/21 cross (last 2 bars) ──
  if (i > 0) {
    if (e9[i-1] < e21[i-1] && e9[i] >= e21[i]) { signals.push('EMA_9_21_BULL_CROSS'); bull += 3; }
    if (e9[i-1] > e21[i-1] && e9[i] <= e21[i]) { signals.push('EMA_9_21_BEAR_CROSS'); bear += 3; }
  }

  // ── RSI ──
  if (cur.rsi != null) {
    if (cur.rsi < 30) { signals.push('RSI_OVERSOLD_EXTREME'); bull += 4; }
    else if (cur.rsi < 40) { signals.push('RSI_OVERSOLD');    bull += 2; }
    if (cur.rsi > 70) { signals.push('RSI_OVERBOUGHT_EXTREME'); bear += 4; }
    else if (cur.rsi > 65) { signals.push('RSI_OVERBOUGHT');  bear += 2; }
    // RSI 50 cross
    if (i >= 4 && RSI[i-4] != null) {
      if (cur.rsi >= 50 && RSI[i-4] < 50) { signals.push('RSI_50_BULL'); bull += 1; }
      if (cur.rsi < 50  && RSI[i-4] >= 50) { signals.push('RSI_50_BEAR'); bear += 1; }
    }
  }

  // ── RSI divergence ──
  if (i >= 12 && cur.rsi != null && RSI[i-12] != null) {
    if (closes[i] < closes[i-12] && cur.rsi > RSI[i-12]) { signals.push('RSI_BULL_DIV'); bull += 4; }
    if (closes[i] > closes[i-12] && cur.rsi < RSI[i-12]) { signals.push('RSI_BEAR_DIV'); bear += 4; }
  }

  // ── MACD histogram ──
  if (i > 1) {
    const slope = hist[i] - hist[i-1];
    const slope2 = hist[i-1] - hist[i-2];
    if (slope > 0 && hist[i] < 0) { signals.push('MACD_HIST_BULL_TURN'); bull += 2; }
    if (slope > 0 && hist[i] > 0) { signals.push('MACD_HIST_BULL_STRONG'); bull += 2; }
    if (slope < 0 && hist[i] > 0) { signals.push('MACD_HIST_BEAR_TURN'); bear += 2; }
    if (slope < 0 && hist[i] < 0) { signals.push('MACD_HIST_BEAR_STRONG'); bear += 2; }
    // Acceleration (slope of slope)
    if (slope > 0 && slope2 > 0) { signals.push('MACD_ACCELERATING'); bull += 1; }
  }

  // ── OBV divergence ──
  if (i >= 8) {
    const priceChg  = (closes[i] - closes[i-8]) / closes[i-8];
    const obvChg    = OBV[i-8] !== 0 ? (OBV[i] - OBV[i-8]) / Math.abs(OBV[i-8]) : 0;
    if (priceChg <= 0.005 && obvChg > 0.03)  { signals.push('OBV_ACCUMULATION'); bull += 4; }
    if (priceChg >= -0.005 && obvChg < -0.03) { signals.push('OBV_DISTRIBUTION'); bear += 4; }
    // Classic divergence: price new high, OBV not
    if (closes[i] > Math.max(...closes.slice(i-8, i)) && OBV[i] < Math.max(...OBV.slice(i-8, i))) {
      signals.push('OBV_BEAR_DIV'); bear += 3;
    }
    if (closes[i] < Math.min(...closes.slice(i-8, i)) && OBV[i] > Math.min(...OBV.slice(i-8, i))) {
      signals.push('OBV_BULL_DIV'); bull += 3;
    }
  }

  // ── Bollinger Band squeeze ──
  if (cur.bbw != null && i >= 30) {
    const hist30 = BBW.slice(i-30, i).filter(v => v != null).sort((a,b) => a-b);
    if (hist30.length > 10) {
      const p20 = hist30[Math.floor(hist30.length * 0.2)];
      if (cur.bbw <= p20) { signals.push('BB_SQUEEZE'); bull += 1; } // neutral breakout warning
    }
  }

  // ── HTF alignment (daily trend agrees with hourly signal) ──
  if (htfBull) { signals.push('HTF_BULL'); bull += 2; }
  if (htfBear) { signals.push('HTF_BEAR'); bear += 2; }

  // ── VWAP ──
  if (closes[i] > cur.vwap * 1.005) { signals.push('ABOVE_VWAP'); bull += 1; }
  if (closes[i] < cur.vwap * 0.995) { signals.push('BELOW_VWAP'); bear += 1; }

  // ── Volume spike ──
  if (i >= 12) {
    const avgVol = volumes.slice(i-12, i).reduce((a,b)=>a+b,0) / 12;
    if (volumes[i] > avgVol * 2.5)  { signals.push('VOLUME_SPIKE'); bull += 2; } // direction-agnostic, watch
    if (volumes[i] > avgVol * 1.5)  { signals.push('VOLUME_HIGH'); bull += 1; }
    if (volumes[i] < avgVol * 0.4)  { signals.push('VOLUME_DRY'); bear += 1; }
  }

  // 24h and 1h price change
  const p1h  = i >= 1  ? (closes[i] - closes[i-1])  / closes[i-1]  * 100 : 0;
  const p24h = i >= 24 ? (closes[i] - closes[i-24]) / closes[i-24] * 100 : 0;
  const p7d  = i >= 168 ? (closes[i] - closes[i-168]) / closes[i-168] * 100 : null;

  const bias       = bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'NEUTRAL';
  const conviction = Math.abs(bull - bear);

  return { cur, signals, bull, bear, bias, conviction, p1h, p24h, p7d };
}

// ─── Learning Persistence ─────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(LEARNINGS_FILE)) return { cycles: 0, snapshots: [], patterns: {}, tokens: {}, bankr: [] };
  const db = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'));
  // ensure all arrays exist (migration safety)
  if (!db.snapshots) db.snapshots = [];
  if (!db.patterns)  db.patterns  = {};
  if (!db.tokens)    db.tokens    = {};
  if (!db.bankr)     db.bankr     = [];
  return db;
}

function saveDB(db) {
  fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(db, null, 2));
}

function record(db, ts, token, score) {
  const snap = {
    ts, token,
    price:      score.cur.price,
    p1h:        +score.p1h.toFixed(2),
    p24h:       +score.p24h.toFixed(2),
    rsi:        score.cur.rsi,
    macdH:      score.cur.macdH,
    bbw:        score.cur.bbw,
    vwap:       score.cur.vwap,
    signals:    score.signals,
    bull:       score.bull,
    bear:       score.bear,
    bias:       score.bias,
    conviction: score.conviction,
  };
  db.snapshots.push(snap);
  if (db.snapshots.length > 5000) db.snapshots = db.snapshots.slice(-5000);

  // pattern stats
  for (const s of score.signals) {
    if (!db.patterns[s]) db.patterns[s] = { count: 0, bull: 0, bear: 0, neutral: 0 };
    db.patterns[s].count++;
    db.patterns[s][score.bias.toLowerCase()]++;
  }

  // token stats
  if (!db.tokens[token]) db.tokens[token] = { count: 0, bull: 0, bear: 0, neutral: 0, sumConviction: 0 };
  const t = db.tokens[token];
  t.count++; t[score.bias.toLowerCase()]++; t.sumConviction += score.conviction;
}

// ─── Bankr Context ────────────────────────────────────────────

async function askBankr(prompt) {
  const key = process.env.BANKR_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.bankr.bot/agent/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(8000)
    });
    const { jobId } = await r.json();
    await new Promise(res => setTimeout(res, 14000));
    const poll = await fetch(`https://api.bankr.bot/agent/job/${jobId}`, {
      headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(8000)
    });
    const d = await poll.json();
    return d.response || null;
  } catch { return null; }
}

// ─── Trade Execution ──────────────────────────────────────────

async function loadTrades() {
  if (!fs.existsSync(TRADES_FILE)) return [];
  return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
}

async function saveTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

// Execute a small trade via Bankr when signals are very strong
async function maybeTrade(token, sc, cycleNum) {
  if (!TRADEABLE.has(token)) return null;
  if (sc.conviction < 8) return null;  // only very high conviction

  // Don't over-trade — check if we already have an open position
  const trades = await loadTrades();
  const open = trades.find(t => t.token === token && !t.closed);
  if (open) return null; // already in position

  // Max $2 per trade during training
  const SIZE_USD = 2;
  let prompt;

  if (sc.bias === 'BULLISH') {
    prompt = `swap $${SIZE_USD} USDC to ${token} on base`;
  } else if (sc.bias === 'BEARISH' && (token === 'ETH' || token === 'BTC')) {
    // Only short majors via leverage (never memecoins)
    return null; // skip shorts during training phase
  } else {
    return null;
  }

  console.log(`\n💸 [trade] HIGH CONVICTION ${sc.bias} on ${token} (conviction=${sc.conviction}) — executing $${SIZE_USD} trade`);
  console.log(`   Signals: ${sc.signals.join(', ')}`);

  const resp = await askBankr(prompt);
  if (!resp) { console.log('   Bankr unavailable'); return null; }

  console.log(`   Bankr: ${resp.slice(0, 200)}`);

  const trade = {
    id:         Date.now(),
    token,
    action:     'BUY',
    sizeUsd:    SIZE_USD,
    entryPrice: sc.cur.price,
    entryTs:    new Date().toISOString(),
    signals:    sc.signals,
    conviction: sc.conviction,
    bankrResp:  resp.slice(0, 200),
    closed:     false,
    exitPrice:  null, exitTs: null, pnl: null,
  };
  trades.push(trade);
  await saveTrades(trades);
  return trade;
}

// ─── Pattern Insights ─────────────────────────────────────────

function printInsights(db) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  LEARNING SNAPSHOT — pattern insights        ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Top signals by frequency
  const topSignals = Object.entries(db.patterns)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  console.log('\nTop signals (by frequency):');
  for (const [sig, d] of topSignals) {
    const bullPct = Math.round(d.bull / d.count * 100);
    const bar = '█'.repeat(Math.round(bullPct / 10));
    console.log(`  ${sig.padEnd(26)} n=${String(d.count).padStart(4)} bullish=${bullPct}% ${bar}`);
  }

  // Token overview
  console.log('\nToken bias overview:');
  for (const [tok, d] of Object.entries(db.tokens).sort((a, b) => b[1].sumConviction - a[1].sumConviction)) {
    const bullPct = Math.round(d.bull / d.count * 100);
    const avgConv = (d.sumConviction / d.count).toFixed(1);
    console.log(`  ${tok.padEnd(8)} n=${String(d.count).padStart(3)} bullish=${String(bullPct).padStart(3)}% avgConv=${avgConv}`);
  }
}

// ─── Main Cycle ───────────────────────────────────────────────

async function runCycle(cycleNum) {
  const ts = new Date().toISOString();
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`[cycle #${cycleNum}] ${ts}`);
  console.log(`${'─'.repeat(62)}`);

  const db = loadDB();
  db.cycles = cycleNum;

  const scores = [];

  // Fetch in parallel batches — Binance unlimited, GeckoTerminal ~30 req/min
  const binanceTokens = TOKENS.filter(t => t.source === 'binance');
  const geckoTokens   = TOKENS.filter(t => t.source === 'gecko');

  // Binance: parallel fetch (unlimited, safe)
  const binanceBars = await Promise.allSettled(binanceTokens.map(t => fetchBars(t)));
  for (let j = 0; j < binanceTokens.length; j++) {
    const token = binanceTokens[j];
    const result = binanceBars[j];
    if (result.status === 'rejected') { console.warn(`[${token.symbol}] ${result.reason.message}`); continue; }
    const { daily, hourly } = result.value;
    if (hourly.length < 30) { console.warn(`[${token.symbol}] only ${hourly.length} hourly bars`); continue; }
    const sc   = scoreToken({ daily, hourly });
    const hist = daily.length >= 30 ? backtest(daily, token.symbol) : null;
    record(db, ts, token.symbol, sc);
    scores.push({ token: token.symbol, sc, hist });
    if (hist) {
      console.log(`  📊 ${token.symbol} backtest (${hist.days}d): ${hist.totalTrades} trades | WR=${hist.winRate}% | ret=${hist.totalRetPct}% | sharpe=${hist.sharpe}`);
    }
  }

  // GeckoTerminal: sequential with delay (avoid 429)
  for (const token of geckoTokens) {
    await new Promise(r => setTimeout(r, 3500));
    let daily, hourly;
    try {
      const bars = await fetchBars(token);
      daily = bars.daily; hourly = bars.hourly;
    } catch (e) { console.warn(`[${token.symbol}] ${e.message}`); continue; }
    if (hourly.length < 10) { console.warn(`[${token.symbol}] only ${hourly.length} bars`); continue; }
    const sc   = scoreToken({ daily, hourly });
    const hist = daily.length >= 20 ? backtest(daily, token.symbol) : null;
    record(db, ts, token.symbol, sc);
    scores.push({ token: token.symbol, sc, hist });
    if (hist) {
      console.log(`  📊 ${token.symbol} backtest (${hist.days}d): ${hist.totalTrades} trades | WR=${hist.winRate}% | ret=${hist.totalRetPct}% | sharpe=${hist.sharpe}`);
    }
  }

  // Print signal table
  console.log('\n Token    │  Price         │ RSI  │  1h%   │ 24h%   │ Bias           │ Top signals');
  console.log(' ─────────┼────────────────┼──────┼────────┼────────┼────────────────┼──────────────────────');
  for (const { token, sc } of scores) {
    const tag  = sc.bias === 'BULLISH' ? '🟢' : sc.bias === 'BEARISH' ? '🔴' : '⚪';
    const rsi  = sc.cur.rsi != null ? sc.cur.rsi.toFixed(0).padStart(4) : ' ---';
    const p1h  = (sc.p1h >= 0 ? '+' : '') + sc.p1h.toFixed(1) + '%';
    const p24h = (sc.p24h >= 0 ? '+' : '') + sc.p24h.toFixed(1) + '%';
    const bias = `${tag}${sc.bias}(${sc.conviction})`;
    const sigs = sc.signals.slice(0, 2).join(', ');
    const price = ('$' + sc.cur.price.toPrecision(5)).padStart(14);
    console.log(` ${token.padEnd(8)} │${price} │${rsi} │${p1h.padStart(6)} │${p24h.padStart(6)} │ ${bias.padEnd(14)} │ ${sigs}`);
  }

  // High-conviction alerts
  const hotBull = scores.filter(s => s.sc.bias === 'BULLISH' && s.sc.conviction >= 6).sort((a,b) => b.sc.conviction - a.sc.conviction);
  const hotBear = scores.filter(s => s.sc.bias === 'BEARISH' && s.sc.conviction >= 6).sort((a,b) => b.sc.conviction - a.sc.conviction);
  if (hotBull.length) console.log(`\n🔥 HIGH CONVICTION BULLISH: ${hotBull.map(s => `${s.token}(${s.sc.conviction})`).join(', ')}`);
  if (hotBear.length) console.log(`🔥 HIGH CONVICTION BEARISH: ${hotBear.map(s => `${s.token}(${s.sc.conviction})`).join(', ')}`);

  // Trade execution for very high conviction (>= 8) AND HTF aligned
  for (const { token, sc } of scores) {
    const htfOk = sc.signals.includes('HTF_BULL') || TOKENS.find(t => t.symbol === token)?.source === 'gecko';
    if (sc.conviction >= 8 && sc.bias === 'BULLISH' && htfOk) {
      await maybeTrade(token, sc, cycleNum);
    }
  }

  // Bankr context every ~4 cycles (~1h)
  if (cycleNum % 4 === 0) {
    console.log('\n🏦 Asking Bankr for market context...');
    const ctx = await askBankr('what are the trending tokens and general market sentiment on base right now? any notable news? keep it brief');
    if (ctx) {
      console.log('  ' + ctx.slice(0, 500).replace(/\n/g, '\n  '));
      db.bankr.push({ ts, context: ctx });
      if (db.bankr.length > 100) db.bankr = db.bankr.slice(-100);
    }
  }

  // Print insights every 8 cycles (~2h)
  if (cycleNum % 8 === 0 && cycleNum > 0) printInsights(db);

  saveDB(db);
  console.log(`\n[cycle #${cycleNum}] saved — ${scores.length}/${TOKENS.length} tokens | ${db.snapshots.length} total snapshots`);
}

// ─── Entry ────────────────────────────────────────────────────

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  delu learning cycle — 15min interval                   ║');
console.log(`║  Tokens: ${TOKENS.length} (${TOKENS.filter(t=>t.source==='binance').length} Binance majors + ${TOKENS.filter(t=>t.source==='gecko').length} Base tokens)`.padEnd(62) + '║');
console.log('║  TA: RSI·EMA·MACD·OBV·BBW·VWAP                         ║');
console.log('║  Trade: Bankr execution when conviction ≥ 8             ║');
console.log('╚══════════════════════════════════════════════════════════╝');

let cycleNum = 0;
runCycle(cycleNum).catch(console.error);
setInterval(() => { cycleNum++; runCycle(cycleNum).catch(console.error); }, INTERVAL_MS);
