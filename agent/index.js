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
const { kellySize, correlationAdjust, calibrateFromLog } = require('./kelly');
const { startDashboard } = require('./dashboard');
const { dynamicTrailStop } = require('./stops');
const { fetchAllFlows } = require('./flows');
const { getBankrAttention } = require('./bankr_market');
const { discover } = require('./discover');
const { getTrendingEntries } = require('./trending_entry');

const DRY_RUN  = process.argv.includes('--dry');
const LOOP     = process.argv.includes('--loop');
const CYCLE_MS = 30 * 60 * 1000; // 30min — fast learning cycle

const VENICE_API   = 'https://api.venice.ai/api/v1/chat/completions';
const VENICE_MODEL = 'llama-3.3-70b'; // private GPU, E2EE inference

const BANKR_LLM_API   = 'https://llm.bankr.bot/v1/chat/completions';
const BANKR_LLM_MODEL = 'claude-haiku-4-5-20251001'; // fast screen layer via Bankr LLM gateway

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
const { monitorPositions } = require('./position_monitor');

// Regime tokens only — BTC + ETH for macro context
const REGIME_TOKENS = ['BTC', 'ETH'];

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

// ─── Regime detection — BTC + ETH only ────────────────────────────────────────
// btcDaily: 1d BTC bars (220+), ethDaily: 1d ETH bars
// btcHourly: 1h BTC bars (720+) for vol ratio
function detectRegime(btcDaily, ethDaily, btcHourly, p = PARAMS) {
  if (!btcDaily || btcDaily.length < 201) return null;

  const btcD   = btcDaily.map(b => b.close);
  const ethD   = ethDaily?.map(b => b.close) || [];
  const sma200 = smaN(btcD, 200);
  if (!sma200) return null;

  const btcNow    = btcD[btcD.length - 1];
  const pctFrom200 = (btcNow - sma200) / sma200;

  // ETH regime (independent signal)
  let ethState = 'unknown';
  if (ethD.length >= 201) {
    const ethSma200 = smaN(ethD, 200);
    if (ethSma200) {
      const ethPct = (ethD[ethD.length - 1] - ethSma200) / ethSma200;
      ethState = ethPct > 0.05 ? 'BULL' : ethPct < -0.03 ? 'BEAR' : 'RANGE';
    }
  }
  const btcState = pctFrom200 > 0.05 ? 'BULL' : pctFrom200 < -0.03 ? 'BEAR' : 'RANGE';

  // Combined regime: both BEAR = full BEAR, one BEAR = mixed, both BULL = BULL
  const bothBear = btcState === 'BEAR' && ethState === 'BEAR';
  const bothBull = btcState === 'BULL' && ethState === 'BULL';

  // Vol ratio (BTC hourly 7d vs 30d)
  const btcH = btcHourly?.map(b => b.close) || [];
  const n7 = 7 * 24, n30 = 30 * 24;
  let v7 = 0, v30 = 0;
  const btcR = btcH.map((c, i) => i === 0 ? 0 : Math.log(c / btcH[i - 1]));
  if (btcR.length >= n30) {
    for (let j = btcR.length - n7; j < btcR.length; j++) v7 += btcR[j] ** 2;
    for (let j = btcR.length - n30; j < btcR.length; j++) v30 += btcR[j] ** 2;
  }
  const volRatio   = Math.sqrt(v30 / n30) > 0 ? Math.sqrt(v7 / n7) / Math.sqrt(v30 / n30) : 1;
  const highVol    = volRatio > p.volHighMult;
  const extremeVol = volRatio > p.volHighMult * 1.5;

  let state;
  if (bothBear || extremeVol)  state = 'BEAR';
  else if (bothBull)           state = highVol ? 'BULL_COOL' : 'BULL_HOT';
  else                         state = highVol ? 'RANGE_WIDE' : 'RANGE_TIGHT';

  return {
    state, btcNow, sma200, pctFrom200, volRatio, btcState, ethState,
    breadthFraction: `BTC:${btcState} ETH:${ethState}`,
    breadth: bothBull ? 1.0 : bothBear ? 0.0 : 0.5,
  };
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
    const hasSocialSpike = Object.values(checkrAttention).some(a => (a.velocity >= 3.0 && a.divergence) || (a.isGainer && a.rotationGain >= 2.0));
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
      const attnStr = attn ? ` vel=${attn.velocity?.toFixed(1)} div=${attn.divergence?1:0}${attn.isGainer?' ROT_IN':''}${attn.isLoser?' ROT_OUT':''}${attn.bankrSignal ? ' bankr='+attn.bankrSignal.toFixed(2) : ''}${attn.txnCount24h ? ' txns='+attn.txnCount24h : ''}` : '';
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
    return { skip: false, interesting: [], reason: `screen failed: ${e.message}`, layer: 'fallback' };
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
  "contractAddress": "0x... (only for onchain trending tokens discovered this cycle)",
  "size_pct": number (5-20 for buy, 100 for yield, 0 for hold),
  "confidence": number (0-100),
  "reasoning": "1-2 sentences",
  "stop_loss_pct": number,
  "take_profit_pct": number
}

