/**
 * loop_hourly.js — Autoresearch loop for HOURLY signal evolution
 *
 * Parallel to loop.js (daily), this evolves candidate_hourly.js
 * targeting intraday signals: momentum bursts, volume spikes, OBV, range compression.
 *
 * Uses same LLM (Bankr LLM claude-sonnet-4-5) and same accept/reject logic.
 * State: autoresearch/state_hourly.json
 * Experiments: autoresearch/experiments_hourly.json
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const https = require('https');

const DIR           = __dirname;
const CANDIDATE     = path.join(DIR, 'candidate_hourly.js');
const QUANT_SCORE   = path.join(DIR, '../agent/quant_score.js');
const PROGRAM       = path.join(DIR, 'program_hourly.md');
const STATE_FILE    = path.join(DIR, 'state_hourly.json');
const EXPERIMENTS   = path.join(DIR, 'experiments_hourly.json');
const COST_TRACK    = path.join(DIR, 'cost_track_hourly.json');
const FEEDBACK_FILE = path.join(DIR, 'live_feedback.json');

const INTERVAL_S    = 5;  // 5s — maximize experiment throughput
const COST_LIMIT    = 999;
const COST_PER_CALL = 0.003;

// ── State ────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch {
    return { bestValSharpe: -999, bestAudSharpe: -999, bestScore: -999, expCount: 0 };
  }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function loadExperiments() {
  try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); }
  catch { return []; }
}
function saveExperiments(e) { fs.writeFileSync(EXPERIMENTS, JSON.stringify(e, null, 2)); }

function loadCostTrack() {
  try { return JSON.parse(fs.readFileSync(COST_TRACK, 'utf8')); }
  catch { return { totalCalls: 0, estimatedSpend: 0 }; }
}
function saveCostTrack(c) { fs.writeFileSync(COST_TRACK, JSON.stringify(c)); }

// ── LLM — Bankr first, Anthropic Haiku fallback ────────────
async function callLLM(messages) {
  const bankrKey    = (process.env.BANKR_API_KEY     || "").replace(/\s/g, "");
  const anthropicKey= (process.env.ANTHROPIC_API_KEY || "").replace(/\s/g, "");

  if (false) { // Bankr credits exhausted — Anthropic only
    try {
      const body = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4000, messages });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "llm.bankr.bot", port: 443, method: "POST",
          path: "/v1/chat/completions",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bankrKey}`, "Content-Length": Buffer.byteLength(body) },
        }, (res) => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => {
            try {
              const j = JSON.parse(d);
              if (j.error || !j.choices) {
                reject(new Error("bankr_credits"));
              } else {
                resolve(j.choices?.[0]?.message?.content || "");
              }
            } catch(e) { reject(new Error("bankr_credits")); }
          });
        });
        req.on("error", reject);
        req.setTimeout(90000, () => { req.destroy(); reject(new Error("timeout")); });
        req.write(body); req.end();
      });
      return result;
    } catch(e) {
      if (e.message !== "bankr_credits") throw e;
      console.log("   [llm] Bankr credits exhausted — Anthropic fallback");
    }
  }

  if (!anthropicKey) throw new Error("No LLM available");
  const body = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4000,
    messages: messages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })) });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com", port: 443, method: "POST",
      path: "/v1/messages",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.error) throw new Error("Anthropic: " + JSON.stringify(j.error));
          resolve(j.content?.[0]?.text || "");
        } catch(e) { reject(new Error("parse: " + d.slice(0,80))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body); req.end();
  });
}


// ── Evaluate current candidate ────────────────────────────────
function runEval() {
  // Clear module cache so fresh candidate is loaded
  delete require.cache[require.resolve('./candidate_hourly')];
  delete require.cache[require.resolve('./evaluate_hourly')];
  try {
    const { evaluate } = require('./evaluate_hourly');
    return evaluate(true);
  } catch(e) {
    console.error('[eval_hourly] Error:', e.message);
    return null;
  }
}

// ── Strip code fences ─────────────────────────────────────────
function stripFences(code) {
  return code
    .replace(/^```(?:javascript|js)?\s*\n?/gim, '')
    .replace(/^```\s*$/gim, '')
    .trim();
}

// ── Validate JS ───────────────────────────────────────────────
function validateCode(code) {
  try {
    new Function(code);
    if (!code.includes('function scoreToken')) throw new Error('Missing scoreToken');
    if (!code.includes('module.exports')) throw new Error('Missing module.exports');
    return true;
  } catch(e) {
    return false;
  }
}

// ── Sync best hourly candidate → quant_score.js (live agent brain) ──────────
// When hourly loop finds a new best, promote it to the live scoring module.
// quant_score.js is used by trending_entry.js + position_monitor.js every cycle.
function syncToQuantScore(newCode, state) {
  try {
    const header = `/**
 * quant_score.js — Live agent scoring brain
 *
 * AUTO-GENERATED by autoresearch/loop_hourly.js
 * Last promoted: ${new Date().toISOString().slice(0, 16)} UTC
 * Hourly experiments: ${state.expCount} | val=${state.bestValSharpe.toFixed(3)} combined=${state.bestScore.toFixed(3)}
 *
 * This file is the best hourly signal candidate promoted to live use.
 * DO NOT edit manually — it will be overwritten on next improvement.
 * Source: autoresearch/candidate_hourly.js
 */
