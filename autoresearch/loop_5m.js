/**
 * loop_5m.js — Autoresearch loop for 5-MINUTE signal evolution
 *
 * Parallel to loop.js (daily) and loop_hourly.js
 * Evolves candidate_5m.js targeting intraday 1h-rebalance signals.
 *
 * State:    autoresearch/state_5m.json
 * Experiments: autoresearch/experiments_5m.json
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const https = require('https');

const DIR           = __dirname;
const CANDIDATE     = path.join(DIR, 'candidate_5m.js');
const PROGRAM       = path.join(DIR, 'program_5m.md');
const STATE_FILE    = path.join(DIR, 'state_5m.json');
const FEEDBACK_FILE = path.join(DIR, 'live_feedback.json');
const EXPS_FILE  = path.join(DIR, 'experiments_5m.json');
const COST_FILE  = path.join(DIR, 'cost_track_5m.json');

const INTERVAL_S    = 5;  // 5s — maximize experiment throughput
const COST_LIMIT    = 999;
const COST_PER_CALL = 0.003;

// ── State ─────────────────────────────────────────────────────
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { bestValSharpe: -999, bestAudSharpe: -999, bestScore: -999, expCount: 0 }; } };
const saveState = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const loadExps  = () => { try { return JSON.parse(fs.readFileSync(EXPS_FILE, 'utf8')); } catch { return []; } };
const saveExps  = e => fs.writeFileSync(EXPS_FILE, JSON.stringify(e, null, 2));
const loadCost  = () => { try { return JSON.parse(fs.readFileSync(COST_FILE, 'utf8')); } catch { return { totalCalls: 0, estimatedSpend: 0 }; } };
const saveCost  = c => fs.writeFileSync(COST_FILE, JSON.stringify(c));

// ── LLM — Bankr first, Anthropic Haiku fallback ────────────
async function callLLM(messages) {
  const bankrKey    = (process.env.BANKR_API_KEY     || "").replace(/\s/g, "");
  const anthropicKey= (process.env.ANTHROPIC_API_KEY || "").replace(/\s/g, "");

  if (bankrKey) {
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
              if (j.error?.type === "insufficient_credits" || (j.error?.message || "").includes("Insufficient")) {
                reject(new Error("bankr_credits"));
              } else if (j.error) {
                reject(new Error("Bankr: " + j.error.message));
              } else {
                resolve(j.choices?.[0]?.message?.content || "");
              }
            } catch(e) { reject(new Error("parse: " + d.slice(0,80))); }
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


// ── Evaluate ──────────────────────────────────────────────────
function runEval() {
  delete require.cache[require.resolve('./candidate_5m')];
  delete require.cache[require.resolve('./evaluate_5m')];
  try {
    const { evaluate } = require('./evaluate_5m');
    return evaluate(true);
  } catch(e) {
    console.error('[eval_5m] Error:', e.message);
    return null;
  }
}

// ── Strip fences + validate ────────────────────────────────────
function stripFences(code) {
  return code.replace(/^```(?:javascript|js)?\s*\n?/gim, '').replace(/^```\s*$/gim, '').trim();
}
function validateCode(code) {
  try {
    new Function(code);
    if (!code.includes('function scoreToken')) throw new Error('Missing scoreToken');
    if (!code.includes('module.exports')) throw new Error('Missing module.exports');
    return true;
  } catch { return false; }
}

// ── Propose change ─────────────────────────────────────────────
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

async function proposeChange(state, experiments) {
  const programMd    = fs.existsSync(PROGRAM) ? fs.readFileSync(PROGRAM, 'utf8') : '# 5m research';
  const candidateJs  = fs.readFileSync(CANDIDATE, 'utf8');
  const liveFeedback = loadLiveFeedback();

  const recentExps = experiments.slice(-6).map(e =>
    `  exp ${e.n}: combined=${e.score?.toFixed(3)} ${e.accepted ? '✅' : '❌'} val=${e.valSharpe?.toFixed(2)} aud=${e.audSharpe?.toFixed(2)}`
  ).join('\n') || '  (none yet)';

  const scoreIdx = candidateJs.indexOf('\nfunction scoreToken');
  const helpers  = scoreIdx >= 0 ? candidateJs.slice(0, scoreIdx).trim() : '';
  const scoreSection = scoreIdx >= 0 ? candidateJs.slice(scoreIdx).trim() : candidateJs.slice(-3000);

  const prompt = `You are improving a crypto trading strategy on 5-MINUTE bars.

Setup: 26 tokens, 30 days of 5m data, rebalance every 12 bars (1 hour).
Score range: [-1, +1]. Top 3 long + bottom 2 short each rebalance.
Metric: 0.5*val_sharpe + 0.5*aud_sharpe (annualised with sqrt(365*24*12)).
Current best: val=${state.bestValSharpe.toFixed(3)} combined=${(state.bestScore||0).toFixed(3)}

CRITICAL INSIGHT: At 1h rebalance with 5m bars:
- 5m and 15m momentum is TOO NOISY — avoid ret1, ret3 as primary signals
- Use 1h (ret12) and 4h (ret48) as core momentum signals
- Volume bursts over 12 bars vs 48+ bar baseline are reliable
- Relative strength cross-sectional ranking works well
- Keep signal count low — 5m data is noisy, fewer signals = less overfit

Available helpers (DO NOT redefine): ema, sma, realizedVol, zScore
Data available: prices[], volumes[], highs[], lows[], opens[], btcPrices[]
Min bars required: 288 (1 day)

## Research program
${programMd.slice(0, 1500)}

${liveFeedback ? liveFeedback + '\n' : ''}
## Recent experiments
${recentExps}

## Current scoreToken function
${scoreSection}

## Task
Return ONLY the new scoreToken function + module.exports.
ONE small change targeting the biggest weakness shown in recent experiments.
Start with: function scoreToken(data) {
End with: }

module.exports = { scoreToken };

No helpers redefined. No markdown. Pure JS only.`;

  const t0 = Date.now();
  const response = await callLLM([{ role: 'user', content: prompt }]);
  const ms = Date.now() - t0;
  console.log(`   [llm] ${(ms/1000).toFixed(1)}s`);

  const stripped = stripFences(response);
  const full = helpers ? helpers + '\n\n' + stripped : stripped;
  return validateCode(full) ? full : null;
}

// ── Main loop ──────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════');
  console.log(' delu autoresearch — 5M loop');
  console.log(`   26 tokens | 30d × 8640 bars | 1h rebalance`);
  console.log(`   model: claude-sonnet-4-5 via Bankr LLM`);
  console.log('════════════════════════════════════════════════');

  // Baseline
  console.log('\n📏 Measuring 5m baseline...');
  const baseline = runEval();
  if (!baseline) { console.error('[baseline] Eval failed'); process.exit(1); }

  const baseVal   = baseline.validation.sharpe;
  const baseAud   = baseline.audit.sharpe;
  const baseScore = 0.5 * baseVal + 0.5 * baseAud;
  console.log(`   baseline: val=${baseVal.toFixed(3)} aud=${baseAud.toFixed(3)} combined=${baseScore.toFixed(3)}`);

  let state = loadState();
  if (state.bestScore < baseScore) {
    state = { ...state, bestValSharpe: baseVal, bestAudSharpe: baseAud, bestScore: baseScore };
    saveState(state);
  }

  let bestCode = fs.readFileSync(CANDIDATE, 'utf8');

  while (true) {
    const cost = loadCost();
    if (cost.estimatedSpend >= COST_LIMIT) { console.log(`\n💸 Budget reached`); break; }

    state = loadState();
    const experiments = loadExps();
    const expN = state.expCount + 1;

    console.log(`\n🧪 [exp ${expN}] Best: val=${state.bestValSharpe.toFixed(3)} combined=${(state.bestScore||0).toFixed(3)}`);

    let newCode;
    try { newCode = await proposeChange(state, experiments); }
    catch(e) { console.error('   [llm] Error:', e.message); await new Promise(r=>setTimeout(r,15000)); continue; }

    if (!newCode) { await new Promise(r=>setTimeout(r,INTERVAL_S*1000)); continue; }

    const prevCode = fs.readFileSync(CANDIDATE, 'utf8');
    fs.writeFileSync(CANDIDATE, newCode);

    const result = runEval();
    let accepted = false;
    let valSharpe=-999, audSharpe=-999, score=-999, isSharpe=-999;

    if (result) {
      valSharpe = result.validation.sharpe;
      audSharpe = result.audit.sharpe;
      isSharpe  = result.inSample.sharpe;
      score     = 0.5 * valSharpe + 0.5 * audSharpe;
      const delta = score - (state.bestScore || -999);
      console.log(`   Result: val=${valSharpe.toFixed(3)} aud=${audSharpe.toFixed(3)} score=${score.toFixed(3)} (${delta>=0?'+':''}${delta.toFixed(3)}) is=${isSharpe.toFixed(3)}`);

      if (score > (state.bestScore || -999)) {
        accepted = true;
        state.bestValSharpe = valSharpe;
        state.bestAudSharpe = audSharpe;
        state.bestScore     = score;
        bestCode            = newCode;
        saveState(state);
        console.log('   ✅ ACCEPTED — new best!');
      } else {
        console.log('   ❌ REVERTED');
        fs.writeFileSync(CANDIDATE, prevCode);
      }
    } else {
      console.log('   ❌ Eval returned null — reverted');
      fs.writeFileSync(CANDIDATE, prevCode);
    }

    const exps = loadExps();
    exps.push({ n: expN, ts: new Date().toISOString(), valSharpe, audSharpe, isSharpe, score, accepted });
    saveExps(exps);

    state.expCount = expN;
    saveState(state);

    const ct = loadCost();
    ct.totalCalls++;
    ct.estimatedSpend += COST_PER_CALL;
    saveCost(ct);

    console.log(`   💰 est. spend: $${ct.estimatedSpend.toFixed(3)} / $${COST_LIMIT}`);
    await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
