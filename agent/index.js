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
const { discoverAlchemy } = require('./discover_alchemy');
const { scoreMultiTF } = require('./multi_tf_score');
const { getTrendingEntries } = require('./trending_entry');
const { rugCheck }           = require('./rug_check');

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
const { monitorPositions, runAtrStops } = require('./position_monitor');

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
async function bankrScreen(regime, ranked, checkrAttention = {}, trendingEntries = []) {
  const state = regime.state;

  // In BEAR: only skip if truly nothing to look at — trending entries count as signal
  if (state === 'BEAR') {
    const hasSocialSpike = Object.values(checkrAttention).some(a => (a.velocity >= 3.0 && a.divergence) || (a.isGainer && a.rotationGain >= 2.0));
    const hasRankedSignal = ranked.some(s => s.sAR > 0 || s.sD > 0.05);
    const hasTrendingSignal = trendingEntries.some(t => (t.score ?? 0) >= 0.30);
    const hasSignal = hasRankedSignal || hasSocialSpike || hasTrendingSignal;
    if (!hasSignal) {
      return { skip: true, interesting: [], reason: 'BEAR regime — no signals above threshold across Alchemy, Checkr, onchain discovery', layer: 'hardcoded' };
    }
    console.log(`[bankr-screen] BEAR but signals present (ranked=${hasRankedSignal} social=${hasSocialSpike} trending=${hasTrendingSignal}) — screening with LLM`);
  }

    // Build a compact summary — use trendingEntries (onchain discovery) as primary signal source
  // ranked may be empty since we no longer have a fixed universe
  const allCandidates = trendingEntries && trendingEntries.length > 0
    ? trendingEntries
    : ranked;

  const scoreLines = allCandidates.map(s => {
    const sym  = s.symbol || s.sym;
    const attn = checkrAttention[sym] || {};
    const score = s.score ?? s.combined ?? 0;
    const q     = s.quantScore != null ? ` quant=${s.quantScore.toFixed(2)}` : ' quant=n/a(new)';
    const ret   = s.ret1h != null ? ` ret1h=${(s.ret1h*100).toFixed(1)}%` : '';
    const vel   = attn.velocity > 0 ? ` vel=${attn.velocity.toFixed(1)}` : '';
    const att   = attn.attentionDelta > 0 ? ` att=${attn.attentionDelta.toFixed(1)}` : '';
    const mom   = attn.momentumWindows > 0 ? ` mom=${attn.momentumWindows}w` : '';
    const rot   = attn.isGainer ? ' ROT_IN' : attn.isLoser ? ' ROT_OUT' : '';
    const rug   = s.rugVerdict && s.rugVerdict !== 'SAFE' ? ` rug=${s.rugVerdict}` : '';
    return `${sym}: score=${score.toFixed(3)}${q}${ret}${vel}${att}${mom}${rot}${rug}`;
  }).join('\n') || 'No candidates this cycle';

  const prompt = `Market regime: ${state}
BTC ${(regime.pctFrom200 * 100).toFixed(1)}% from 200d MA | breadth: ${regime.breadthFraction} | volRatio: ${regime.volRatio.toFixed(2)}

Onchain candidates (quant score + Checkr social attention + Alchemy 1h return):
${scoreLines}

IMPORTANT: BEAR regime is CONTEXT, not a veto. Do NOT skip just because regime is BEAR.
Skip only if: no tokens have meaningful signals (quant > 0.3, velocity > 3, or sustained momentum).
BEAR regime means: prefer tokens showing genuine strength AGAINST the trend (high velocity, sustained attention, positive 1h return).
Sector rotation, social spikes, and onchain momentum can all fire in BEAR — that IS the opportunity.

Are any tokens worth passing to Venice for deeper reasoning?
Reply with JSON only — no markdown, no explanation outside the JSON:
{"skip": false, "interesting": ["TOKEN1"], "reason": "one sentence"}
or
{"skip": true, "interesting": [], "reason": "one sentence — must explain why ALL signals are weak, not just cite regime"}`;

  // Try Bankr LLM first, fall back to Anthropic Haiku on credits exhausted
  const tryLLM = async (apiUrl, headers, modelName) => {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.1
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM error ${res.status}: ${err}`);
    }
    return res.json();
  };

  let data, usedLayer;
  try {
    data = await tryLLM(BANKR_LLM_API, { 'Authorization': `Bearer ${process.env.BANKR_API_KEY}` }, BANKR_LLM_MODEL);
    usedLayer = 'bankr-llm';
  } catch(e) {
    const isCredits = e.message.includes('402') || e.message.includes('insufficient_credits') || e.message.includes('Insufficient');
    if (isCredits) {
      console.warn('[bankr-screen] Bankr LLM credits exhausted — falling back to Anthropic Haiku');
      try {
        const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
        data = await tryLLM(
          'https://api.anthropic.com/v1/messages',
          { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          'claude-haiku-4-5-20251001'
        );
        usedLayer = 'anthropic-fallback';
      } catch(e2) {
        console.warn(`[bankr-screen] Anthropic fallback also failed: ${e2.message?.slice(0,60)}`);
        return { skip: false, interesting: [], reason: `screen failed: ${e.message}`, layer: 'fallback' };
      }
    } else {
      console.warn(`[bankr-screen] Failed (${e.message}) — passing to Venice anyway`);
      return { skip: false, interesting: [], reason: `screen failed: ${e.message}`, layer: 'fallback' };
    }
  }

  try {
    const content = data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
    const clean = content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(clean);
    return {
      skip:        !!parsed.skip,
      interesting: Array.isArray(parsed.interesting) ? parsed.interesting : [],
      reason:      parsed.reason || '',
      layer:       usedLayer,
      model:       usedLayer === 'bankr-llm' ? BANKR_LLM_MODEL : 'claude-haiku-4-5-20251001',
      usage:       data.usage,
    };
  } catch(e) {
    console.warn(`[bankr-screen] JSON parse failed: ${e.message}`);
    return { skip: false, interesting: [], reason: 'screen parse failed', layer: 'fallback' };
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

  // ATR trailing stop check — runs before anything else each cycle
  if (openPositions.length) {
    const stopped = await runAtrStops(openPositions, bankr, DRY_RUN);
    if (stopped.length) {
      console.log(`[atr-stops] ${stopped.length} position(s) stopped out: ${stopped.map(s => s.sym).join(', ')}`);
      // Reload positions after stop-outs
      openPositions = journal.loadPositions().filter(p => p.status === 'open');
    }
  }

  // Live position intelligence — volume, momentum, recommendation per position
  const positionAssessments = await monitorPositions(openPositions);

  // ── STEP 3: Onchain signals — Checkr + Bankr trending ───────────────────────

  // 3c. Fetch Checkr social attention signals (pay-per-call via x402)
  let checkrAttention = {}; // sym → { attentionDelta, velocity, divergence, viral_class, rotationGain, isGainer }
  try {
    console.log('\n[checkr] Fetching multi-window attention (1h/4h/8h/12h) + spikes + rotation...');
    // Multi-window leaderboards: 1h=freshness, 4h/8h/12h=sustained momentum
    // Parallel fetch — ~$0.08 total for 4 leaderboard calls + spikes + rotation
    const [lb1h, lb4h, lb8h, lb12h, spikes, rotation] = await Promise.allSettled([
      checkr.getLeaderboard(20, 1),   // 1h fastest growers
      checkr.getLeaderboard(20, 4),   // 4h momentum
      checkr.getLeaderboard(20, 8),   // 8h sustained
      checkr.getLeaderboard(20, 12),  // 12h trend
      checkr.getSpikes(2.0),
      checkr.getRotation(1),
    ]);

    // Helper: extract token list from any window result
    function extractTokens(result) {
      if (result.status !== 'fulfilled') return [];
      return result.value?.tokens || [];
    }

    // Build multi-window momentum map: sym → { att_1h, att_4h, att_8h, att_12h, windows }
    const momentumMap = {};
    const WINDOWS = [
      { key: 'att_1h',  weight: 0.40, tokens: extractTokens(lb1h)  },
      { key: 'att_4h',  weight: 0.30, tokens: extractTokens(lb4h)  },
      { key: 'att_8h',  weight: 0.20, tokens: extractTokens(lb8h)  },
      { key: 'att_12h', weight: 0.10, tokens: extractTokens(lb12h) },
    ];
    for (const { key, weight, tokens } of WINDOWS) {
      for (const t of tokens) {
        const sym = (t.symbol || '').toUpperCase();
        if (!momentumMap[sym]) momentumMap[sym] = { windows: 0 };
        const delta = t.ATT_delta ?? 0;
        momentumMap[sym][key]    = delta;
        momentumMap[sym].windows += (delta > 0 ? 1 : 0);
        // Weighted momentum score: token appearing across multiple windows = sustained
        momentumMap[sym].momentumScore = (momentumMap[sym].momentumScore || 0) + delta * weight;
      }
    }

    // Log tokens with sustained multi-window momentum (appearing in 3+ windows)
    const sustained = Object.entries(momentumMap)
      .filter(([, d]) => d.windows >= 3)
      .sort((a, b) => b[1].momentumScore - a[1].momentumScore)
      .slice(0, 5);
    if (sustained.length) {
      console.log('[checkr] Sustained momentum (3+ windows):', sustained.map(([sym, d]) =>
        `${sym}(1h=${d.att_1h?.toFixed(2)} 4h=${d.att_4h?.toFixed(2)} 8h=${d.att_8h?.toFixed(2)} score=${d.momentumScore?.toFixed(2)})`
      ).join(' '));
    }

    // Leaderboard — 1h window sorted by ATT_delta: fastest growers first
    const lb1hTokens = extractTokens(lb1h);
    if (lb1hTokens.length) {
      const tokens = lb1hTokens;
      // Log top 3 growers by ATT_delta
      const topGrowers = [...tokens].sort((a, b) => (b.ATT_delta ?? 0) - (a.ATT_delta ?? 0)).slice(0, 3);
      if (topGrowers.length) console.log('[checkr] Top 1h growers:', topGrowers.map(t =>
        `${t.symbol}(Δ${t.ATT_delta?.toFixed(2)}pp vel=${t.velocity?.toFixed(1)})`).join(' '));
      for (const t of tokens) {
        const sym = (t.symbol || '').toUpperCase();
        // ATT_delta = change in attention share in pp — primary signal for 1h growth
        const attDelta = t.ATT_delta ?? t.ATT_delta_1h ?? t.att_delta_1h ?? 0;
        checkrAttention[sym] = {
          attentionDelta:   attDelta,
          velocity:         t.velocity ?? 0,
          divergence:       t.divergence ?? false,
          attPct:           t.ATT_pct ?? 0,
          attTrend:         t.ATT_trend_direction ?? null,
          attAccelerating:  t.ATT_accelerating ?? false,
        };
      }
    }

    // Merge multi-window momentum scores into checkrAttention
    for (const [sym, mom] of Object.entries(momentumMap)) {
      if (!checkrAttention[sym]) checkrAttention[sym] = { attentionDelta: 0, velocity: 0, divergence: false };
      checkrAttention[sym].att_1h          = mom.att_1h   || 0;
      checkrAttention[sym].att_4h          = mom.att_4h   || 0;
      checkrAttention[sym].att_8h          = mom.att_8h   || 0;
      checkrAttention[sym].att_12h         = mom.att_12h  || 0;
      checkrAttention[sym].momentumWindows = mom.windows  || 0;
      checkrAttention[sym].momentumScore   = mom.momentumScore || 0;
      // Sustained momentum: token positive across 3+ windows = strong signal
      checkrAttention[sym].sustainedMomentum = (mom.windows || 0) >= 3;
      // Boost attention delta for sustained tokens
      if (checkrAttention[sym].sustainedMomentum) {
        checkrAttention[sym].attentionDelta = Math.max(
          checkrAttention[sym].attentionDelta,
          mom.momentumScore * 0.5
        );
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
    // Pass empty fixed list — discover() will use Checkr spikes + Bankr trending as the universe
    discoveredTokens = await discover([], checkrSpikeList);

    // ── Alchemy-native discovery: scan raw Base ERC20 transfer activity ─────
    console.log('\n[discover] Alchemy onchain scan...');
    const knownSyms = [...Object.keys(checkrAttention), ...discoveredTokens.map(d => d.symbol)];
    const alchemyFound = await discoverAlchemy(knownSyms);
    for (const a of alchemyFound) {
      if (!discoveredTokens.find(d => d.symbol === a.symbol)) {
        discoveredTokens.push(a);
      }
    }

    if (discoveredTokens.length) {
      console.log(`[discover] ${discoveredTokens.length} discovery candidate(s) passed vetting:`);
      for (const d of discoveredTokens) {
        console.log(`  🔍 ${d.symbol} (${d.source}) score=${d.score.toFixed(3)} liq=$${Math.round((d.liq||0)/1000)}K age=${d.ageDays?.toFixed(1) || '?'}d`);
        // Merge into checkrAttention so Venice sees it in context
        if (!checkrAttention[d.symbol]) checkrAttention[d.symbol] = { attentionDelta: 0, velocity: 0, divergence: false };
        checkrAttention[d.symbol].discovered     = true;
        checkrAttention[d.symbol].discoveryScore = d.score;
        checkrAttention[d.symbol].discoveryLiq   = d.liq;
        checkrAttention[d.symbol].discoverySource = d.source;
        checkrAttention[d.symbol].attentionDelta += d.score * 2;
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
      // Run rug checks on all candidates (async, parallel)
      const rugResults = {};
      await Promise.all(trendingEntries.map(async t => {
        if (!t.address) return;
        try {
          const r = await rugCheck(
            { sym: t.symbol, address: t.address },
            { liquidity: t.liquidity, txnCount24h: t.txns, marketCap: t.marketCap, poolCreatedAt: t.poolCreatedAt }
          );
          rugResults[t.symbol] = r;
          t.rugScore   = r.score;
          t.rugVerdict = r.verdict;
          t.rugFlags   = r.flags;
          t.rugPass    = r.pass;
        } catch(e) {
          console.warn(`[rug_check] ${t.symbol} failed: ${e.message?.slice(0,40)}`);
        }
      }));
      // Filter out likely rugs before Venice sees them
      const before = trendingEntries.length;
      trendingEntries = trendingEntries.filter(t => !t.rugPass === false || t.rugScore === undefined || t.rugScore >= 40);
      const removed = before - trendingEntries.length;
      if (removed > 0) console.log(`[rug_check] Filtered ${removed} likely rug(s)`);

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
  const screen = await bankrScreen(regime, ranked, checkrAttention, trendingEntries);
  console.log(`[bankr-screen] skip=${screen.skip} | interesting=[${screen.interesting.join(',')}] | "${screen.reason}" (${screen.layer})`);

  if (screen.skip) {
    console.log('[bankr-screen] Skip signal → no trade this cycle');
    // Smart yield rebalance only if surplus above 25% reserve exists
    if (!DRY_RUN) {
      const balances = await bankr.getBalances().catch(() => null);
      const usdcLiquid = (() => {
        if (!balances) return 0;
        for (const line of balances.split('\n')) {
          const t = line.trim().replace(/^[•·\-]\s*/,'');
          if (/usd.?coin|usdc/i.test(t)) { const m = t.match(/\$\(?([0-9]+\.?[0-9]*)\)?/); if (m) return parseFloat(m[1]); }
        }
        return 0;
      })();
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

    // 5a. Multi-timeframe enrichment — run 5m + 4h + onchain on Bankr-screen finalists only
  // screen.interesting = the tokens that passed pre-filter (typically 2-3)
  const finalistSyms = new Set(screen.interesting || []);
  const topCandidates = trendingEntries.filter(t => finalistSyms.has(t.symbol));

  if (topCandidates.length > 0) {
    console.log(`\n[multi_tf] Enriching ${topCandidates.length} finalists with 5m/4h/onchain signals: [${topCandidates.map(t=>t.symbol).join(',')}]`);
    const btcBars = regime.btcHourly || [];
    for (const t of topCandidates) {
      try {
        const alchSignal = t.alchemySignal || null;
        const mtf = await scoreMultiTF(t.symbol, t.contractAddress || t.address, alchSignal, btcBars);
        if (mtf.score != null) {
          t.multiTFScore    = mtf.score;
          t.scoreH          = mtf.scoreH;
          t.score5m         = mtf.score5m;
          t.scoreOnchain    = mtf.scoreOC;
          t.score4h         = mtf.score4h;
          t.multiTFBreakdown = mtf.breakdown;
          // Blend original score with multi-TF (60/40)
          t.score = parseFloat((0.60 * (t.score || 0) + 0.40 * mtf.score).toFixed(3));
          console.log(`  [multi_tf] ${t.symbol}: blended=${t.score.toFixed(3)} | ${mtf.breakdown}`);
        }
      } catch(e) {
        console.warn(`  [multi_tf] ${t.symbol} failed: ${e.message?.slice(0,50)}`);
      }
    }
  }

    // 5b. Build Venice context — onchain-first, position-aware
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
        const mom = a.sustainedMomentum
          ? ` 🔥SUSTAINED(${a.momentumWindows}w score=${a.momentumScore?.toFixed(2)} 4h=${a.att_4h?.toFixed(2)} 8h=${a.att_8h?.toFixed(2)} 12h=${a.att_12h?.toFixed(2)})`
          : (a.att_4h > 0 || a.att_8h > 0) ? ` multi(4h=${a.att_4h?.toFixed(2)} 8h=${a.att_8h?.toFixed(2)})` : '';
        return `${sym}: vel=${(a.velocity||0).toFixed(1)} Δ1h=${(a.attentionDelta||0).toFixed(2)}pp div=${a.divergence?'YES':'no'}${trend}${mom}${rot}`;
      }).join('\n')
  : 'Checkr unavailable this cycle'}

## 🔥 Onchain Trending Entries (Base — Alchemy price data + transfer stats)
These are Base tokens currently trending onchain. NOT in fixed universe. Execution via Bankr swap by contract address.
${trendingEntries.length
  ? trendingEntries.map(t => {
      const mtf = t.multiTFBreakdown ? ` | MTF=[${t.multiTFBreakdown}]` : '';
      const ret1h = t.ret1h != null ? (t.ret1h*100).toFixed(1) : '?';
      const ret6h = t.ret6h != null ? (t.ret6h*100).toFixed(1) : '?';
      return `${t.symbol} | score=${t.score?.toFixed(2)||'?'}${mtf} | rank=${t.rank||'?'} | ret1h=${ret1h}% ret6h=${ret6h}% | move=${t.moveFrac!=null?(t.moveFrac*100).toFixed(0)+'%done':'?'} | liq=$${Math.round((t.liquidity||0)/1000)}K | buyers=${t.transferStats?.uniqueBuyers||'?'} buyRatio=${t.transferStats?.buyRatio?.toFixed(2)||'?'} | rug=${t.rugVerdict||'?'}(${t.rugScore||'?'}/100) | addr=${t.address||'?'}`;
    }).join('\n')
  : 'No high-conviction trending entries this cycle'}
If a trending token has score≥0.65 and move<50%done: consider BUY with $10–$15 size. MTF=[1h|5m|onchain|4h] shows multi-timeframe signal alignment — all positive = strong conviction.

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
    const usdcLiquid = (() => {
      if (!balances) return 0;
      for (const line of balances.split('\n')) {
        const t = line.trim().replace(/^[•·\-]\s*/,'');
        if (/usd.?coin|usdc/i.test(t)) { const m = t.match(/\$\(?([0-9]+\.?[0-9]*)\)?/); if (m) return parseFloat(m[1]); }
      }
      return 0;
    })();
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
    // ── Pre-trade yield check ─────────────────────────────────
    // If we have a strong buy signal but not enough liquid USDC,
    // check yield position and decide whether to pull funds
    if (decision.action === 'buy' || decision.action === 'long') {
      const liveBal = await bankr.getBalances().catch(() => null);
      const liveLiquid = (() => {
        if (!liveBal) return 0;
        for (const line of liveBal.split('\n')) {
          const t = line.trim().replace(/^[•·\-]\s*/,'');
          if (/usd.?coin|usdc/i.test(t)) { const m = t.match(/\$\(?([0-9]+\.?[0-9]*)\)?/); if (m) return parseFloat(m[1]); }
        }
        return 0;
      })();

      if (liveLiquid < 10) {
        // Not enough for minimum $10 trade — check yield
        console.log(`\n[yield] Only $${liveLiquid.toFixed(2)} liquid USDC — checking yield position...`);
        const yieldState = await bankr.getYieldState().catch(() => null);

        if (yieldState?.hasYield && yieldState.amountUSD >= 10) {
          // Decision: pull from yield if confidence >= 75 (high conviction trade)
          if (decision.confidence >= 75) {
            // Pull one trade's worth from yield (Kelly-sized % of yield balance, max 50%)
            const tradeSizeUSD = Math.round(decision.size_pct / 100 * ACTIVE_TRANCHE_USD);
            const withdrawPct  = Math.min(0.5, tradeSizeUSD / yieldState.amountUSD);
            const withdrawAmt  = parseFloat((yieldState.amountUSD * withdrawPct).toFixed(2));
            console.log(`[yield] High conviction (${decision.confidence}%) — withdrawing ${(withdrawPct*100).toFixed(0)}% ($${withdrawAmt.toFixed(2)}) of yield from ${yieldState.protocol} (APY ${yieldState.apy}%) for trade`);
            try {
              await bankr.withdrawYieldForTrade(withdrawAmt, withdrawPct);
              console.log(`[yield] ✅ Withdrew ${(withdrawPct*100).toFixed(0)}% ($${withdrawAmt.toFixed(2)}) — proceeding with trade`);
            } catch(e) {
              console.warn(`[yield] Withdrawal failed: ${e.message} — skipping trade`);
              decision = { ...decision, action: 'hold', reasoning: `Yield withdrawal failed, no liquid USDC for trade` };
            }
          } else {
            console.log(`[yield] Confidence ${decision.confidence}% < 75% — not worth pulling from yield (${yieldState.protocol} ${yieldState.apy}% APY). Holding.`);
            decision = { ...decision, action: 'hold', reasoning: `Insufficient liquid USDC ($${liveLiquid.toFixed(2)}) and confidence (${decision.confidence}%) too low to pull from yield` };
          }
        } else {
          console.log(`[yield] No yield position or insufficient yield balance — skipping trade`);
          decision = { ...decision, action: 'hold', reasoning: `Insufficient liquid USDC ($${liveLiquid.toFixed(2)}) and no yield to pull from` };
        }
      }
    }

    // Block re-entry if we already have an open position in this asset
    const alreadyOpen = openPositions.find(p => p.sym === decision.asset && p.status === 'open');
    if (alreadyOpen) {
      console.log(`[bankr] Already have open position in ${decision.asset} — skipping re-entry`);
      return;
    }

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

      // Resolve contract address from GeckoTerminal if not already set (avoids Bankr ambiguity on symbol lookup)
      let resolvedDecision = { ...decision, size_pct: Math.round(finalSizeUsd / ACTIVE_TRANCHE_USD * 100) };
      if (!resolvedDecision.contractAddress && resolvedDecision.asset) {
        try {
          const searchRes = await new Promise((res2) => {
            const https2 = require('https');
            const url = `https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/search?query=${encodeURIComponent(resolvedDecision.asset)}&include=top_pools`;
            https2.get(url, { headers: { Accept: 'application/json' } }, r => {
              let d = ''; r.on('data', c => d += c);
              r.on('end', () => { try { res2(JSON.parse(d)); } catch { res2({}); } });
            }).on('error', () => res2({}));
          });
          const tokens = searchRes?.data || [];
          // Pick highest liquidity match
          const best = tokens
            .filter(t => t.attributes?.symbol?.toUpperCase() === resolvedDecision.asset.toUpperCase())
            .sort((a, b) => (b.attributes?.total_reserve_in_usd || 0) - (a.attributes?.total_reserve_in_usd || 0))[0];
          if (best?.attributes?.address) {
            resolvedDecision.contractAddress = best.attributes.address;
            console.log(`[contract] Resolved ${resolvedDecision.asset} → ${resolvedDecision.contractAddress} (liq=$${Math.round((best.attributes.total_reserve_in_usd||0)/1000)}K)`);
          }
        } catch(e) { console.warn(`[contract] Symbol lookup failed for ${resolvedDecision.asset}: ${e.message?.slice(0,50)}`); }
      }

      // Override Venice's size_pct with Kelly-computed size
      const kellyDecision = resolvedDecision;
      const result = await bankr.execute(kellyDecision, ACTIVE_TRANCHE_USD);
      console.log(`[bankr] ✓ ${result.response || JSON.stringify(result)}`);

      // Verify trade actually executed — wait 8s then check Alchemy balanceOf
      // Only record position if tokens actually landed in wallet
      let tradeConfirmed = false;
      if (decision.action === 'buy' || decision.action === 'long') {
        const contractAddr = kellyDecision.contractAddress;
        if (contractAddr) {
          console.log('[bankr] Waiting 8s for on-chain confirmation...');
          await new Promise(r => setTimeout(r, 8000));
          const onchainBal = await (async () => {
            const key = process.env.ALCHEMY_KEY;
            if (!key) return null;
            const data = '0x70a08231' + '0xed2ceca9de162c4f2337d7c1ab44ee9c427709da'.slice(2).padStart(64,'0');
            const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{to:contractAddr, data},'latest'] });
            return new Promise(res => {
              const req = require('https').request({ hostname:'base-mainnet.g.alchemy.com', path:`/v2/${key}`, method:'POST',
                headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, r2 => {
                let d=''; r2.on('data',c=>d+=c); r2.on('end',()=>{ try{const h=JSON.parse(d).result; res(h&&h!=='0x'?parseInt(h,16):0);}catch{res(null);} });
              });
              req.on('error',()=>res(null)); req.setTimeout(8000,()=>{req.destroy();res(null);});
              req.write(body); req.end();
            });
          })();
          // Primary: trust Bankr response if it explicitly says "swapped"
          const bankrResponseText = (result.response || '').toLowerCase();
          const bankrConfirmed = /swapped|bought|purchased|executed/.test(bankrResponseText);
          if (bankrConfirmed) {
            tradeConfirmed = true;
            console.log(`[bankr] ✅ Confirmed via Bankr response ("${bankrResponseText.slice(0,60)}")`);
          } else if (onchainBal !== null && onchainBal > 0) {
            tradeConfirmed = true;
            console.log(`[bankr] ✅ On-chain confirmed: ${decision.asset} balance=${onchainBal} (raw tokens)`);
          } else if (onchainBal === 0 && !bankrConfirmed) {
            console.warn(`[bankr] ⚠️ Trade NOT confirmed — balance=0 and Bankr response unclear for ${decision.asset}.`);
          } else {
            tradeConfirmed = true;
            console.warn(`[bankr] ⚠️ Could not verify on-chain — assuming confirmed`);
          }
        } else {
          // No contract address (majors like ETH, SOL) — trust Bankr response
          tradeConfirmed = true;
        }
      }

      // Record entry + compute dynamic trailing stop
      if ((decision.action === 'buy' || decision.action === 'long') && tradeConfirmed) {
        const entryPrice = await bankr.getPrice(decision.asset).catch(() => 0);
        const stopConfig = { trailPct: 5, activateAt: 1, rationale: 'Bankr native 5% trailing stop' };
        console.log(`[stops] ${decision.asset} trail=${stopConfig.trailPct}% activate=${stopConfig.activateAt}% | ${stopConfig.rationale}`);

        // Resolve correct contract address: GeckoTerminal highest-liquidity pool
        let resolvedContract = decision.contractAddress || null;
        if (resolvedContract && resolvedContract !== 'undefined') {
          try {
            const poolsRes = await new Promise((res, rej) => {
              const https2 = require('https');
              https2.get(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${resolvedContract}/pools?page=1`,
                { headers: { Accept: 'application/json' } }, r => {
                  let d = ''; r.on('data', c => d += c);
                  r.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } });
                }).on('error', rej);
            });
            const pools = poolsRes?.data || [];
            const best = pools
              .filter(p => (p.attributes?.reserve_in_usd || 0) > 10000)
              .sort((a, b) => (b.attributes?.reserve_in_usd || 0) - (a.attributes?.reserve_in_usd || 0))[0];
            if (best?.relationships?.base_token?.data?.id) {
              const confirmed = best.relationships.base_token.data.id.replace('base_', '');
              if (confirmed && confirmed !== resolvedContract) {
                console.log(`[contract] ${decision.asset}: corrected ${resolvedContract} → ${confirmed} (liq=$${Math.round(best.attributes.reserve_in_usd/1000)}K)`);
              }
              resolvedContract = confirmed;
            }
          } catch(e) { console.warn(`[contract] lookup failed for ${decision.asset}: ${e.message}`); }
        }

        journal.recordEntry(decision.asset, entryPrice, finalSizeUsd, {
          regime:          regime.state,
          confidence:      decision.confidence,
          contractAddress: resolvedContract,
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
    trendingEntries: trendingEntries.map(t => {
      const ca = checkrAttention[t.symbol] || {};
      return {
        symbol:           t.symbol,
        score:            t.score,
        rank:             t.rank,
        source:           t.source || 'bankr',
        ret1h:            t.ret1h,
        moveFrac:         t.moveFrac,
        quantScore:       t.quantScore,
        rugVerdict:       t.rugVerdict || null,
        rugScore:         t.rugScore   || null,
        // Checkr signals
        attentionDelta:   ca.attentionDelta   || 0,
        velocity:         ca.velocity         || 0,
        att_1h:           ca.att_1h           || 0,
        att_4h:           ca.att_4h           || 0,
        att_8h:           ca.att_8h           || 0,
        att_12h:          ca.att_12h          || 0,
        momentumWindows:  ca.momentumWindows  || 0,
        sustainedMomentum: ca.sustainedMomentum || false,
        rotatingFrom:     ca.rotating_from    || ca.rotatingFrom || [],
        // Multi-timeframe scores
        multiTFScore:     t.multiTFScore      || null,
        scoreH:           t.scoreH            || null,
        score5m:          t.score5m           || null,
        scoreOnchain:     t.scoreOnchain      || null,
        score4h:          t.score4h           || null,
        multiTFBreakdown: t.multiTFBreakdown  || null,
      };
    }),
    positionAssessments: positionAssessments.map(p => ({
      sym:           p.sym,
      currentPrice:  p.currentPrice,
      entryPrice:    p.entryPrice,
      pnlPct:        p.pnlPct,
      quantScore:    p.quantScore,
      volumeTrend:   p.volumeTrend,
      recommendation: p.recommendation,
      ret1h:         p.ret1h,
      ret6h:         p.ret6h,
      transferStats: p.transferStats ? {
        uniqueBuyers:          p.transferStats.uniqueBuyers,
        repeatBuyers:          p.transferStats.repeatBuyers,
        topBuyerConcentration: p.transferStats.topBuyerConcentration,
        buyRatio:              p.transferStats.buyRatio,
      } : null,
    })),
    screen,
    decision,
    dry_run: DRY_RUN,
    // Data sources summary (for site display)
    dataSources: {
      checkrTokens:    Object.keys(checkrAttention).length,
      checkrSustained: Object.entries(checkrAttention)
        .filter(([,a]) => a.sustainedMomentum || (a.momentumWindows >= 2))
        .map(([sym,a]) => ({ sym, att1h: a.att_1h, att4h: a.att_4h, velocity: a.velocity, windows: a.momentumWindows }))
        .slice(0, 6),
      discoveryPassed: trendingEntries.length,
    },
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

  // ── End-of-cycle yield rebalance check ───────────────────────
  // Every cycle: check if current yield protocol is still best
  // (this runs regardless of trade/skip — always optimise idle capital)
  if (!DRY_RUN) {
    try {
      const liveBal2 = await bankr.getBalances().catch(() => null);
      const liveLiquid2 = (() => {
        if (!liveBal2) return 0;
        for (const line of liveBal2.split('\n')) {
          const t = line.trim().replace(/^[•·\-]\s*/,'');
          if (/usd.?coin|usdc/i.test(t)) { const m = t.match(/\$\(?([0-9]+\.?[0-9]*)\)?/); if (m) return parseFloat(m[1]); }
        }
        return 0;
      })();
      const surplus = liveLiquid2 - ACTIVE_TRANCHE_USD;
      if (surplus >= 5) {
        console.log(`\n[yield] $${surplus.toFixed(2)} USDC surplus — running yield rebalance check...`);
        const yResult = await bankr.smartYieldRebalance();
        console.log(`[yield] ${yResult.slice(0, 120)}`);
      }
    } catch(e) { console.warn(`[yield] Rebalance check failed: ${e.message?.slice(0,50)}`); }
  }

  // Auto top-up Bankr LLM credits when low (agent pays for its own compute)
  try {
    const { execSync } = require('child_process');
    const bankrCli = require('os').homedir() + '/.local/bin/bankr';
    const credOut = execSync(`BANKR_API_KEY=${process.env.BANKR_API_KEY} ${bankrCli} llm credits`, { timeout: 10000 }).toString();
    const match = credOut.match(/Credit Balance:\s+\$([0-9.]+)/);
    const credits = match ? parseFloat(match[1]) : null;
    console.log(`[llm-credits] Balance: $${credits ?? '?'}`);
    if (credits !== null && credits < 5) {
      console.log(`[llm-credits] Low ($${credits}) — topping up $5 from wallet...`);
      const result = execSync(`BANKR_API_KEY=${process.env.BANKR_API_KEY} ${bankrCli} llm credits add 5 --yes`, { timeout: 30000 }).toString();
      const newBal = result.match(/New Balance:\s+\$([0-9.]+)/)?.[1];
      console.log(`[llm-credits] ✅ Topped up — new balance: $${newBal ?? '?'}`);
    }
  } catch(e) { console.warn('[llm-credits] Check failed:', e.message?.slice(0, 60)); }

  // Publish live status to delu-site repo (Vercel reads this)
  try {
    const { publish } = require('./publish_status');
    await publish(regime, balanceResp);
    try { const { publishResearch } = require('./publish_research'); await publishResearch(); } catch(e) { console.warn('[research] publish failed:', e.message?.slice(0,50)); }
    try { const { run } = require('./publish_brain'); run(); } catch(e) { console.warn('[brain] publish failed:', e.message?.slice(0,50)); }
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
    // Align to :05 and :35 of each hour (Checkr refreshes at :00 and :30)
    function scheduleNext() {
      const now = new Date();
      const min = now.getUTCMinutes();
      const sec = now.getUTCSeconds();
      const msIntoHour = (min * 60 + sec) * 1000 + now.getUTCMilliseconds();
      const target5  = 5  * 60 * 1000;
      const target35 = 35 * 60 * 1000;
      let msUntilNext;
      if (msIntoHour < target5) {
        msUntilNext = target5 - msIntoHour;
      } else if (msIntoHour < target35) {
        msUntilNext = target35 - msIntoHour;
      } else {
        msUntilNext = 60 * 60 * 1000 - msIntoHour + target5;
      }
      const nextAt = new Date(Date.now() + msUntilNext);
      console.log(`\nNext cycle: ${nextAt.toISOString()} (in ${Math.round(msUntilNext/60000)} min)`);
      setTimeout(async () => {
        await runCycle();
        scheduleNext();
      }, msUntilNext);
    }
    scheduleNext();
  }
}

main().catch(e => { console.error('Fatal:', e.stack); process.exit(1); });
