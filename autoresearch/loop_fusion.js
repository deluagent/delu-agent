/**
 * loop_fusion.js — Cross-TF weight fusion autoresearch
 *
 * Replaces the daily loop. Evolves the blend weights for:
 *   - scoreH   (hourly quant_score)
 *   - score5m  (5m momentum)
 *   - scoreOC  (onchain smart wallet)
 *   - score4h  (4h momentum)
 * Per regime: BEAR, BULL, RANGE
 *
 * Also evolves:
 *   - minSignalsRequired: how many TFs must agree before entry
 *   - vetoWhaleConc: whether whale concentration >X vetoes regardless of score
 *   - onchainVetoWeight: how much onchain alone can block a trade
 *
 * Promoted params → autoresearch/state_fusion.json
 * multi_tf_score.js reads state_fusion.json at runtime for live weights
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ── LLM setup (Bankr gateway → Anthropic Haiku fallback) ─────────────────────
const BANKR_KEY    = process.env.BANKR_API_KEY;
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
const BANKR_MODEL  = 'claude-haiku-4-5-20251001';
const BANKR_LLM    = 'https://llm.bankr.bot/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const DIR        = path.join(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state_fusion.json');
const EXP_FILE   = path.join(__dirname, 'experiments_fusion.json');
const LIVE_FILE  = path.join(__dirname, 'live_feedback.json');
const HISTORY_DIR = path.join(DIR, 'data', 'history_onchain');

// Load candidate scoring functions
const { scoreTokenHourly: scoreHourly } = require('../agent/quant_score');

// candidate_5m and candidate_onchain use helper functions defined in their loop context
// We need to wrap them with the helpers they depend on
function loadCandidateWithHelpers(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const helpers = `
    function rsi(prices, period=14) {
      if (prices.length < period+1) return 50;
      let gains=0,losses=0;
      for(let i=prices.length-period;i<prices.length;i++){const d=prices[i]-prices[i-1];if(d>0)gains+=d;else losses-=d;}
      gains/=period;losses/=period;
      if(losses===0)return 100;
      return 100-(100/(1+gains/losses));
    }
    function sma(prices, period) {
      if(prices.length<period)return prices[prices.length-1]||0;
      return prices.slice(-period).reduce((a,b)=>a+b,0)/period;
    }
    function ema(prices, period) {
      if(!prices.length)return 0;
      const k=2/(period+1);let e=prices[0];
      for(let i=1;i<prices.length;i++)e=prices[i]*k+e*(1-k);
      return e;
    }
    function realizedVol(prices, period=14) {
      const p=prices.slice(-period-1);
      if(p.length<2)return 0;
      const rets=[];for(let i=1;i<p.length;i++)rets.push((p[i]-p[i-1])/p[i-1]);
      const m=rets.reduce((a,b)=>a+b,0)/rets.length;
      return Math.sqrt(rets.reduce((s,r)=>s+Math.pow(r-m,2),0)/rets.length);
    }
    function relStrength(prices, btcPrices, period=14) {
      const n=prices.length,b=btcPrices?.length||0;
      if(n<period||b<period)return 0;
      const tr=(prices[n-1]-prices[n-period])/prices[n-period];
      const br=(btcPrices[b-1]-btcPrices[b-period])/btcPrices[b-period];
      return tr-br;
    }
  `;
  const fn = new Function('module', 'exports', `${helpers}\n${src}\nmodule.exports={scoreToken};`);
  const mod = { exports: {} };
  fn(mod, mod.exports);
  return mod.exports.scoreToken;
}

let score5m, scoreOnchain;
try { score5m = loadCandidateWithHelpers('candidate_5m.js'); } catch(e) { log('Warning: candidate_5m load failed: ' + e.message); score5m = () => null; }
try { scoreOnchain = loadCandidateWithHelpers('candidate_onchain.js'); } catch(e) { log('Warning: candidate_onchain load failed: ' + e.message); scoreOnchain = () => null; }

function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19).replace('T',' ')} UTC] ${msg}`;
  console.log(line);
}

function readJSON(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; }
}

function writeJSON(f, d) {
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
}

// ── Default params ────────────────────────────────────────────────────────────
const DEFAULT_PARAMS = {
  // Blend weights per regime (must sum to 1.0 per regime)
  bear_w1h:      0.30,  // hourly weight in BEAR
  bear_w5m:      0.35,  // 5m weight in BEAR
  bear_wOC:      0.25,  // onchain weight in BEAR
  bear_w4h:      0.10,  // 4h weight in BEAR
  bull_w1h:      0.25,
  bull_w5m:      0.40,
  bull_wOC:      0.20,
  bull_w4h:      0.15,
  range_w1h:     0.35,
  range_w5m:     0.25,
  range_wOC:     0.30,
  range_w4h:     0.10,
  // Entry gate
  minScore:      0.05,  // blended score must exceed this to flag for entry (low default — let loop evolve it up)
  onchainVeto:   0.40,  // if onchain < -this, veto regardless of other scores
  whaleVeto:     0.50,  // if topBuyerConcentration > this, veto
};

// ── Load token history from Alchemy cache ─────────────────────────────────────
function loadTokens() {
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('_alchemy_1h.json'));
  const tokens = [];
  for (const f of files) {
    try {
      const d = readJSON(path.join(HISTORY_DIR, f), null);
      if (!d) continue;
      const bars = d.bars || [];
      if (bars.length < 50) continue;
      // Normalise bar format
      const prices   = bars.map(b => b.close || b.price || b.c || 0).filter(Boolean);
      const volumes  = bars.map(b => b.volume || b.v || 0);
      const highs    = bars.map(b => b.high   || b.h || b.close || b.c || 0);
      const lows     = bars.map(b => b.low    || b.l || b.close || b.c || 0);
      const opens    = bars.map(b => b.open   || b.o || b.close || b.c || 0);
      if (prices.length < 50) continue;
      tokens.push({
        sym: d.sym || f.replace('_alchemy_1h.json',''),
        prices, volumes, highs, lows, opens,
        transferStats: d.transferStats || null,
      });
    } catch {}
  }
  return tokens;
}

// ── BTC prices from cache ──────────────────────────────────────────────────────
function loadBtcPrices() {
  try {
    const f = path.join(HISTORY_DIR, 'WETH_alchemy_1h.json'); // use ETH as proxy if no BTC
    const btcFile = path.join(DIR, 'data', 'btc_hourly.json');
    if (fs.existsSync(btcFile)) {
      const d = readJSON(btcFile, null);
      if (d?.prices?.length > 50) return d.prices;
    }
    // Fallback: flat BTC proxy (neutral)
    return Array(730).fill(67000);
  } catch { return Array(730).fill(67000); }
}

// ── Normalise weights so they sum to 1 ────────────────────────────────────────
function normaliseWeights(p, prefix) {
  const keys = ['w1h','w5m','wOC','w4h'];
  const total = keys.reduce((s,k) => s + Math.max(0, p[`${prefix}_${k}`] || 0), 0);
  if (total === 0) return;
  keys.forEach(k => { p[`${prefix}_${k}`] = Math.max(0, (p[`${prefix}_${k}`] || 0)) / total; });
}

// ── Blended score for one token given params + regime ─────────────────────────
function blendScores(scores, params, regime) {
  const prefix = regime === 'BULL' ? 'bull' : regime === 'RANGE' ? 'range' : 'bear';
  const w = {
    h:  params[`${prefix}_w1h`] || 0.35,
    m5: params[`${prefix}_w5m`] || 0.30,
    oc: params[`${prefix}_wOC`] || 0.25,
    h4: params[`${prefix}_w4h`] || 0.10,
  };

  // Onchain veto
  if (scores.oc != null && scores.oc < -(params.onchainVeto || 0.20)) return -1;

  // Whale veto
  if (scores.whaleConc != null && scores.whaleConc > (params.whaleVeto || 0.50)) return -0.5;

  const available = [
    { s: scores.h,  w: w.h  },
    { s: scores.m5, w: w.m5 },
    { s: scores.oc, w: w.oc },
    { s: scores.h4, w: w.h4 },
  ].filter(x => x.s != null && !isNaN(x.s));

  if (available.length === 0) return 0;
  const totalW = available.reduce((s,x) => s + x.w, 0);
  return available.reduce((s,x) => s + x.s * x.w / totalW, 0);
}

// ── Regime detection from BTC price ──────────────────────────────────────────
function detectRegime(btcPrices) {
  if (!btcPrices || btcPrices.length < 200) return 'BEAR';
  const n = btcPrices.length;
  const price = btcPrices[n-1];
  const sma200 = btcPrices.slice(-200).reduce((s,p)=>s+p,0)/200;
  const pct = (price - sma200) / sma200;
  if (pct > 0.05) return 'BULL';
  if (pct < -0.03) return 'BEAR';
  return 'RANGE';
}

// ── Backtest: simulate entries/exits across all tokens ────────────────────────
function backtest(params, tokens, btcPrices) {
  // Normalise weights first
  ['bear','bull','range'].forEach(r => normaliseWeights(params, r));

  const regime = detectRegime(btcPrices);
  const minScore = params.minScore || 0.55;
  const results = [];

  // Split each token into rolling windows
  const WINDOW = 120;   // 5 days of 1h bars for signal
  const HOLD   = 24;    // hold for 24h after entry
  const STEP   = 12;    // evaluate every 12h

  for (const tok of tokens) {
    const n = tok.prices.length;
    if (n < WINDOW + HOLD) continue;

    for (let i = WINDOW; i < n - HOLD; i += STEP) {
      const slice = {
        prices:   tok.prices.slice(i - WINDOW, i),
        volumes:  tok.volumes.slice(i - WINDOW, i),
        highs:    tok.highs.slice(i - WINDOW, i),
        lows:     tok.lows.slice(i - WINDOW, i),
        opens:    tok.opens.slice(i - WINDOW, i),
        btcPrices: btcPrices.slice(Math.max(0, i - WINDOW), i),
        transferStats: tok.transferStats,
      };

      // Score available TFs on 1h data (5m requires 288+ 5m bars — not available here)
      // Fusion evolves weights for hourly + onchain; 5m weight kept constant in backtest
      let scoreH = null, scoreOC = null;
      let whaleConc = tok.transferStats?.topBuyerConcentration ?? null;
      try { scoreH  = scoreHourly(slice);  } catch {}
      try { scoreOC = scoreOnchain(slice); } catch {}

      // Scale weights: distribute 5m weight equally between h and OC for backtest
      // (5m weight still evolved but validated only at live trade time)
      const bParams = { ...params };
      const regP = regime === 'BULL' ? 'bull' : regime === 'RANGE' ? 'range' : 'bear';
      const w5m = bParams[`${regP}_w5m`] || 0;
      bParams[`${regP}_w1h`] = (bParams[`${regP}_w1h`] || 0) + w5m * 0.6;
      bParams[`${regP}_wOC`] = (bParams[`${regP}_wOC`] || 0) + w5m * 0.4;
      bParams[`${regP}_w5m`] = 0;

      const blended = blendScores(
        { h: scoreH, m5: null, oc: scoreOC, h4: null, whaleConc },
        bParams, regime
      );

      if (blended < minScore) continue; // no entry

      // Simulate exit after HOLD bars
      const entryPrice = tok.prices[i];
      const exitPrice  = tok.prices[Math.min(n-1, i + HOLD)];
      if (!entryPrice || !exitPrice) continue;

      const ret = (exitPrice - entryPrice) / entryPrice;
      results.push({ ret, tok: tok.sym, blended });
    }
  }

  if (results.length < 5) return { score: 0, trades: results.length, winRate: 0, avgRet: 0, sharpe: 0 };

  const rets   = results.map(r => r.ret);
  const wins   = rets.filter(r => r > 0).length;
  const avgRet = rets.reduce((s,r)=>s+r,0) / rets.length;
  const std    = Math.sqrt(rets.reduce((s,r)=>s+Math.pow(r-avgRet,2),0)/rets.length);
  const sharpe = std > 0 ? avgRet / std : 0;
  const winRate = wins / rets.length;

  // Score: sharpe * winRate multiplier — rewards both consistency and direction
  const score = parseFloat((sharpe * (0.5 + winRate) * Math.sqrt(results.length / 10)).toFixed(4));

  return { score, trades: results.length, winRate: parseFloat(winRate.toFixed(3)), avgRet: parseFloat(avgRet.toFixed(4)), sharpe: parseFloat(sharpe.toFixed(4)) };
}

// ── LLM propose mutation ──────────────────────────────────────────────────────
async function proposeMutation(state, recentExps) {
  const recent = recentExps.slice(-8).map(e =>
    `${e.param}: ${e.oldVal}→${e.newVal} | score ${e.score?.toFixed(3)} (best=${state.bestScore?.toFixed(3)}) ${e.accepted?'✅':'❌'}`
  ).join('\n');

  const prompt = `You are optimising blend weights for a crypto trading agent on Base mainnet.

Current best params (score=${state.bestScore?.toFixed(3)}):
${JSON.stringify(state.bestParams, null, 2)}

Recent experiments:
${recent || 'none yet'}

The agent blends 3 scoring functions: hourly quant (w1h), 5-minute momentum (w5m), onchain smart wallet (wOC), and 4h momentum (w4h).
Weights are per regime: bear_, bull_, range_ prefix.
minScore: entry threshold (0.3-0.8). onchainVeto: blocks trade if onchain<-X. whaleVeto: blocks if whale concentration >X.

Propose ONE parameter mutation. Return JSON only:
{"param": "bear_w5m", "value": 0.45, "reasoning": "5m momentum more reliable in BEAR markets"}

Valid params: bear_w1h, bear_w5m, bear_wOC, bear_w4h, bull_w1h, bull_w5m, bull_wOC, bull_w4h, range_w1h, range_w5m, range_wOC, range_w4h, minScore, onchainVeto, whaleVeto
Weights are normalised to sum=1 per regime automatically. Focus on what makes physical sense.`;

  // Try Bankr LLM first
  if (BANKR_KEY) {
    try {
      const r = await fetch(BANKR_LLM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BANKR_KEY}` },
        body: JSON.stringify({ model: BANKR_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 200 }),
      });
      if (r.ok) {
        const d = await r.json();
        const txt = d.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
      }
    } catch {}
  }

  // Anthropic fallback
  if (ANTHROPIC_KEY) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const txt = d.content?.[0]?.text || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
      }
    } catch {}
  }
  return null;
}

// ── Promote best params to multi_tf_score.js ──────────────────────────────────
function promoteParams(params) {
  const mtfFile = path.join(__dirname, '../agent/multi_tf_score.js');
  let src = fs.readFileSync(mtfFile, 'utf8');

  // Write state_fusion.json for runtime use
  writeJSON(STATE_FILE, { bestParams: params, updatedAt: new Date().toISOString() });

  // Patch the blend weights comment block in multi_tf_score.js
  const regime = detectRegime(loadBtcPrices());
  const prefix = regime === 'BULL' ? 'bull' : regime === 'RANGE' ? 'range' : 'bear';

  // Normalise first
  ['bear','bull','range'].forEach(r => normaliseWeights(params, r));

  const newWeights = `  // Weights: hourly ${(params[`${prefix}_w1h`]*100).toFixed(0)}%, 5m ${(params[`${prefix}_w5m`]*100).toFixed(0)}%, onchain ${(params[`${prefix}_wOC`]*100).toFixed(0)}%, 4h ${(params[`${prefix}_w4h`]*100).toFixed(0)}% [regime=${regime}, auto-evolved]
  const available = [
    { score: result.scoreH,   w: ${params[`${prefix}_w1h`].toFixed(3)}, name: '1h'      },
    { score: result.score5m,  w: ${params[`${prefix}_w5m`].toFixed(3)}, name: '5m'      },
    { score: result.scoreOC,  w: ${params[`${prefix}_wOC`].toFixed(3)}, name: 'onchain' },
    { score: result.score4h,  w: ${params[`${prefix}_w4h`].toFixed(3)}, name: '4h'      },
  ].filter(s => s.score != null && !isNaN(s.score));`;

  // Replace the weights block
  const replaced = src.replace(
    /\/\/ Weights:.*?\n\s*const available = \[[\s\S]*?\]\.filter\(s => s\.score != null && !isNaN\(s\.score\)\);/,
    newWeights
  );

  if (replaced !== src) {
    fs.writeFileSync(mtfFile, replaced, 'utf8');
    log(`🎯 Promoted fusion weights to multi_tf_score.js [${regime}]: 1h=${(params[`${prefix}_w1h`]*100).toFixed(0)}% 5m=${(params[`${prefix}_w5m`]*100).toFixed(0)}% onchain=${(params[`${prefix}_wOC`]*100).toFixed(0)}% 4h=${(params[`${prefix}_w4h`]*100).toFixed(0)}%`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  log('Fusion weight autoresearch starting...');

  const tokens    = loadTokens();
  const btcPrices = loadBtcPrices();
  log(`Loaded ${tokens.length} tokens`);

  if (tokens.length < 5) { log('Not enough token history — exiting'); process.exit(0); }

  // Quick sanity check: can we score at all?
  const testTok = tokens[0];
  const testSlice = { prices: testTok.prices.slice(0,120), volumes: testTok.volumes.slice(0,120), highs: testTok.highs.slice(0,120), lows: testTok.lows.slice(0,120), opens: testTok.opens.slice(0,120), btcPrices: btcPrices.slice(0,120), transferStats: testTok.transferStats };
  let debugH = null, debugOC = null, debug5m = null;
  try { debugH  = scoreHourly(testSlice);  } catch(e) { log('scoreHourly err: ' + e.message); }
  try { debugOC = scoreOnchain(testSlice); } catch(e) { log('scoreOnchain err: ' + e.message); }
  try { debug5m = score5m(testSlice);      } catch(e) { log('score5m err: ' + e.message); }
  log(`Score sanity check [${testTok.sym}]: hourly=${debugH?.toFixed(3)??'null'} onchain=${debugOC?.toFixed(3)??'null'} 5m=${debug5m?.toFixed(3)??'null'}`);

  // Load or init state
  const state = readJSON(STATE_FILE, {
    bestParams: { ...DEFAULT_PARAMS },
    bestScore:  -Infinity,
    expCount:   0,
  });
  if (state.bestScore === -Infinity || state.bestScore === 0) {
    const baseline = backtest(state.bestParams, tokens, btcPrices);
    state.bestScore = baseline.score;
    log(`Baseline: score=${baseline.score.toFixed(4)} winRate=${(baseline.winRate*100).toFixed(0)}% trades=${baseline.trades} sharpe=${baseline.sharpe.toFixed(3)}`);
  } else {
    log(`Resuming — best score: ${state.bestScore.toFixed(4)} after ${state.expCount} experiments`);
  }

  const exps = readJSON(EXP_FILE, []);

  while (true) {
    state.expCount++;

    // Get LLM proposal
    let proposal = await proposeMutation(state, exps);

    if (!proposal || !proposal.param || proposal.value == null) {
      log(`Exp ${state.expCount}: LLM null — random perturbation`);
      proposal = {};
      const keys = Object.keys(DEFAULT_PARAMS);
      const key  = keys[Math.floor(Math.random() * keys.length)];
      const ranges = {
        bear_w1h: [0.05, 0.60], bear_w5m: [0.05, 0.65], bear_wOC: [0.05, 0.55], bear_w4h: [0.01, 0.30],
        bull_w1h: [0.05, 0.55], bull_w5m: [0.10, 0.65], bull_wOC: [0.05, 0.45], bull_w4h: [0.02, 0.35],
        range_w1h:[0.05, 0.55], range_w5m:[0.05, 0.55], range_wOC:[0.05, 0.55], range_w4h:[0.01, 0.25],
        minScore: [0.30, 0.80], onchainVeto: [0.05, 0.50], whaleVeto: [0.30, 0.85],
      };
      const [lo, hi] = ranges[key] || [0.05, 0.60];
      const delta = (Math.random() - 0.5) * (hi - lo) * 0.25;
      proposal.param     = key;
      proposal.value     = parseFloat(Math.max(lo, Math.min(hi, (state.bestParams[key] || (lo+hi)/2) + delta)).toFixed(3));
      proposal.reasoning = 'random perturbation';
    }

    // Apply mutation
    const newParams = { ...state.bestParams, [proposal.param]: proposal.value };
    const result    = backtest(newParams, tokens, btcPrices);
    const improved  = result.score > state.bestScore;

    const exp = {
      exp:       state.expCount,
      param:     proposal.param,
      oldVal:    state.bestParams[proposal.param],
      newVal:    proposal.value,
      score:     result.score,
      winRate:   result.winRate,
      avgRet:    result.avgRet,
      sharpe:    result.sharpe,
      trades:    result.trades,
      accepted:  improved,
      reasoning: proposal.reasoning,
      ts:        new Date().toISOString(),
    };
    exps.push(exp);

    if (improved) {
      state.bestScore  = result.score;
      state.bestParams = newParams;
      log(`Exp ${state.expCount}: ✅ NEW BEST score=${result.score.toFixed(4)} | ${proposal.param}=${proposal.value} (${proposal.reasoning?.slice(0,60)}) | winRate=${(result.winRate*100).toFixed(0)}% avgRet=${(result.avgRet*100).toFixed(2)}%`);
      promoteParams(state.bestParams);
    } else {
      log(`Exp ${state.expCount}: score=${result.score.toFixed(4)} (best=${state.bestScore.toFixed(4)}) | ${proposal.param}=${proposal.value}`);
    }

    // Save state every 5 experiments
    if (state.expCount % 5 === 0) {
      writeJSON(STATE_FILE, state);
      writeJSON(EXP_FILE, exps.slice(-500));
    }

    await new Promise(r => setTimeout(r, 3000));
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