`;
    // Strip existing header comment from candidate_hourly.js if present
    const stripped = newCode.replace(/^\/\*\*[\s\S]*?\*\/\n/, '');

    // Wrap: export scoreTokenHourly as the public API
    const wrapped = header + stripped + `

// ── Public API ───────────────────────────────────────────────────────────────
// scoreTokenHourly: used by trending_entry.js and position_monitor.js
// Accepts { prices, volumes, highs, lows, btcPrices } → score in [0, 1]
if (typeof module !== 'undefined') {
  module.exports = { scoreTokenHourly: typeof scoreToken !== 'undefined' ? scoreToken : (exports.scoreToken || (() => 0)) };
}
`;
    fs.writeFileSync(QUANT_SCORE, wrapped);
    console.log(`   🔄 quant_score.js synced (live agent updated) — val=${state.bestValSharpe.toFixed(3)} combined=${state.bestScore.toFixed(3)}`);
  } catch(e) {
    console.warn(`   ⚠️  quant_score.js sync failed: ${e.message}`);
  }
}

// ── Load live feedback ────────────────────────────────────────
function loadLiveFeedback() {
  try {
    const fb = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    if (!fb.length) return '';
    const wins = fb.filter(f => f.won).length;
    const avg  = (fb.reduce((s, f) => s + f.pnlPct, 0) / fb.length).toFixed(2);
    const recent = fb.slice(-5).map(f =>
      `  ${f.sym} | ${f.won ? 'WIN' : 'LOSS'} ${f.pnlPct?.toFixed(2)}% | regime=${f.regime}`
    ).join('\n');
    return `## Live trade outcomes (${fb.length} closed | WR=${wins}/${fb.length} | avgPnL=${avg}%)\n${recent}`;
  } catch { return ''; }
}

// ── Propose change ────────────────────────────────────────────
async function proposeChange(state, experiments) {
  const programMd   = fs.existsSync(PROGRAM) ? fs.readFileSync(PROGRAM, 'utf8') : '# Hourly signal research\nImprove intraday momentum and volume signals.';
  const candidateJs = fs.readFileSync(CANDIDATE, 'utf8');
  const liveFeedback = loadLiveFeedback();

  const recentExps = experiments.slice(-6).map(e =>
    `  exp ${e.n}: val_sharpe=${e.valSharpe?.toFixed(3)} ${e.accepted ? '✅ KEPT' : '❌ reverted'} — ${e.description}`
  ).join('\n') || '  (none yet)';

  const scoreTokenIdx = candidateJs.indexOf('\nfunction scoreToken');
  const scoreSection  = scoreTokenIdx >= 0 ? candidateJs.slice(scoreTokenIdx).trim() : candidateJs.slice(-3000);
  const helperSection = scoreTokenIdx >= 0 ? candidateJs.slice(0, scoreTokenIdx).trim() : '';

  const prompt = `You are improving a crypto momentum trading strategy on HOURLY (1h) bars.
Strategy: score tokens every 4h, hold top 5. Metric: 0.7*val_sharpe + 0.3*aud_sharpe.
Current best: val=${state.bestValSharpe.toFixed(3)} combined=${(state.bestScore||0).toFixed(3)}

Data available per token: prices[], volumes[], highs[], lows[], opens[], btcPrices[]
Rebalance: every 4h bars. Execution: at next bar open (no lookahead).
Time horizon: 180 days of hourly data (4320 bars). Val period = bear market (Q1 2026).

Key insight: hourly bars enable intraday signals unavailable to daily:
- Volume burst detection (last 4h vs 24h average)
- Momentum acceleration (4h momentum change rate)
- Range compression / coiling (tight range before breakout)
- Microstructure OBV (hourly buy/sell pressure)
- Short-term mean reversion (1-4h oversold bounces)

Available helpers (DO NOT redefine): ema, sma, realizedVol, zScore

## Recent experiments
${recentExps}

${liveFeedback ? liveFeedback + '\n' : ''}## Current scoreToken
${scoreSection}

## Task
First line: DESCRIPTION: <one short sentence, e.g. "RSI period 8 instead of 14">
Then the new scoreToken function.
Start with: DESCRIPTION: ...
Then: function scoreToken(data) {
End with: }

module.exports = { scoreToken };

ONE small change. No helpers redefined. No markdown. Pure JS only.`;

  const t0 = Date.now();
  const response = await callLLM([{ role: 'user', content: prompt }]);
  const ms = Date.now() - t0;
  const tokens = Math.round(prompt.length / 3.5 + response.length / 3.5);
  console.log(`   [llm] ${(ms/1000).toFixed(1)}s | tokens≈${tokens}`);

  const stripped = stripFences(response);
  const full = helperSection + '\n\n' + stripped;

  if (!validateCode(full)) {
    console.log('   [llm] Code failed validation — skipping');
    return null;
  }

  return full;
}