Rules:
- BEAR regime = context, NOT a gate. BTC down ≠ everything down. Sector rotation is real (AI tokens, Base memes, agent coins can 10x in any macro regime). Trade on signal strength, not regime alone.
- BUY if: top signal score ≥ 0.05 AND confidence ≥ 65 AND strong cross-sectional alpha (token outperforming BTC regardless of macro)
- YIELD only if: no token clears the signal threshold — park idle capital at best available APY
- confidence < 65 → hold
- Never allocate more than 20% in one position
- Trending token buys: max $15, must include contractAddress`;

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

  // ── STEP 1: Regime — BTC + ETH only (fast, 2 tokens) ────────────────────────
  console.log('\n[regime] Fetching BTC + ETH bars...');
  const [btcDailyBars, ethDailyBars, btcHourlyBars] = await Promise.all([
    fetchBars('BTC', '1d', 220).catch(() => []),
    fetchBars('ETH', '1d', 220).catch(() => []),
    fetchBars('BTC', '1h', 720).catch(() => []),
  ]);
  console.log(`  BTC daily=${btcDailyBars.length}bars  ETH daily=${ethDailyBars.length}bars  BTC hourly=${btcHourlyBars.length}bars`);

  const regime = detectRegime(btcDailyBars, ethDailyBars, btcHourlyBars);
  if (!regime) {
    console.log('[regime] Not enough data — aborting');
    return;
  }
  console.log(`[regime] ${regime.state} | BTC $${Math.round(regime.btcNow)} | ${(regime.pctFrom200*100).toFixed(1)}% from 200d MA | BTC:${regime.btcState} ETH:${regime.ethState} | volRatio ${regime.volRatio.toFixed(2)}`);

  // ── STEP 2: Position management — Alchemy on every open position ─────────────
  console.log('\n[journal] Reconciling positions...');
  let openPositions = [];
  let balanceResp = null;
  try {
    balanceResp = await bankr.getBalances();
    const updatedPositions = await journal.reconcilePositions(balanceResp, {});
    openPositions = updatedPositions.filter(p => p.status === 'open');
    console.log(`[journal] ${openPositions.length} open position(s)`);
  } catch(e) {
    console.warn(`[journal] Reconcile skipped: ${e.message?.slice(0,60)}`);
    openPositions = journal.loadPositions().filter(p => p.status === 'open');
  }

  // Live position intelligence — volume, momentum, recommendation per position
  const positionAssessments = await monitorPositions(openPositions);

  // ── STEP 3: Onchain signals — Checkr + Bankr trending ───────────────────────

  // 3c. Fetch Checkr social attention signals (pay-per-call via x402)
  let checkrAttention = {}; // sym → { attentionDelta, velocity, divergence, viral_class, rotationGain, isGainer }
  try {
    console.log('\n[checkr] Fetching leaderboard + spikes + rotation...');
    // Run all 3 in parallel — $0.02 + $0.05 + $0.10 = $0.17/cycle
    // All on 1h window: freshest signal, fastest rotation detection
    const [lb, spikes, rotation] = await Promise.allSettled([
      checkr.getLeaderboard(20),   // 1h, sorted by ATT_delta (fastest growers)
      checkr.getSpikes(2.0),       // 1h, min_mentions=3 (newest spikes only)
      checkr.getRotation(1),       // 1h window (real-time creator transitions)
    ]);

    // Leaderboard — 1h window sorted by ATT_delta: fastest growers first
    if (lb.status === 'fulfilled' && lb.value?.tokens) {
      const tokens = lb.value.tokens;
      // Log top 3 growers by ATT_delta
      const topGrowers = [...tokens].sort((a, b) => (b.ATT_delta ?? 0) - (a.ATT_delta ?? 0)).slice(0, 3);
      if (topGrowers.length) console.log('[checkr] Top 1h growers:', topGrowers.map(t =>
        `${t.symbol}(Δ${t.ATT_delta?.toFixed(2)}pp vel=${t.velocity?.toFixed(1)})`).join(' '));
      for (const t of tokens) {
        const sym = (t.symbol || '').toUpperCase();
        // ATT_delta = change in attention share in pp — primary signal for 1h growth
        const attDelta = t.ATT_delta ?? t.ATT_delta_1h ?? t.att_delta_1h ?? 0;
        checkrAttention[sym] = {
          attentionDelta: attDelta,
          velocity:       t.velocity ?? 0,
          divergence:     t.divergence ?? false,
          attPct:         t.ATT_pct ?? 0,
          attTrend:       t.ATT_trend_direction ?? null,
          attAccelerating: t.ATT_accelerating ?? false,
        };
      }
    }

    // Spikes — high-velocity signals
    if (spikes.status === 'fulfilled') {
      for (const t of checkr.parseSpikes(spikes.value)) {
        const sym = t.token.toUpperCase();
        if (!checkrAttention[sym]) checkrAttention[sym] = { attentionDelta: 0, velocity: 0, divergence: false };
        checkrAttention[sym].velocity    = Math.max(checkrAttention[sym].velocity, t.velocity);
        checkrAttention[sym].divergence  = t.divergence;
        checkrAttention[sym].viral_class = t.viral_class;
        checkrAttention[sym].signal_type = t.signal_type;
        checkrAttention[sym].rotating_from = t.rotating_from;
        if (t.velocity >= 2.0) checkrAttention[sym].attentionDelta = Math.max(checkrAttention[sym].attentionDelta, t.velocity * 0.1);
      }
    }

    // Rotation — capital flow direction (biggest alpha signal)
    if (rotation.status === 'fulfilled') {
      const rotMap = checkr.parseRotation(rotation.value);
      for (const [sym, d] of Object.entries(rotMap)) {
        if (!checkrAttention[sym]) checkrAttention[sym] = { attentionDelta: 0, velocity: 0, divergence: false };
        // Gainers: receiving creator rotation (confirmed net_flow>0 + ATT_growth>0)
        if (d.isGainer) {
          checkrAttention[sym].rotationGain  = d.rotationGain || d.attGrowth || 0;
          checkrAttention[sym].rotationRank  = d.rotationRank;
          checkrAttention[sym].isGainer      = true;
          checkrAttention[sym].rotatingFrom  = d.rotatingFrom || [];
          checkrAttention[sym].netFlow       = d.netFlow || 0;
          checkrAttention[sym].attGrowth     = d.attGrowth || 0;
          checkrAttention[sym].topCreator    = d.topCreator || null;
          // Boost: ATT_growth is now a % (e.g. 34.2 = +34.2%), normalize to [0,1] for delta
          const growthNorm = Math.min((d.attGrowth || 0) / 50, 1.0);
          checkrAttention[sym].attentionDelta += growthNorm * 0.5;
          checkrAttention[sym].velocity = Math.max(checkrAttention[sym].velocity || 0, growthNorm * 3);
        }
        // Losers: bleeding creators = avoid / underweight
        if (d.isLoser) {
          checkrAttention[sym].rotationLoss = d.rotationLoss || Math.abs(d.attGrowth || 0);
          checkrAttention[sym].isLoser      = true;
          checkrAttention[sym].netFlow      = d.netFlow || 0;
          checkrAttention[sym].attentionDelta -= Math.min(Math.abs(d.attGrowth || 0) / 50, 0.5) * 0.3;
        }
      }
      const gainers = Object.entries(rotMap).filter(([,d]) => d.isGainer).slice(0,3);
      const losers  = Object.entries(rotMap).filter(([,d]) => d.isLoser).slice(0,3);
      if (gainers.length) console.log('[checkr] Rotation gainers:', gainers.map(([s,d]) =>
        `${s}(ATT+${d.attGrowth?.toFixed(1)}% flow=${d.netFlow} from=[${(d.rotatingFrom||[]).join(',')}])`).join(' '));
      if (losers.length)  console.log('[checkr] Rotation losers: ', losers.map(([s,d]) =>
        `${s}(ATT${d.attGrowth?.toFixed(1)}% flow=${d.netFlow})`).join(' '));
    } else {
      console.warn('[checkr] Rotation failed:', rotation.reason?.message?.slice(0,60));
    }

    console.log(`[checkr] Got attention data for ${Object.keys(checkrAttention).length} tokens`);
    const topAttn = Object.entries(checkrAttention).sort((a,b) => b[1].velocity - a[1].velocity).slice(0,3);
    for (const [sym, d] of topAttn) console.log(`  ${sym}: vel=${d.velocity?.toFixed(2)} div=${d.divergence} gain=${d.rotationGain?.toFixed(2)||'-'} gainer=${d.isGainer||false}`);
  } catch(e) {
    console.warn(`[checkr] Failed (skipping): ${e.message?.slice(0,80)}`);
  }

  // 3d. Bankr onchain trending — DEX txn count + volume from Uniswap/Aerodrome
  let bankrAttention = {};
  try {
    console.log('\n[bankr_market] Fetching onchain trending (Base + ETH)...');
    bankrAttention = await getBankrAttention(process.env.BANKR_API_KEY);
    const topTrending = Object.entries(bankrAttention).sort((a,b) => b[1].bankrSignal - a[1].bankrSignal).slice(0,5);
    console.log('[bankr_market] Top trending:', topTrending.map(([s,d]) => `${s}(txns=${d.txnCount24h} signal=${d.bankrSignal})`).join(' '));
    // Merge bankr trending into checkrAttention map
    for (const [sym, d] of Object.entries(bankrAttention)) {
      if (!checkrAttention[sym]) checkrAttention[sym] = { attentionDelta: 0, velocity: 0, divergence: false };
      // bankrSignal boosts attentionDelta — onchain txn spikes = real demand
      checkrAttention[sym].attentionDelta += d.bankrSignal * 0.3;
      checkrAttention[sym].bankrSignal     = d.bankrSignal;
      checkrAttention[sym].txnCount24h     = d.txnCount24h;
      checkrAttention[sym].trendingRank    = d.trendingRank;
      // isSpike from Bankr = strong onchain attention → treat like Checkr spike
      if (d.isSpike) {
        checkrAttention[sym].velocity = Math.max(checkrAttention[sym].velocity || 0, d.bankrSignal * 3);
      }
    }
  } catch(e) {
    console.warn(`[bankr_market] Failed (skipping): ${e.message?.slice(0,80)}`);
  }

  // ── Auto-discovery: find tokens NOT in fixed universe that are trending ───────
  let discoveredTokens = [];
  try {
    console.log('\n[discover] Scanning for undiscovered trending tokens...');
    const checkrSpikeList = Object.entries(checkrAttention)
      .filter(([, d]) => (d.velocity || 0) >= 3.0)
      .map(([sym, d]) => ({ symbol: sym, velocity: d.velocity }));
    discoveredTokens = await discover(SYMBOLS, checkrSpikeList);
    if (discoveredTokens.length) {
      console.log(`[discover] ${discoveredTokens.length} discovery candidate(s) passed vetting:`);
      for (const d of discoveredTokens) {
        console.log(`  🔍 ${d.symbol} (${d.source}) score=${d.score.toFixed(3)} liq=$${Math.round(d.liq/1000)}K age=${d.ageDays.toFixed(1)}d`);
        // Merge into checkrAttention so Venice sees it in context
        if (!checkrAttention[d.symbol]) checkrAttention[d.symbol] = { attentionDelta: 0, velocity: 0, divergence: false };
        checkrAttention[d.symbol].discovered     = true;
        checkrAttention[d.symbol].discoveryScore = d.score;
        checkrAttention[d.symbol].discoveryLiq   = d.liq;
        checkrAttention[d.symbol].discoverySource = d.source;
        checkrAttention[d.symbol].attentionDelta += d.score * 2; // strong boost for vetted discoveries
        checkrAttention[d.symbol].velocity        = Math.max(checkrAttention[d.symbol].velocity, d.score * 5);
      }
    } else {
      console.log('[discover] No new tokens passed vetting this cycle');
    }
  } catch (e) {
    console.warn(`[discover] Failed (skipping): ${e.message?.slice(0, 80)}`);
  }

  // ── Trending entry signal: catch Base tokens early in their move ─────────────
  let trendingEntries = [];
  try {
    console.log('\n[trending_entry] Scanning Base trending for early entries...');
    trendingEntries = await getTrendingEntries(process.env.BANKR_API_KEY);
    if (trendingEntries.length) {
      for (const t of trendingEntries) {
        // Merge into checkrAttention so Venice sees them in context
        if (!checkrAttention[t.symbol]) checkrAttention[t.symbol] = { attentionDelta: 0, velocity: 0, divergence: false };
        checkrAttention[t.symbol].trendingEntry      = true;
        checkrAttention[t.symbol].trendingScore      = t.score;
        checkrAttention[t.symbol].trendingRank       = t.rank;
        checkrAttention[t.symbol].trendingRet1h      = t.ret1h;
        checkrAttention[t.symbol].trendingMoveFrac   = t.moveFrac;
        checkrAttention[t.symbol].attentionDelta    += t.score * 3;
        checkrAttention[t.symbol].velocity           = Math.max(checkrAttention[t.symbol].velocity, t.score * 6);
      }
    }
  } catch (e) {
    console.warn(`[trending_entry] Failed (skipping): ${e.message?.slice(0, 80)}`);
  }

  // Merge high-velocity Checkr spikes as additional entries (tagged source=checkr)
  for (const [sym, a] of Object.entries(checkrAttention)) {
    if ((a.velocity || 0) >= 3.0 && !trendingEntries.find(t => t.symbol === sym)) {
      trendingEntries.push({
        symbol:         sym,
        source:         'checkr',
        score:          Math.min(1, (a.velocity || 0) / 15),
        velocity:       a.velocity,
        attentionDelta: a.attentionDelta || 0,
        rank:           null,
        ret1h:          null,
        ret6h:          null,
        moveFrac:       null,
        quantScore:     null,
        isGainer:       a.isGainer || false,
        rotatingFrom:   a.rotatingFrom || [],
        topCreator:     a.topCreator || null,
      });
    }
  }

  // ── STEP 3: Build candidate list from onchain signals only ──────────────────
  // No fixed universe. Candidates come from:
  //   A) Bankr trending (Base + ETH by txn count)
  //   B) Checkr spikes / rotation gainers
  //   C) Trending entry (Alchemy quant brain on Base trending)
  // Each candidate gets a quant score from the evolved brain.
  const state = regime.state;
  const ranked = []; // will be populated from trendingEntries below

  // 4. [Layer 1] Bankr LLM screen — fast pre-filter on checkrAttention signals
  console.log('\n[bankr-screen] Screening...');
  const screen = await bankrScreen(regime, ranked, checkrAttention);
  console.log(`[bankr-screen] skip=${screen.skip} | interesting=[${screen.interesting.join(',')}] | "${screen.reason}" (${screen.layer})`);

  if (screen.skip) {
    console.log('[bankr-screen] Skip signal → no trade this cycle');
    // Smart yield rebalance only if surplus above 25% reserve exists
    if (!DRY_RUN) {
      const balances = await bankr.getBalances().catch(() => null);
      const usdcLiquid = balances?.usdc || 0;
      const reserve = ACTIVE_TRANCHE_USD * 0.25;
      if (usdcLiquid > reserve) {
        console.log(`\n[bankr] $${usdcLiquid.toFixed(2)} USDC idle (reserve=$${reserve.toFixed(2)}) — checking Smart Yield...`);
        try {
          const result = await bankr.smartYieldRebalance();
          console.log(`[bankr] Result:\n${result}`);
        } catch (e) {
          console.error('[bankr] Yield rebalance failed:', e.message);
        }
      } else {
        console.log(`\n[delu] $${usdcLiquid.toFixed(2)} USDC liquid — at or below 25% reserve ($${reserve.toFixed(2)}), no yield`);
      }
    } else if (DRY_RUN) {
      console.log(`\n[delu] DRY RUN — would check smartYieldRebalance() if USDC > 25% reserve ($${(ACTIVE_TRANCHE_USD*0.25).toFixed(2)})`);
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

    // 5. Build Venice context — onchain-first, position-aware
  const arState = (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'../autoresearch/state.json'),'utf8')); } catch { return null; } })();
  const arNote = arState
    ? `\n## Autoresearch Loop\nExperiments: ${arState.expCount} | Best val Sharpe: ${arState.bestValSharpe?.toFixed(3)}\n`
    : '';

  const context = `## Market Regime
State: ${state}
BTC: $${Math.round(regime.btcNow)} — ${(regime.pctFrom200 * 100).toFixed(1)}% ${regime.pctFrom200 > 0 ? 'above' : 'below'} 200d MA
BTC regime: ${regime.btcState} | ETH regime: ${regime.ethState}
Volatility ratio (7d/30d): ${regime.volRatio.toFixed(2)} — ${regime.volRatio > PARAMS.volHighMult ? 'HIGH VOL' : 'normal'}
Note: BEAR = context not a gate. Cross-sectional alpha (sector rotation, Base memes, AI tokens) works in any regime.
${arNote}

## Open Positions — Live Intelligence
${positionAssessments.length > 0
  ? positionAssessments.map(p =>
      `${p.sym}: pnl=${p.pnlPct !== null ? (p.pnlPct > 0 ? '+' : '') + p.pnlPct.toFixed(1) + '%' : '?'} quant=${p.quantScore?.toFixed(3) ?? 'n/a'} vol=${p.volumeTrend} ret1h=${p.ret1h != null ? (p.ret1h*100).toFixed(1)+'%' : '?'} buyers=${p.transferStats?.uniqueBuyers ?? '?'} buyRatio=${p.transferStats?.buyRatio?.toFixed(2) ?? '?'} → ${p.recommendation}`
    ).join('\n')
  : 'No open positions'}

## Social Attention + Rotation (Checkr)
Signal key: vel=velocity spike, ROT_IN=creators rotating in (ATT growth confirmed), ROT_OUT=bleeding creators
${Object.keys(checkrAttention).length > 0
  ? Object.entries(checkrAttention)
      .sort((a, b) => (b[1].velocity || 0) - (a[1].velocity || 0))
      .slice(0, 8)
      .map(([sym, a]) => {
        const rot = a.isGainer
          ? ` ROT_IN(ATT+${a.attGrowth?.toFixed(1)}% flow=${a.netFlow} from=[${(a.rotatingFrom||[]).slice(0,3).join(',')}]${a.topCreator ? ' @'+a.topCreator.username : ''})`
          : a.isLoser ? ` ROT_OUT(ATT${a.attGrowth?.toFixed(1)}% flow=${a.netFlow})` : '';
        const trend = a.attTrend ? ` trend=${a.attTrend}${a.attAccelerating?' ⚡':''}` : '';
        return `${sym}: vel=${(a.velocity||0).toFixed(1)} Δ1h=${(a.attentionDelta||0).toFixed(2)}pp div=${a.divergence?'YES':'no'}${trend}${rot}`;
      }).join('\n')
  : 'Checkr unavailable this cycle'}

## 🔥 Onchain Trending Entries (Base — Alchemy price data + transfer stats)
These are Base tokens currently trending onchain. NOT in fixed universe. Execution via Bankr swap by contract address.
${trendingEntries.length
  ? trendingEntries.map(t =>
      `${t.symbol} | score=${t.score.toFixed(2)} | rank=${t.rank}(${(t.priorRanks||[]).length?(t.priorRanks||[]).join('→')+'→':''}${t.rank}) | ret1h=${(t.ret1h*100).toFixed(1)}% ret6h=${(t.ret6h*100).toFixed(1)}% ret24h=${(t.priceChange24h||0).toFixed(1)}% | move=${(t.moveFrac*100).toFixed(0)}%done | liq=$${Math.round((t.liquidity||0)/1000)}K | buyers=${t.transferStats?.uniqueBuyers||'?'} buyRatio=${t.transferStats?.buyRatio?.toFixed(2)||'?'} | addr=${t.address}`
    ).join('\n')
  : 'No high-conviction trending entries this cycle'}
If a trending token has score≥0.65 and move<50%done: consider BUY with $10–$15 size, set contractAddress to token address. Use Bankr to swap USDC→token.

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
  // Reserve check — always keep 25% of total tranche liquid for trading opportunities
  // Only yield the surplus above the reserve
  const RESERVE_USD = ACTIVE_TRANCHE_USD * 0.25;
  if (decision.action === 'yield') {
    const balances = await bankr.getBalances().catch(() => null);
    const usdcLiquid = balances?.usdc || 0;
    if (usdcLiquid <= RESERVE_USD) {
      console.log(`\n[delu] YIELD skipped — only $${usdcLiquid.toFixed(2)} liquid USDC (reserve=$${RESERVE_USD.toFixed(2)} = 25% of $${ACTIVE_TRANCHE_USD} tranche)`);
      decision = { ...decision, action: 'hold', reasoning: `Liquid USDC ($${usdcLiquid.toFixed(2)}) at or below 25% reserve — keeping capital available for trades` };
    }
  }

  if (decision.confidence < 65 || decision.action === 'hold') {
    console.log(`\n[delu] Skipping — confidence ${decision.confidence}% or hold`);
  } else if (DRY_RUN) {
    console.log(`\n[delu] DRY RUN — would: ${decision.action} ${decision.asset} (${decision.size_pct}% = $${Math.round(decision.size_pct/100*ACTIVE_TRANCHE_USD)})`);
  } else {
    console.log('\n[bankr] Executing...');
    try {
      // Kelly position sizing — calibrate from live trade history
      const stats = journal.getStats();
      const kellyParams = stats.totalTrades >= 5
        ? { winRate: stats.wins / stats.totalTrades, avgWin: Math.max(0.01, stats.avgPnl / 100), avgLoss: 0.05 }
        : { winRate: 0.52, avgWin: 0.08, avgLoss: 0.05 }; // conservative defaults until calibrated

      const kelly = kellySize(decision.confidence, ACTIVE_TRANCHE_USD, kellyParams);
      const corr  = correlationAdjust(openPositions.map(p => ({ token: p.sym })), decision.asset, kelly.sizeUsd);
      const finalSizeUsd = Math.max(10, corr.adjustedSize); // $10 Bankr minimum

      console.log(`[kelly] size=$${finalSizeUsd} (kelly=${kelly.kellyFraction}% half=${kelly.halfKelly}% conf_mult=${kelly.confidenceMultiplier}% ${corr.reason})`);

      // Override Venice's size_pct with Kelly-computed size
      const kellyDecision = { ...decision, size_pct: Math.round(finalSizeUsd / ACTIVE_TRANCHE_USD * 100) };
      const result = await bankr.execute(kellyDecision, ACTIVE_TRANCHE_USD);
      console.log(`[bankr] ✓ ${result.response || JSON.stringify(result)}`);

      // Record entry + compute dynamic trailing stop
      if (decision.action === 'buy' || decision.action === 'long') {
        const entryPrice = await bankr.getPrice(decision.asset).catch(() => 0);
        // Default trailing stop — Bankr sets 5% natively, use that
        const stopConfig = { trailPct: 5, activateAt: 1, rationale: 'Bankr native 5% trailing stop' };
        console.log(`[stops] ${decision.asset} trail=${stopConfig.trailPct}% activate=${stopConfig.activateAt}% | ${stopConfig.rationale}`);
        journal.recordEntry(decision.asset, entryPrice, finalSizeUsd, {
          regime:          regime.state,
          confidence:      decision.confidence,
          contractAddress: decision.contractAddress || null,
          kellyFraction:   kelly.kellyFraction,
          trailPct:        stopConfig.trailPct,
          activateAt:      stopConfig.activateAt,
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
    scores: [], // no fixed universe — onchain discovery is the signal
    trendingEntries: trendingEntries.map(t => ({ symbol: t.symbol, score: t.score, rank: t.rank, ret1h: t.ret1h, moveFrac: t.moveFrac, quantScore: t.quantScore })),
    positionAssessments: positionAssessments.map(p => ({ sym: p.sym, pnlPct: p.pnlPct, quantScore: p.quantScore, volumeTrend: p.volumeTrend, recommendation: p.recommendation })),
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
      scores:           ranked.slice(0, 8),
      decision,
      positions:        journal.loadPositions(),
      screen,
      cycleTs:          cycleStart,
      trendingEntries,
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

  // Publish live status to delu-site repo (Vercel reads this)
  try {
    const { publish } = require('./publish_status');
    await publish(regime, balanceResp);
    try { const { publishResearch } = require('./publish_research'); await publishResearch(); } catch(e) { console.warn('[research] publish failed:', e.message?.slice(0,50)); }
  } catch(e) { console.warn('[publish] Failed:', e.message?.slice(0, 60)); }

  console.log('\n' + '═'.repeat(60));
}

async function main() {
  if (!process.env.BANKR_API_KEY)  { console.error('Missing BANKR_API_KEY');  process.exit(1); }
  if (!process.env.VENICE_API_KEY) { console.error('Missing VENICE_API_KEY'); process.exit(1); }

  console.log(`delu agent — ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | ${LOOP ? 'every 30min' : 'single run'}`);
  console.log(`Wallet: ${process.env.DELU_WALLET}`);
  console.log(`Tranche: $${ACTIVE_TRANCHE_USD}`);

  // Start status dashboard
  startDashboard(process.env.DASHBOARD_PORT || 3737);

  await runCycle();

  if (LOOP) {
    console.log(`\nNext cycle: ${new Date(Date.now() + CYCLE_MS).toISOString()}`);
    setInterval(runCycle, CYCLE_MS);
  }
}

main().catch(e => { console.error('Fatal:', e.stack); process.exit(1); });
