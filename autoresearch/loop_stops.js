/**
 * loop_stops.js — Autoresearch loop for ATR trailing stop parameters
 *
 * Evolves the optimal combination of:
 *   - atrMult:       ATR multiplier for trail (e.g. 2.5× ATR from peak)
 *   - hardSlAtrMult: ATR multiplier for pre-trail hard SL (e.g. 3×ATR)
 *   - hardSlMinPct:  Minimum hard SL % for micro-caps (e.g. 8%)
 *   - hardSlMaxPct:  Absolute floor / max loss % (e.g. 15%)
 *   - activateAt:    % gain required to activate trail (e.g. 0.5%)
 *
 * Backtests on real Base token 1h price history from Alchemy.
 * Metric: avg PnL per trade, win rate, Sharpe of closed trades.
 *
 * Runs forever, logs best params to state_stops.json.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

const DIR        = path.join(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state_stops.json');
const EXP_FILE   = path.join(__dirname, 'experiments_stops.json');
const LOG        = '/tmp/autoresearch_stops.log';

// ── LLM setup (Bankr gateway → Anthropic Haiku fallback) ──────
const BANKR_KEY     = (process.env.BANKR_API_KEY      || '').replace(/\s/g, '');
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY  || '').replace(/\s/g, '');
const MODEL         = 'claude-haiku-4-5-20251001';

function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19)} UTC] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

// ── State ──────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch {
    return {
      expCount: 0,
      bestScore: -Infinity,
      bestParams: {
        atrMult:       2.5,
        hardSlAtrMult: 3.0,
        hardSlMinPct:  8,
        hardSlMaxPct:  15,
        activateAt:    0.5,
      },
      bestWinRate: 0,
      bestAvgPnl:  0,
    };
  }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function loadExperiments() {
  try { return JSON.parse(fs.readFileSync(EXP_FILE, 'utf8')); } catch { return []; }
}
function saveExperiment(exp) {
  const exps = loadExperiments();
  exps.push(exp);
  fs.writeFileSync(EXP_FILE, JSON.stringify(exps.slice(-500), null, 2)); // keep last 500
}

// ── Load real price history ────────────────────────────────────
// Use Alchemy price cache already on disk
function loadPriceHistory() {
  const histDir = path.join(DIR, 'data/history_onchain');
  const tokens  = [];
  try {
    const files = fs.readdirSync(histDir).filter(f => f.endsWith('_alchemy_1h.json'));
    for (const file of files) {
      try {
        const d    = JSON.parse(fs.readFileSync(path.join(histDir, file), 'utf8'));
        const sym  = d.sym || file.replace('_alchemy_1h.json', '');
        const bars = d.bars || d;
        if (Array.isArray(bars) && bars.length >= 30) {
          // Normalise bar format: {ts, open, high, low, close, volume}
          const norm = bars.map(b => ({
            high:  b.high  || b.h || b.close || b.c,
            low:   b.low   || b.l || b.close || b.c,
            close: b.close || b.c,
          })).filter(b => b.close > 0);
          if (norm.length >= 30) tokens.push({ sym, bars: norm });
        }
      } catch {}
    }
  } catch {}
  return tokens;
}

// ── ATR calculation ────────────────────────────────────────────
function calcATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high || bars[i].close;
    const l = bars[i].low  || bars[i].close;
    const pc = bars[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((s,v) => s+v, 0) / period;
}

// ── Backtest a single entry with given stop params ─────────────
// Simulates holding from bar `entryIdx` until stop triggers or 72h max
function simulateTrade(bars, entryIdx, params) {
  const { atrMult, hardSlAtrMult, hardSlMinPct, hardSlMaxPct, activateAt } = params;
  const entryPrice = bars[entryIdx].close;
  if (!entryPrice || entryPrice <= 0) return null;

  // ATR at entry
  const barsForATR = bars.slice(0, entryIdx + 1);
  const atr = calcATR(barsForATR);

  // Hard SL price
  const hardSlAtr  = atr ? entryPrice - hardSlAtrMult * atr : null;
  const hardSlMin  = entryPrice * (1 - hardSlMinPct / 100);
  const hardSlMax  = entryPrice * (1 - hardSlMaxPct / 100); // absolute floor
  const hardSlPrice = hardSlAtr
    ? Math.max(Math.min(hardSlAtr, hardSlMin), hardSlMax)
    : Math.max(hardSlMin, hardSlMax);

  let peakPrice = entryPrice;
  let trailActive = false;
  const maxBars = Math.min(72, bars.length - entryIdx - 1); // 72h max hold

  for (let i = 1; i <= maxBars; i++) {
    const bar  = bars[entryIdx + i];
    const low  = bar.low  || bar.close;
    const high = bar.high || bar.close;
    const close = bar.close;

    // Update peak
    if (high > peakPrice) peakPrice = high;
    const peakPct = (peakPrice - entryPrice) / entryPrice * 100;

    // Check trail activation
    if (peakPct >= activateAt) trailActive = true;

    // Calculate stop price
    let stopPrice;
    if (trailActive && atr) {
      stopPrice = peakPrice - atrMult * atr;
      stopPrice = Math.max(stopPrice, hardSlPrice); // floor
    } else if (trailActive) {
      stopPrice = peakPrice * 0.95; // 5% fallback
    } else {
      stopPrice = hardSlPrice;
    }

    // Check if low touched stop (use low for realism)
    if (low <= stopPrice) {
      const pnlPct = (stopPrice - entryPrice) / entryPrice * 100;
      return { pnlPct, bars: i, trailActive, exitReason: trailActive ? 'trail' : 'hardSL' };
    }

    // Time stop at 72h
    if (i === maxBars) {
      const pnlPct = (close - entryPrice) / entryPrice * 100;
      return { pnlPct, bars: i, trailActive, exitReason: 'timeStop' };
    }
  }
  return null;
}

// ── Backtest params across all tokens ─────────────────────────
function backtest(params, tokens) {
  const trades = [];

  for (const { sym, bars } of tokens) {
    // Sample entry points: every 12h, skip first 20 bars (need ATR warmup)
    for (let i = 20; i < bars.length - 72; i += 12) {
      const trade = simulateTrade(bars, i, params);
      if (trade) trades.push({ sym, ...trade });
    }
  }

  if (trades.length < 10) return { score: -99, winRate: 0, avgPnl: 0, trades: trades.length };

  const pnls   = trades.map(t => t.pnlPct);
  const wins   = pnls.filter(p => p > 0).length;
  const avgPnl = pnls.reduce((s,p) => s+p, 0) / pnls.length;
  const std    = Math.sqrt(pnls.reduce((s,p) => s + (p - avgPnl)**2, 0) / pnls.length);
  const sharpe = std > 0 ? (avgPnl / std) * Math.sqrt(365 * 24 / 12) : 0; // annualised

  const winRate    = wins / trades.length;
  const trailPct   = trades.filter(t => t.exitReason === 'trail').length / trades.length;
  const hardSlPct2 = trades.filter(t => t.exitReason === 'hardSL').length / trades.length;

  // Score: Sharpe weighted by win rate and avg PnL
  const score = sharpe * 0.5 + winRate * 10 + avgPnl * 0.5;

  return { score, sharpe, winRate, avgPnl, std, trades: trades.length, trailPct, hardSlPct: hardSlPct2 };
}

// ── LLM mutation ──────────────────────────────────────────────
async function proposeParams(current, recentExps) {
  const recentSummary = recentExps.slice(-6).map(e =>
    `params=${JSON.stringify(e.params)} score=${e.score?.toFixed(2)} winRate=${(e.winRate*100).toFixed(0)}% avgPnl=${e.avgPnl?.toFixed(2)}%`
  ).join('\n');

  const prompt = `You are optimizing ATR trailing stop parameters for a crypto trading agent on Base micro-cap tokens.

Current best params (score=${current.bestScore?.toFixed(2)}):
${JSON.stringify(current.bestParams, null, 2)}

Recent experiments:
${recentSummary || 'none yet'}

Parameter ranges:
- atrMult: 1.5–5.0 (ATR multiplier for trail, higher = wider trail = fewer stops)
- hardSlAtrMult: 1.0–5.0 (ATR multiplier for pre-trail hard SL)
- hardSlMinPct: 5–20 (minimum hard SL % floor for micro-caps)
- hardSlMaxPct: 10–30 (absolute maximum loss % cap)
- activateAt: 0.2–3.0 (% gain needed to activate trail, lower = trail kicks in sooner)

Goal: maximize score = Sharpe×0.5 + winRate×10 + avgPnl×0.5
Micro-cap tokens are volatile — too tight = stopped on noise, too wide = large losses.

Propose ONE small change to ONE parameter. Reply with ONLY valid JSON:
{"param": "paramName", "value": number, "reasoning": "one sentence"}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    // Try Bankr LLM first
    const tryBankr = () => new Promise((res2) => {
      if (!BANKR_KEY) return res2(null);
      const bankrBody = JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
      const req2 = https.request({
        hostname: 'llm.bankr.bot', path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BANKR_KEY}`, 'Content-Length': Buffer.byteLength(bankrBody) },
      }, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
          try { const j = JSON.parse(d); const t = j.choices?.[0]?.message?.content || ''; const m = t.match(/\{[\s\S]*\}/); res2(m ? JSON.parse(m[0]) : null); }
          catch { res2(null); }
        });
      });
      req2.on('error', () => res2(null));
      req2.setTimeout(15000, () => { req2.destroy(); res2(null); });
      req2.write(bankrBody); req2.end();
    });

    const bankrResult = await tryBankr();
    if (bankrResult) return resolve(bankrResult);

    // Anthropic fallback
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          const text = r.content?.[0]?.text || '';
          const m = text.match(/\{[\s\S]*\}/);
          if (m) resolve(JSON.parse(m[0]));
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Main loop ─────────────────────────────────────────────────
async function main() {
  log('Stop params autoresearch starting...');
  const tokens = loadPriceHistory();
  log(`Loaded ${tokens.length} tokens with price history`);

  if (tokens.length < 3) {
    log('Not enough price history — exiting');
    return;
  }

  const state = loadState();
  log(`Current best: score=${state.bestScore?.toFixed(2)} params=${JSON.stringify(state.bestParams)}`);

  // Baseline
  if (state.expCount === 0) {
    const baseline = backtest(state.bestParams, tokens);
    log(`Baseline: score=${baseline.score?.toFixed(2)} winRate=${(baseline.winRate*100).toFixed(0)}% avgPnl=${baseline.avgPnl?.toFixed(2)}% trades=${baseline.trades}`);
    state.bestScore   = baseline.score;
    state.bestWinRate = baseline.winRate;
    state.bestAvgPnl  = baseline.avgPnl;
    saveState(state);
  }

  while (true) {
    state.expCount++;
    const exps = loadExperiments();

    // Ask LLM to propose a mutation
    let proposal = await proposeParams(state, exps);
    if (!proposal || !proposal.param || proposal.value == null) {
      log(`Exp ${state.expCount}: LLM returned null — random perturbation`);
      proposal = {};
      // Random fallback
      const keys = Object.keys(state.bestParams);
      const key  = keys[Math.floor(Math.random() * keys.length)];
      const ranges = {
        atrMult:       [1.5, 5.0],
        hardSlAtrMult: [1.0, 5.0],
        hardSlMinPct:  [5,   20 ],
        hardSlMaxPct:  [10,  30 ],
        activateAt:    [0.2, 3.0],
      };
      const [lo, hi] = ranges[key];
      const delta = (Math.random() - 0.5) * (hi - lo) * 0.2;
      const val = Math.max(lo, Math.min(hi, state.bestParams[key] + delta));
      proposal.param     = key;
      proposal.value     = parseFloat(val.toFixed(2));
      proposal.reasoning = 'random perturbation';
    }

    // Apply mutation
    const newParams = { ...state.bestParams, [proposal.param]: proposal.value };
    const result    = backtest(newParams, tokens);

    const improved = result.score > state.bestScore;
    if (improved) {
      state.bestScore   = result.score;
      state.bestParams  = newParams;
      state.bestWinRate = result.winRate;
      state.bestAvgPnl  = result.avgPnl;
      log(`Exp ${state.expCount}: ✅ NEW BEST score=${result.score.toFixed(2)} | ${proposal.param}=${proposal.value} (${proposal.reasoning}) | winRate=${(result.winRate*100).toFixed(0)}% avgPnl=${result.avgPnl.toFixed(2)}% sharpe=${result.sharpe?.toFixed(2)} trades=${result.trades}`);
      saveState(state);

      // Auto-promote best params to position_monitor.js
      try {
        const pmPath = require('path').join(__dirname, '../agent/position_monitor.js');
        let pm = require('fs').readFileSync(pmPath, 'utf8');
        pm = pm.replace(/const ATR_MULT\s*=\s*[\d.]+;/, `const ATR_MULT        = ${newParams.atrMult};`);
        pm = pm.replace(/const HARD_SL_ATR_MULT\s*=\s*[\d.]+;/, `const HARD_SL_ATR_MULT = ${newParams.hardSlAtrMult};`);
        pm = pm.replace(/const HARD_SL_MIN_PCT\s*=\s*[\d.]+;/, `const HARD_SL_MIN_PCT  = ${newParams.hardSlMinPct};`);
        pm = pm.replace(/const HARD_SL_MAX_PCT\s*=\s*[\d.]+;/, `const HARD_SL_MAX_PCT  = ${newParams.hardSlMaxPct};`);
        pm = pm.replace(/const ACTIVATE_AT\s*=\s*[\d.]+;/, `const ACTIVATE_AT      = ${newParams.activateAt};`);
        require('fs').writeFileSync(pmPath, pm);
        log(`   🎯 Promoted to position_monitor.js`);
      } catch(e) { log(`   Promote failed: ${e.message}`); }
    } else {
      log(`Exp ${state.expCount}: score=${result.score.toFixed(2)} (best=${state.bestScore.toFixed(2)}) | ${proposal.param}=${proposal.value} | winRate=${(result.winRate*100).toFixed(0)}% avgPnl=${result.avgPnl.toFixed(2)}%`);
    }

    saveExperiment({
      expN: state.expCount,
      params: newParams,
      score: result.score,
      sharpe: result.sharpe,
      winRate: result.winRate,
      avgPnl: result.avgPnl,
      trades: result.trades,
      improved,
      proposal,
    });

    // Small delay to avoid hammering Anthropic
    await new Promise(r => setTimeout(r, 3000));
  }
}

// Load .env
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