// ── Main loop ─────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════');
  console.log(' delu autoresearch — HOURLY loop');
  console.log(`   interval:  ${INTERVAL_S}s`);
  console.log(`   model:     claude-sonnet-4-5 via Bankr LLM`);
  console.log('════════════════════════════════════════════════');

  // Wait for hourly data to be available
  let dataReady = false;
  for (let attempts = 0; attempts < 30; attempts++) {
    const testFile = path.join(__dirname, '../data/history/ETH_binance_hourly.json');
    if (fs.existsSync(testFile)) {
      const raw = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      if ((raw.bars || raw).length >= 200) { dataReady = true; break; }
    }
    console.log(`   [init] Waiting for hourly data... (${attempts + 1}/30)`);
    await new Promise(r => setTimeout(r, 10000));
  }
  if (!dataReady) { console.error('[init] Hourly data not available after 5min — exiting'); process.exit(1); }

  // Measure baseline
  console.log('\n📏 Measuring hourly baseline...');
  const baseline = runEval();
  if (!baseline) { console.error('[baseline] Eval failed — check fetch_hourly.js ran successfully'); process.exit(1); }

  const baseVal = baseline.validation.sharpe;
  const baseAud = baseline.audit.sharpe;
  const baseScore = 0.7 * baseVal + 0.3 * baseAud;
  console.log(`   baseline: val_sharpe=${baseVal.toFixed(3)} aud_sharpe=${baseAud.toFixed(3)} combined=${baseScore.toFixed(3)}`);

  let state = loadState();
  if (state.bestScore < baseScore) {
    state.bestValSharpe = baseVal;
    state.bestAudSharpe = baseAud;
    state.bestScore     = baseScore;
    saveState(state);
  }

  const best = { code: fs.readFileSync(CANDIDATE, 'utf8') };

  while (true) {
    const cost = loadCostTrack();
    if (cost.estimatedSpend >= COST_LIMIT) {
      console.log(`\n💸 Budget limit $${COST_LIMIT} reached — stopping`);
      break;
    }

    state = loadState();
    const experiments = loadExperiments();
    const expN = state.expCount + 1;

    console.log(`\n🧪 [exp ${expN}] Best: val=${state.bestValSharpe.toFixed(3)} combined=${(state.bestScore||0).toFixed(3)}`);
    console.log(`   Asking Claude for hourly signal improvement...`);

    let newCode;
    try {
      newCode = await proposeChange(state, experiments);
    } catch(e) {
      console.error('   [llm] Error:', e.message);
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }

    if (!newCode) {
      await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
      continue;
    }

    // Test new code
    const prevCode = fs.readFileSync(CANDIDATE, 'utf8');
        // Extract DESCRIPTION line before writing
    const descMatch = newCode.match(/^DESCRIPTION:\s*(.+)/m);
    if (descMatch) {
      description = descMatch[1].trim().slice(0, 100);
      newCode = newCode.replace(/^DESCRIPTION:.*\n?/m, '').trim();
    }
    fs.writeFileSync(CANDIDATE, newCode);

    const result = runEval();
    let accepted = false, description = `exp ${expN}`;
    let valSharpe = -999, audSharpe = -999, score = -999, isSharpe = -999;

    if (result) {
      valSharpe = result.validation.sharpe;
      audSharpe = result.audit.sharpe;
      isSharpe  = result.inSample.sharpe;
      score     = 0.5 * valSharpe + 0.5 * audSharpe;

      const improvement = score - (state.bestScore || -999);
      console.log(`   Result: val=${valSharpe.toFixed(3)} aud=${audSharpe.toFixed(3)} score=${score.toFixed(3)} (${improvement >= 0 ? '+' : ''}${improvement.toFixed(3)}) | is=${isSharpe.toFixed(3)}`);

      if (score > (state.bestScore || -999)) {
        accepted = true;
        state.bestValSharpe = valSharpe;
        state.bestAudSharpe = audSharpe;
        state.bestScore     = score;
        best.code           = newCode;
        saveState(state);
        console.log(`   ✅ ACCEPTED — new best!`);
        // Promote to live agent brain immediately
        syncToQuantScore(newCode, state);
      } else {
        console.log(`   ❌ REVERTED`);
        fs.writeFileSync(CANDIDATE, prevCode);
      }
    } else {
      console.log('   ❌ Eval returned null — reverted');
      fs.writeFileSync(CANDIDATE, prevCode);
    }

    // Log experiment
    const expLog = loadExperiments();
    expLog.push({
      n: expN, ts: new Date().toISOString(),
      valSharpe, audSharpe, isSharpe, score, accepted,
      description,
    });
    saveExperiments(expLog);

    state.expCount = expN;
    saveState(state);

    // Track cost
    const ct = loadCostTrack();
    ct.totalCalls++;
    ct.estimatedSpend += COST_PER_CALL;
    saveCostTrack(ct);

    console.log(`   💰 est. spend: $${ct.estimatedSpend.toFixed(3)} / $${COST_LIMIT}`);
    console.log(`   Sleeping ${INTERVAL_S}s...`);
    await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
