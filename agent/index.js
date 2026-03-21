#!/usr/bin/env node
/**
 * delu — autonomous onchain trader agent
 *
 * Three-layer pipeline (every 30 minutes):
 *   1. Fetch market data (Binance OHLCV, dual timeframe)
 *   2. Compute regime (5-state: BULL_HOT/BULL_COOL/RANGE_TIGHT/RANGE_WIDE/BEAR)
 *   3. Score tokens with A/B/C/D quant framework
 *   4. [Layer 1] Bankr LLM screen (gemini-2.5-flash, ~$0.0001)
 *      → "anything worth trading given regime + scores?"
 *      → SKIP if BEAR or nothing interesting → Venice never called
 *   5. [Layer 2] Venice E2EE reason (llama-3.3-70b, private GPU)
 *      → receives shortlist + full context → allocation decision
 *   6. Execute via Bankr if confidence ≥ 65%
 *   7. Log all layers: which fired, what decided, why
 *
 * Usage:
 *   node agent/index.js           # single run
 *   node agent/index.js --loop    # continuous (every 30min)
 *   node agent/index.js --dry     # dry run (no execution)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const bankr   = require('./bankr');
const checkr  = require('./checkr');
const journal = require('./journal');

const DRY_RUN  = process.argv.includes('--dry');
const LOOP     = process.argv.includes('--loop');
const CYCLE_MS = 30 * 60 * 1000; // 30min — fast learning cycle

const VENICE_API   = 'https://api.venice.ai/api/v1/chat/completions';
const VENICE_MODEL = 'llama-3.3-70b'; // private GPU, E2EE inference

const BANKR_LLM_API   = 'https://llm.bankr.bot/v1/chat/completions';
const BANKR_LLM_MODEL = 'gemini-2.5-flash'; // fast screen layer — cheap, ~1s, ~$0.0001/call

// Autoresearch candidate — Venice continuously improves this function
// Agent loads it fresh every cycle so improvements flow in automatically
const CANDIDATE_PATH = require('path').join(__dirname, '../autoresearch/candidate.js');
function loadCandidate() {
  try {
    delete require.cache[require.resolve(CANDIDATE_PATH)];
    return require(CANDIDATE_PATH);
  } catch(e) {
    console.warn('[autoresearch] Could not load candidate.js:', e.message);
    return null;
  }
}

const { fetchBinanceHourly, fetchGeckoTerminal, GECKO_TERMINAL_FALLBACK } = require('../backtest/fetch.js');

const TOKENS = [
  // Majors (Binance)
  'BTC','ETH','SOL','BNB','DOGE','AAVE','ARB',
  // Base ecosystem (GeckoTerminal)
  'BRETT','DEGEN','AERO','VIRTUAL','CLANKER',
  'ODAI','JUNO','FELIX','CLAWD','CLAWNCH'
];
const SYMBOLS = TOKENS; // same list

const ACTIVE_TRANCHE_USD = 27; // liquid USDC on Base (updated 2026-03-20)

// ─── Best params from walk-forward validated grid search ──────────────────────
// adaptive.js best config: OOS +8.9% Sharpe 1.69 DD 7.9%, WF worst=1.69 all 3 folds positive
const PARAMS = {
  stopMult:    1.5,
  tpMult:      6.0,
  stopMultD:   2.0,
  tpMultD:     2.5,
  topN:        1,
  bullThresh:  0.05,
  bearThresh: -0.03,
  breadthMin:  0.30,
  volHighMult: 1.5,
  altWin:      14 * 24,
  altThresh:   0.03,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Data fetching ─────────────────────────────────────────────────────────────
async function fetchBars(symbol, interval = '1h', limit = 500) {
  // Try Binance first (majors)
  try {
    const bars = await fetchBinanceHourly(symbol, limit);
    if (bars && bars.length > 0) return bars;
  } catch(e) {}

  // Try GeckoTerminal (Base tokens)
  if (GECKO_TERMINAL_FALLBACK[symbol]) {
    try {
      const bars = await fetchGeckoTerminal(symbol, Math.ceil(limit / 24)); // GT uses days for limits often, but we want hourly?
      // fetchGeckoTerminal returns DAILY bars in backtest/fetch.js. 
      // We need HOURLY for signals.
      // Let's check fetchGeckoTerminal implementation in backtest/fetch.js...
      // It fetches daily bars.
      // We need to implement hourly fetching for GT here if it's not there.
      
      // Actually, let's fetch hourly from GT directly here:
      const cfg = GECKO_TERMINAL_FALLBACK[symbol];
      const url = `https://api.geckoterminal.com/api/v2/networks/${cfg.network}/pools/${cfg.pool}/ohlcv/hour?limit=${limit}&token=base`;
      const r = await fetch(url, { headers: { Accept: 'application/json;version=20230302' } });
      if (!r.ok) throw new Error(`GT ${r.status}`);
      const json = await r.json();
      const list = json?.data?.attributes?.ohlcv_list || [];
      return list.reverse().map(([ts, o, h, l, c, v]) => ({
        ts: ts * 1000, time: new Date(ts * 1000),
        open: +o, high: +h, low: +l, close: +c, volume: +v
      }));
    } catch(e) {
      console.warn(`  [fetch] ${symbol} failed on GT: ${e.message}`);
    }
  }
  
  return [];
}

// ─── Indicators ────────────────────────────────────────────────────────────────
function smaN(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;
  const s = closes.slice(-(p + 1));
  let g = 0, l = 0;
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  const ag = g / p, al = l / p;
  return al === 0 ? 100 : Math.round(100 - 100 / (1 + ag / al));
}

function atr(bars, p = 14) {
  if (bars.length < p + 1) return null;
  const s = bars.slice(-(p + 1));
  let a = null;
  for (let i = 1; i < s.length; i++) {
    const tr = Math.max(s[i].high - s[i].low,
      Math.abs(s[i].high - s[i - 1].close),
      Math.abs(s[i].low  - s[i - 1].close));
    a = a === null ? tr : (a * (p - 1) + tr) / p;
  }
  return a;
}

function volZ(volumes, lookback = 30 * 24) {
  if (volumes.length < lookback + 1) return null;
  const s = volumes.slice(-lookback - 1, -1);
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
  return sd > 0 ? (volumes[volumes.length - 1] - m) / sd : 0;
}

// ─── 5-State Regime ────────────────────────────────────────────────────────────
// dailyBars: 1d candles (220) for 200d MA + breadth
// hourlyBars: 1h candles (500) for vol ratio
function detectRegime(allBarsDaily, allBarsHourly, p = PARAMS) {
  const btcDaily = allBarsDaily[0];
  if (!btcDaily || btcDaily.length < 201) return null;

  const btcD = btcDaily.map(b => b.close);
  const sma200 = smaN(btcD, 200);
  if (!sma200) return null;

  const btcNow = btcD[btcD.length - 1];
  const pctFrom200 = (btcNow - sma200) / sma200;

  // Vol ratio from hourly bars (7d vs 30d)
  const btcH = allBarsHourly[0]?.map(b => b.close) || [];
  const n7 = 7 * 24, n30 = 30 * 24;
  let v7 = 0, v30 = 0;
  const btcR = btcH.map((c, i) => i === 0 ? 0 : Math.log(c / btcH[i - 1]));
  if (btcR.length >= n30) {
    for (let j = btcR.length - n7; j < btcR.length; j++) v7 += btcR[j] ** 2;
    for (let j = btcR.length - n30; j < btcR.length; j++) v30 += btcR[j] ** 2;
  }
  const volRatio = Math.sqrt(v30 / n30) > 0 ? Math.sqrt(v7 / n7) / Math.sqrt(v30 / n30) : 1;
  const highVol    = volRatio > p.volHighMult;
  const extremeVol = volRatio > p.volHighMult * 1.5;

  // Market breadth (daily bars — tokens above 200d MA)
  let aboveMa = 0;
  for (const bars of allBarsDaily) {
    if (!bars || bars.length < 201) continue;
    const c = bars.map(b => b.close);
    const ma = smaN(c, 200);
    if (ma && c[c.length - 1] > ma) aboveMa++;
  }
  const breadth = aboveMa / allBarsDaily.filter(b => b?.length >= 201).length;

  if (breadth < p.breadthMin || extremeVol) {
    return { state: 'BEAR', btcNow, sma200, pctFrom200, volRatio, breadth, breadthFraction: `${aboveMa}/${allBarsDaily.length}` };
  }

  let state;
  if (pctFrom200 < p.bearThresh)      state = 'BEAR';
  else if (pctFrom200 > p.bullThresh) state = highVol ? 'BULL_COOL' : 'BULL_HOT';
  else                                 state = highVol ? 'RANGE_WIDE' : 'RANGE_TIGHT';

  return { state, btcNow, sma200, pctFrom200, volRatio, breadth, breadthFraction: `${aboveMa}/${allBarsDaily.length}` };
}

// ─── Template Scoring ──────────────────────────────────────────────────────────
function scoreTemplateA(bars) {
  // Trend momentum: 20/60/120d weighted return, volume confirmation
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  if (closes.length < 120 * 24) return 0;
  const r20  = (closes[closes.length-1] - closes[closes.length-1-20*24])  / closes[closes.length-1-20*24];
  const r60  = (closes[closes.length-1] - closes[closes.length-1-60*24])  / closes[closes.length-1-60*24];
  const r120 = (closes[closes.length-1] - closes[closes.length-1-120*24]) / closes[closes.length-1-120*24];
  const trend = 0.5 * r20 + 0.3 * r60 + 0.2 * r120;
  if (trend < 0.10) return 0;
  const vz = volZ(volumes) ?? 0;
  return Math.max(0, trend * (1 + Math.tanh(vz * 0.5)));
}

function scoreTemplateB(bars) {
  // OBV accumulation — steady buying pressure, RSI not overbought, sideways price
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const WIN = 14 * 24;
  if (closes.length < WIN + 25) return 0;
  const r = rsi(closes.slice(-20));
  if (r !== null && r > 60) return 0;
  const ret14d = (closes[closes.length-1] - closes[closes.length-1-WIN]) / closes[closes.length-1-WIN];
  if (ret14d > 0.05) return 0; // already running — too late
  let ob = 0;
  const obvArr = [];
  const start = closes.length - WIN - 25;
  for (let k = start; k < closes.length; k++) {
    if (k > 0) {
      if (closes[k] > closes[k-1]) ob += volumes[k];
      else if (closes[k] < closes[k-1]) ob -= volumes[k];
    }
    obvArr.push(ob);
  }
  const w = obvArr;
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
  if (sd < 1e-9) return 0;
  const oz  = (w[w.length - 1] - m) / sd;
  const ozP = (w[w.length - 25] - m) / sd;
  if (oz < 0.8 || oz <= ozP) return 0;
  return Math.max(0, Math.tanh(oz * 0.5) * Math.tanh((oz - ozP) * 2));
}

function scoreTemplateC(bars, allBars) {
  // Cross-sectional rank — token leads the pack on 30d momentum
  const closes = bars.map(b => b.close);
  if (closes.length < 30 * 24) return 0;
  const ret30 = (closes[closes.length-1] - closes[closes.length-1-30*24]) / closes[closes.length-1-30*24];
  // Rank among all tokens
  const rets = allBars.map(b => {
    const c = b.map(x => x.close);
    if (c.length < 30 * 24) return 0;
    return (c[c.length-1] - c[c.length-1-30*24]) / c[c.length-1-30*24];
  });
  const rank = rets.filter(r => r < ret30).length / rets.length;
  if (rank < 0.70) return 0; // top 30% only
  return (rank - 0.70) / 0.30;
}

function scoreTemplateD(bars) {
  // Panic bounce: sharp 1-3d selloff with volume spike, RSI oversold, stabilizing
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const WIN = 30 * 24;
  if (closes.length < WIN) return 0;

  // 1d return z-score
  const ret1d  = (closes[closes.length-1] - closes[closes.length-1-24]) / closes[closes.length-1-24];
  const rets   = [];
  for (let k = closes.length - WIN; k < closes.length; k += 24) {
    if (k >= 24) rets.push((closes[k] - closes[k-24]) / closes[k-24]);
  }
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
  const retZ = sd > 0 ? (ret1d - m) / sd : 0;

  if (retZ > -1.2) return 0; // not a selloff
  const vz = volZ(volumes);
  if (vz === null || vz < 0.5) return 0;
  const r = rsi(closes.slice(-20));
  if (r !== null && r > 45) return 0; // not oversold
  if (ret1d < -0.30) return 0; // freefall — avoid
  // Small green candle forming (last 4h)
  const r4h = (closes[closes.length-1] - closes[closes.length-5]) / closes[closes.length-5];
  if (r4h < 0) return 0;
  return Math.max(0, Math.min(Math.abs(retZ)-1.2, 3)/3 * Math.min(vz-0.5, 3)/3);
}

// ─── Layer 1: Bankr LLM screen ────────────────────────────────────────────────
// Fast pre-filter before Venice. Cheap model, simple question:
// "Given this regime and these signal scores, is anything worth analyzing?"
// Returns: { skip: bool, interesting: string[], reason: string }
async function bankrScreen(regime, ranked, checkrAttention = {}) {
  const state = regime.state;

  // In BEAR: only skip if nothing is oversold — otherwise look for bounce plays
  if (state === 'BEAR') {
    // Check if any token has a non-zero score OR spiking attention (oversold bounce / divergence)
    const hasSocialSpike = Object.values(checkrAttention).some(a => a.velocity >= 3.0 && a.divergence);
    const hasSignal = ranked.some(s => s.sAR > 0 || s.sD > 0.05) || hasSocialSpike;
    if (!hasSignal) {
      return { skip: true, interesting: [], reason: 'BEAR regime, no oversold signals — yield only', layer: 'hardcoded' };
    }
    // Has oversold signal — pass through to Bankr LLM for light screening
    console.log('[bankr-screen] BEAR but oversold signals detected — checking with LLM');
  }

  // Build a compact summary for the screen model
  const scoreLines = ranked
    .map(s => {
      const attn = checkrAttention[s.sym];
      const attnStr = attn ? ` vel=${attn.velocity?.toFixed(1)} div=${attn.divergence?1:0}` : '';
      return `${s.sym}: combined=${s.combined.toFixed(3)} [A=${s.sA.toFixed(2)} B=${s.sB.toFixed(2)} AR=${s.sAR.toFixed(2)}${attnStr}]`;
    })
    .join('\n');

  const prompt = `Market regime: ${state}
BTC ${(regime.pctFrom200 * 100).toFixed(1)}% from 200d MA | breadth: ${regime.breadthFraction} | volRatio: ${regime.volRatio.toFixed(2)}

Signal scores (combined 0-1, threshold 0.05):
${scoreLines}

Are any tokens worth deeper analysis for a trade entry right now?
Reply with JSON only — no markdown, no explanation outside the JSON:
{"skip": false, "interesting": ["ETH", "AAVE"], "reason": "one sentence"}
or
{"skip": true, "interesting": [], "reason": "one sentence"}`;

  try {
    const res = await fetch(BANKR_LLM_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.BANKR_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model: BANKR_LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.1
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Bankr LLM error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const content = data.choices[0].message.content.trim();

    // Strip markdown fences if model wraps in ```json
    const clean = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(clean);

    return {
      skip:        !!parsed.skip,
      interesting: Array.isArray(parsed.interesting) ? parsed.interesting : [],
      reason:      parsed.reason || '',
      layer:       'bankr-llm',
      model:       BANKR_LLM_MODEL,
      usage:       data.usage,
    };
  } catch (e) {
    // Screen failure → don't block Venice, log and continue
    console.warn(`[bankr-screen] Failed (${e.message}) — passing to Venice anyway`);
    return { skip: false, interesting: SYMBOLS, reason: `screen failed: ${e.message}`, layer: 'fallback' };
  }
}

// ─── Venice reasoning ──────────────────────────────────────────────────────────
async function askVenice(context) {
  const systemPrompt = `You are delu, an autonomous onchain trader running on Base.
Your capital is real. Every decision is executed onchain via Bankr.
You reason from quantitative signals — not vibes, not narratives.

You have a walk-forward validated quant framework:
- 5 market regimes: BULL_HOT, BULL_COOL, RANGE_TIGHT, RANGE_WIDE, BEAR
- 4 signal templates: A (trend momentum), B (OBV accumulation), C (cross-sectional rank), D (panic bounce)
- Backtested: +8.9% OOS return, Sharpe 1.69, DD 7.9% vs BTC -39% over 219 days
- In BEAR regime: prefer yield, but small bounce trades allowed if RSI < 35 and confidence ≥ 65
- In BULL_HOT: use A and C signals (trend + relative strength)
- In RANGE/BULL_COOL: use B and D signals (accumulation + panic bounce)

You respond ONLY with valid JSON:
{
  "action": "buy" | "yield" | "hold",
  "asset": "token symbol or USDC",
  "size_pct": number (5-20 for buy, 100 for yield, 0 for hold),
  "confidence": number (0-100),
  "reasoning": "1-2 sentences",
  "stop_loss_pct": number,
  "take_profit_pct": number
}

Rules:
- BEAR regime → always yield (action=yield, asset=USDC)
- confidence < 65 → hold
- Never allocate more than 20% in one position
- If top signal score < 0.05 → hold`;

  const res = await fetch(VENICE_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: VENICE_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: context }
      ],
      venice_parameters: { enable_e2ee: true }, // E2EE: inference is encrypted end-to-end
      temperature: 0.2
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Venice error: ${err}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content;
  const teeQuote = data.venice_parameters?.enable_e2ee ? 'e2ee-encrypted' : null;

  let decision;
  try {
    decision = JSON.parse(content.trim());
  } catch {
    const match = content.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    if (match) decision = JSON.parse(match[1]);
    else throw new Error(`Could not parse Venice response: ${content}`);
  }

  return { ...decision, tee_quote: teeQuote, raw: content };
}

// ─── Main cycle ────────────────────────────────────────────────────────────────
async function runCycle() {
  const cycleStart = new Date().toISOString();
  console.log('\n' + '═'.repeat(60));
  console.log(`delu cycle: ${cycleStart}`);
  console.log('═'.repeat(60));

  // 1. Fetch bars — daily for regime (200d MA), hourly for signals
  console.log('\n[data] Fetching bars...');
  const allBarsDaily = [];  // 1d bars, 220 candles
  const allBars = [];       // 1h bars, 500 candles
  for (let i = 0; i < TOKENS.length; i++) {
    try {
      const [daily, hourly] = await Promise.all([
        fetchBars(TOKENS[i], '1d', 220),
        fetchBars(TOKENS[i], '1h', 500),
      ]);
      allBarsDaily.push(daily);
      allBars.push(hourly);
      process.stdout.write(`  ${SYMBOLS[i]} ✓  `);
    } catch (e) {
      console.error(`  ${SYMBOLS[i]} FAILED: ${e.message}`);
      allBarsDaily.push([]);
      allBars.push([]);
    }
    await sleep(2000); // 2s delay to avoid GeckoTerminal 429s (30 req/min limit)
  }
  console.log();

  // 2. Detect regime
  const regime = detectRegime(allBarsDaily, allBars);
  if (!regime) {
    console.log('[regime] Not enough data — aborting');
    return;
  }
  console.log(`\n[regime] ${regime.state} | BTC $${Math.round(regime.btcNow)} | ${((regime.pctFrom200)*100).toFixed(1)}% from 200d MA | breadth ${regime.breadthFraction} | volRatio ${regime.volRatio.toFixed(2)}`);

  // 2b. Reconcile positions with Bankr (point 1: track closes)
  console.log('\n[journal] Reconciling positions...');
  const currentPricesForReconcile = {};
  try {
    const balanceResp = await bankr.getBalances();
    const updatedPositions = await journal.reconcilePositions(balanceResp, currentPricesForReconcile);
    const open = updatedPositions.filter(p => p.status === 'open');
    console.log(`[journal] ${open.length} open positions after reconcile`);
  } catch(e) {
    console.warn(`[journal] Reconcile skipped: ${e.message?.slice(0,60)}`);
  }

  // (checkr attention fetched below in step 3b)

  // 3. Score all tokens
  const candidate = loadCandidate();
  const arState = (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'../autoresearch/state.json'),'utf8')); } catch { return null; } })();
  if (arState) console.log(`\n[autoresearch] exp=${arState.expCount} bestValSharpe=${arState.bestValSharpe.toFixed(3)} — candidate loaded ${candidate ? '✓' : '✗'}`);

  // 3b. Fetch Checkr social attention signals (pay-per-call via x402, ~$0.02)
  let checkrAttention = {}; // sym → { attentionDelta, velocity, divergence, viral_class }
  try {
    console.log('\n[checkr] Fetching attention leaderboard...');
    const lb = await checkr.getLeaderboard(20);
    if (lb?.tokens) {
      for (const t of lb.tokens) {
        const sym = (t.symbol || '').toUpperCase();
        checkrAttention[sym] = {
          attentionDelta: t.ATT_delta_1h ?? t.att_delta_1h ?? 0,
          velocity:       t.velocity ?? 0,
          divergence:     t.divergence ?? false,
        };
      }
    }
    // Also fetch spikes for high-velocity signals
    const spikes = await checkr.getSpikes(2.0);
    for (const t of checkr.parseSpikes(spikes)) {
      const sym = t.token.toUpperCase();
      if (!checkrAttention[sym]) checkrAttention[sym] = { attentionDelta: 0, velocity: 0, divergence: false };
      checkrAttention[sym].velocity    = Math.max(checkrAttention[sym].velocity, t.velocity);
      checkrAttention[sym].divergence  = t.divergence;
      checkrAttention[sym].viral_class = t.viral_class;
      // Spike = strong positive attention delta
      if (t.velocity >= 2.0) checkrAttention[sym].attentionDelta = Math.max(checkrAttention[sym].attentionDelta, t.velocity * 0.1);
    }
    console.log(`[checkr] Got attention data for ${Object.keys(checkrAttention).length} tokens`);
    const topAttn = Object.entries(checkrAttention).sort((a,b) => b[1].velocity - a[1].velocity).slice(0,3);
    for (const [sym, d] of topAttn) console.log(`  ${sym}: vel=${d.velocity?.toFixed(2)} div=${d.divergence} attnDelta=${d.attentionDelta?.toFixed(3)}`);
  } catch(e) {
    console.warn(`[checkr] Failed (skipping): ${e.message?.slice(0,80)}`);
  }

  console.log('[signals] Scoring...');
  const btcDailyCloses = allBarsDaily[0]?.map(b => b.close) || [];
  const scores = SYMBOLS.map((sym, ti) => {
    const bars = allBars[ti];
    const dailyBars = allBarsDaily[ti] || [];
    if (bars.length < 250) return { sym, ti, sA: 0, sB: 0, sC: 0, sD: 0, sAR: 0 };

    // Autoresearch score — Venice-evolved signal function
    let sAR = 0;
    if (candidate?.scoreToken) {
      try {
        const attn = checkrAttention[sym] || {};
        sAR = candidate.scoreToken({
          prices:            dailyBars.map(b => b.close),
          volumes:           dailyBars.map(b => b.volume || 0),
          btcPrices:         btcDailyCloses,
          flowSignal:        0,
          attentionDelta:    attn.attentionDelta || 0,
          attentionVelocity: attn.velocity || 0,
          divergence:        attn.divergence ? 1 : 0,
        }) || 0;
        sAR = Math.max(0, Math.min(1, sAR)); // clamp 0-1
      } catch(e) { sAR = 0; }
    }

    return {
      sym, ti,
      sA:  scoreTemplateA(bars),
      sB:  scoreTemplateB(bars),
      sC:  scoreTemplateC(bars, allBars),
      sD:  scoreTemplateD(bars),
      sAR,
    };
  });

  // Regime-gated combined score
  // sAR = autoresearch score (Venice-evolved, contributes 20% weight in BULL)
  const state = regime.state;
  const hasAR = scores.some(s => s.sAR > 0);
  const ranked = scores.map(s => {
    let combined = 0;
    let template = 'none';
    // AR weight: 20% in BULL, 10% in RANGE, 0% in BEAR
    const arW = state.startsWith('BULL') ? 0.20 : state.startsWith('RANGE') ? 0.10 : 0;
    const rem = 1 - arW;
    if (state === 'BULL_HOT') {
      combined = rem * (0.50 * s.sA + 0.25 * s.sC + 0.15 * s.sB + 0.10 * s.sD) + arW * s.sAR;
      template = s.sAR > s.sA && hasAR ? 'AR' : s.sA > s.sC ? 'A' : 'C';
    } else if (state === 'BULL_COOL') {
      combined = rem * (0.40 * s.sA + 0.30 * s.sD + 0.20 * s.sB + 0.10 * s.sC) + arW * s.sAR;
      template = s.sD > s.sA ? 'D' : 'A';
    } else if (state === 'RANGE_TIGHT') {
      combined = rem * (0.50 * s.sB + 0.35 * s.sD + 0.15 * s.sA) + arW * s.sAR;
      template = s.sB > s.sD ? 'B' : 'D';
    } else if (state === 'RANGE_WIDE') {
      combined = rem * (0.70 * s.sD + 0.30 * s.sB) + arW * s.sAR;
      template = 'D';
    }
    // BEAR: combined = 0 for all
    return { ...s, combined, template };
  }).sort((a, b) => b.combined - a.combined);

  console.log('  Top tokens:');
  for (const s of ranked.slice(0, 3)) {
    console.log(`    ${s.sym.padEnd(6)} A=${s.sA.toFixed(3)} B=${s.sB.toFixed(3)} C=${s.sC.toFixed(3)} D=${s.sD.toFixed(3)} AR=${s.sAR.toFixed(3)} → combined=${s.combined.toFixed(3)} [${s.template}]`);
  }

  // 4. [Layer 1] Bankr LLM screen — fast pre-filter
  console.log('\n[bankr-screen] Screening...');
  const screen = await bankrScreen(regime, ranked, checkrAttention);
  console.log(`[bankr-screen] skip=${screen.skip} | interesting=[${screen.interesting.join(',')}] | "${screen.reason}" (${screen.layer})`);

  if (screen.skip) {
    console.log('[bankr-screen] Skip signal → entering Smart Yield mode');
    
    // In BEAR or no signal: smart yield rebalance
    // 1. Check if we're already in the best yield
    // 2. Move if >1% better available
    if (!DRY_RUN && state === 'BEAR') {
      console.log('\n[bankr] Checking Smart Yield opportunities...');
      try {
        const result = await bankr.smartYieldRebalance();
        console.log(`[bankr] Result:\n${result}`);
      } catch (e) {
        console.error('[bankr] Yield rebalance failed:', e.message);
      }
    } else if (DRY_RUN) {
      console.log(`\n[delu] DRY RUN — would run smartYieldRebalance()`);
    }

    const logEntry = {
      ts: cycleStart, regime: state, regime_detail: regime,
      scores: ranked.map(s => ({ sym: s.sym, combined: s.combined, template: s.template })),
      screen, decision: { action: 'smart_yield', asset: 'USDC', reason: screen.reason }, dry_run: DRY_RUN
    };
    const logPath = require('path').join(__dirname, '../data/agent_log.jsonl');
    require('fs').appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
    console.log(`\n[log] → ${logPath}`);
    console.log('\n' + '═'.repeat(60));
    return;
  }

  // Filter ranked to only tokens Bankr screen found interesting
  const interestingRanked = screen.interesting.length > 0
    ? ranked.filter(s => screen.interesting.includes(s.sym))
    : ranked;
  if (interestingRanked.length === 0) {
    console.log('[bankr-screen] No tokens passed filter — holding');
    return;
  }

  // 5. Build Venice context (shortlisted tokens only)
  const topToken = interestingRanked[0];
  const recentPrices = SYMBOLS.map((sym, ti) => {
    const bars = allBars[ti];
    if (!bars.length) return `${sym}: N/A`;
    const c = bars[bars.length-1].close;
    const r24h = bars.length > 24 ? ((c - bars[bars.length-25].close) / bars[bars.length-25].close * 100).toFixed(1) : 'N/A';
    return `${sym}: $${c.toFixed(4)} (${r24h}% 24h)`;
  });

  const rsiVals = SYMBOLS.map((sym, ti) => {
    const bars = allBars[ti];
    if (!bars.length) return `${sym}: N/A`;
    const r = rsi(bars.slice(-20).map(b => b.close));
    return `${sym}: ${r ?? 'N/A'}`;
  });

  const arNote = arState
    ? `\n## Autoresearch (Venice self-improvement loop)\nExperiments run: ${arState.expCount} | Best validation Sharpe: ${arState.bestValSharpe.toFixed(3)}\nAR scores reflect a scoring function Venice has been autonomously evolving.\n`
    : '';

  const context = `## Market Regime
State: ${state}
BTC: $${Math.round(regime.btcNow)} — ${(regime.pctFrom200 * 100).toFixed(1)}% ${regime.pctFrom200 > 0 ? 'above' : 'below'} 200d MA
Volatility ratio (7d/30d): ${regime.volRatio.toFixed(2)} — ${regime.volRatio > PARAMS.volHighMult ? 'HIGH VOL' : 'normal'}
Market breadth: ${regime.breadthFraction} tokens above 200d MA
${arNote}
## Pre-Screen (Bankr LLM)
Tokens flagged as interesting: ${screen.interesting.join(', ') || 'none'}
Screen rationale: "${screen.reason}"

## Prices & 24h Change
${recentPrices.join('\n')}

## RSI (14, hourly)
${rsiVals.join('\n')}

## Social Attention (Checkr — X/CT mindshare, velocity, divergence)
${Object.keys(checkrAttention).length > 0
  ? interestingRanked.map(s => {
      const a = checkrAttention[s.sym];
      return a ? `${s.sym}: vel=${a.velocity?.toFixed(1)} div=${a.divergence?'YES':'no'} delta=${a.attentionDelta?.toFixed(3)}` : `${s.sym}: no data`;
    }).join(' | ')
  : 'Checkr unavailable this cycle'}

## Signal Scores — Shortlisted tokens (A=trend B=OBV C=rank D=bounce AR=self-evolved vel=social-velocity)
${interestingRanked.map(s => {
  const a = checkrAttention[s.sym];
  const velStr = a ? ` vel=${a.velocity?.toFixed(1)}` : '';
  return `${s.sym.padEnd(6)}: A=${s.sA.toFixed(3)} B=${s.sB.toFixed(3)} C=${s.sC.toFixed(3)} D=${s.sD.toFixed(3)} AR=${s.sAR.toFixed(3)}${velStr} → ${s.combined.toFixed(3)} [${s.template}]`;
}).join('\n')}

## Top Candidate
${topToken.combined > 0.05
  ? `${topToken.sym} via Template ${topToken.template} | score=${topToken.combined.toFixed(3)}`
  : 'None — below threshold'}

## Portfolio Context
Active tranche: $${ACTIVE_TRANCHE_USD} USDC
Stop: ${PARAMS.stopMult}× ATR | Target: ${PARAMS.tpMult}× ATR

A fast screening model (Bankr LLM) already filtered these tokens as worth analyzing.
What is your allocation decision?`;

  // 6. [Layer 2] Venice E2EE — private allocation reasoning
  console.log('\n[venice] Reasoning (E2EE private)...');
  let decision;
  try {
    decision = await askVenice(context);
    decision.layers_used = ['bankr-screen', 'venice-e2ee'];
    decision.screen = screen;
    console.log(`[venice] → ${decision.action.toUpperCase()} ${decision.asset} | size=${decision.size_pct}% | confidence=${decision.confidence}%`);
    console.log(`[venice] "${decision.reasoning}"`);
    console.log(`[venice] Privacy: ${decision.tee_quote === 'e2ee-encrypted' ? '✓ E2EE (inference encrypted)' : '✗ no privacy layer'}`);
  } catch (e) {
    console.error('[venice] Failed:', e.message);
    decision = { action: 'hold', asset: 'USDC', size_pct: 0, confidence: 0, reasoning: `Venice unavailable: ${e.message}`, tee_quote: null, layers_used: ['bankr-screen', 'venice-failed'], screen };
  }

  // 7. Execute
  if (decision.confidence < 65 || decision.action === 'hold') {
    console.log(`\n[delu] Skipping — confidence ${decision.confidence}% or hold`);
  } else if (DRY_RUN) {
    console.log(`\n[delu] DRY RUN — would: ${decision.action} ${decision.asset} (${decision.size_pct}% = $${Math.round(decision.size_pct/100*ACTIVE_TRANCHE_USD)})`);
  } else {
    console.log('\n[bankr] Executing...');
    try {
      const result = await bankr.execute(decision, ACTIVE_TRANCHE_USD);
      console.log(`[bankr] ✓ ${result.response || JSON.stringify(result)}`);
      // Point 1: record entry in journal
      if (decision.action === 'buy' || decision.action === 'long') {
        const entryPrice = await bankr.getPrice(decision.asset).catch(() => 0);
        const sizeUsd    = Math.round((decision.size_pct / 100) * ACTIVE_TRANCHE_USD * 100) / 100;
        journal.recordEntry(decision.asset, entryPrice, sizeUsd, {
          regime:     regime.state,
          confidence: decision.confidence,
          signals:    ranked.find(s => s.sym === decision.asset),
        });
      }
    } catch (e) {
      console.error('[bankr] Execution failed:', e.message);
    }
  }

  // 8. Log
  const logEntry = {
    ts: cycleStart,
    regime: state,
    regime_detail: regime,
    scores: ranked.map(s => ({ sym: s.sym, combined: s.combined, template: s.template, sA: s.sA, sB: s.sB, sC: s.sC, sD: s.sD })),
    screen,
    decision,
    dry_run: DRY_RUN
  };
  const logPath = require('path').join(__dirname, '../data/agent_log.jsonl');
  require('fs').appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  console.log(`\n[log] → ${logPath}`);

  // Point 2: write human-readable cycle summary
  try {
    journal.writeSummary({
      regime,
      scores:   ranked.slice(0, 8),
      decision,
      positions: journal.loadPositions(),
      screen,
      cycleTs:  cycleStart,
    });
  } catch(e) { console.warn('[journal] Summary failed:', e.message); }

  // Point 3: feed closed trade outcomes back to autoresearch
  try {
    const closedThisCycle = journal.loadPositions().filter(p =>
      p.status === 'closed' && p.closedAt &&
      (Date.now() - new Date(p.closedAt).getTime()) < CYCLE_MS * 1.5
    );
    if (closedThisCycle.length > 0) {
      journal.feedbackToResearch(closedThisCycle);
    }
  } catch(e) { console.warn('[journal] Feedback failed:', e.message); }

  // Print live stats
  try {
    const stats = journal.getStats();
    if (stats.totalTrades > 0) {
      console.log(`\n[stats] ${stats.totalTrades} closed trades | WR=${stats.wins}/${stats.totalTrades} | avgPnL=${stats.avgPnl.toFixed(2)}%`);
    }
  } catch(e) {}

  console.log('\n' + '═'.repeat(60));
}

async function main() {
  if (!process.env.BANKR_API_KEY)  { console.error('Missing BANKR_API_KEY');  process.exit(1); }
  if (!process.env.VENICE_API_KEY) { console.error('Missing VENICE_API_KEY'); process.exit(1); }

  console.log(`delu agent — ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | ${LOOP ? 'every 4h' : 'single run'}`);
  console.log(`Wallet: ${process.env.DELU_WALLET}`);
  console.log(`Tranche: $${ACTIVE_TRANCHE_USD}`);

  await runCycle();

  if (LOOP) {
    console.log(`\nNext cycle: ${new Date(Date.now() + CYCLE_MS).toISOString()}`);
    setInterval(runCycle, CYCLE_MS);
  }
}

main().catch(e => { console.error('Fatal:', e.stack); process.exit(1); });
