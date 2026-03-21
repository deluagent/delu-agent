/**
 * overnight.js — Self-improving research engine
 *
 * Every 15 minutes:
 *  1. Run N experiments (as many as time allows, ~5-8 per cycle)
 *  2. Analyse what worked and what didn't
 *  3. Ask Gemini to synthesise learnings and update strategy hypotheses
 *  4. Write updated hypotheses into program.md for next cycle
 *  5. Sleep until next 15min mark, repeat
 *
 * By morning: dozens of cycles, hundreds of experiments, best strategy locked in.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR           = __dirname;
const CANDIDATE     = path.join(DIR, 'candidate.js');
const PROGRAM       = path.join(DIR, 'program.md');
const EXPERIMENTS   = path.join(DIR, 'experiments.json');
const STATE         = path.join(DIR, 'state.json');
const COST_FILE     = path.join(DIR, 'cost_track.json');
const OVERNIGHT_LOG = '/tmp/overnight.log';

const BANKR_LLM_API   = 'https://llm.bankr.bot/v1/chat/completions';
const BANKR_LLM_MODEL = 'gemini-3-flash';
const BANKR_API_KEY   = process.env.BANKR_API_KEY;

const CYCLE_MS        = 15 * 60 * 1000;   // 15 minutes per cycle
const EXP_PER_CYCLE   = 7;                // experiments per cycle
const MAX_SPEND_USD   = 4.20;             // hard stop (leave $0.30 buffer)
const COST_PER_CALL   = 0.002;            // est per LLM call

// ── Logging ───────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(OVERNIGHT_LOG, line + '\n');
}

// ── State ─────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { bestValSharpe: -999, bestScore: -999, expCount: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
function loadExps() { try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); } catch { return []; } }
function saveExps(e) { fs.writeFileSync(EXPERIMENTS, JSON.stringify(e, null, 2)); }
function loadCost() { try { return JSON.parse(fs.readFileSync(COST_FILE, 'utf8')); } catch { return { totalCalls: 0, estimatedSpend: 0 }; } }
function saveCost(c) { fs.writeFileSync(COST_FILE, JSON.stringify(c, null, 2)); }

function budgetOk() {
  const c = loadCost();
  if (c.estimatedSpend >= MAX_SPEND_USD) {
    log(`⛔ Budget limit reached: $${c.estimatedSpend.toFixed(3)} >= $${MAX_SPEND_USD}. Stopping.`);
    process.exit(0);
  }
  return c;
}

// ── Evaluator ─────────────────────────────────────────────────
function runEvaluate() {
  delete require.cache[require.resolve('./candidate')];
  delete require.cache[require.resolve('./evaluate')];
  try {
    const { evaluate } = require('./evaluate');
    return evaluate(true);
  } catch(e) {
    return null;
  }
}

function combinedScore(result) {
  if (!result) return -999;
  return 0.7 * result.validation.sharpe + 0.3 * result.audit.sharpe;
}

// ── Git ───────────────────────────────────────────────────────
function gitCommit(msg) {
  try {
    execSync(`cd ${path.join(DIR, '..')} && git add autoresearch/candidate.js autoresearch/state.json autoresearch/experiments.json autoresearch/program.md && git commit -m "${msg.replace(/"/g, "'")}"`, { stdio: 'pipe' });
  } catch(e) { /* ok */ }
}

// ── LLM call ─────────────────────────────────────────────────
async function callLLM(messages, maxTokens = 8000) {
  budgetOk();
  const res = await fetch(BANKR_LLM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BANKR_API_KEY}` },
    body: JSON.stringify({ model: BANKR_LLM_MODEL, messages, temperature: 0.7, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Bankr LLM ${res.status}: ${(await res.text()).slice(0, 100)}`);
  const data = await res.json();

  const cost = loadCost();
  cost.totalCalls++;
  cost.estimatedSpend += COST_PER_CALL;
  saveCost(cost);

  let code = (data.choices?.[0]?.message?.content || '').trim();
  // Strip markdown fences
  code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
  if (code.includes('```')) {
    const m = code.match(/```[a-zA-Z]*\n([\s\S]+?)\n?```/);
    if (m) code = m[1];
    else code = code.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');
  }
  return code.trim();
}

// ── Propose experiment ─────────────────────────────────────────
async function proposeExperiment(state, recentExps, cycleInsights) {
  const programMd   = fs.readFileSync(PROGRAM, 'utf8');
  const candidateJs = fs.readFileSync(CANDIDATE, 'utf8');
  const recent      = recentExps.slice(-8).map(e =>
    `  exp ${e.n}: val=${e.valSharpe?.toFixed(3) || '?'} aud=${e.audSharpe?.toFixed(3) || '?'} ${e.accepted ? '✅' : '❌'} — ${e.description}`
  ).join('\n') || '  (none yet)';

  const prompt = `You are a quant researcher improving a crypto momentum strategy.
Universe: 55 tokens (50 majors + 5 Base chain tokens), 730 days of OHLCV data.
Strategy: score tokens daily, hold top 5. Rebalance daily.
Accept only if: combined score (0.7×val + 0.3×aud) improves AND audit_sharpe > -0.5.

Current best:
  val_sharpe=${state.bestValSharpe?.toFixed(3)} | aud_sharpe=${state.bestAudSharpe?.toFixed(3) || '?'} | combined=${state.bestScore?.toFixed(3)}
Experiment #${(state.expCount || 0) + 1}

${cycleInsights ? `## Insights from this cycle\n${cycleInsights}\n` : ''}

## Research program
${programMd.slice(0, 2000)}

## Current candidate.js
\`\`\`javascript
${candidateJs}
\`\`\`

## Recent experiments
${recent}

## Task
Make ONE small, specific, logical change to improve the combined score.
Think about: what's the weakest part of the current signal? What's untried?
Priority this cycle: volume signals (OBV, volume surprise, ATR) — they are UNTESTED and have high expected value.

RULES — CRITICAL:
1. Output ONLY valid JavaScript — NO markdown, NO fences, NO prose
2. File MUST start with /** and end with: module.exports = { scoreToken };
3. scoreToken MUST be defined and exported
4. No require/import — pure JS only
5. ONE change only — keep it minimal`;

  return callLLM([{ role: 'user', content: prompt }]);
}

// ── Synthesise learnings ───────────────────────────────────────
async function synthesiseLearnings(cycleExps, currentBest) {
  if (cycleExps.length === 0) return null;

  const accepted = cycleExps.filter(e => e.accepted);
  const rejected = cycleExps.filter(e => !e.accepted && e.valSharpe !== -999);

  const prompt = `You are a quant researcher reviewing experiment results.

## This cycle's experiments
Accepted (${accepted.length}):
${accepted.map(e => `  ✅ val=${e.valSharpe?.toFixed(3)} aud=${e.audSharpe?.toFixed(3)} — ${e.description}`).join('\n') || '  (none)'}

Rejected (${rejected.length}):
${rejected.slice(-5).map(e => `  ❌ val=${e.valSharpe?.toFixed(3)} — ${e.description}`).join('\n') || '  (none)'}

Current best: val=${currentBest.val?.toFixed(3)}, aud=${currentBest.aud?.toFixed(3)}, combined=${currentBest.combined?.toFixed(3)}

## Task
In 3-5 bullet points, synthesise:
1. What worked and why (if anything)
2. What patterns of failure emerged
3. What should be tried NEXT cycle (be specific — name the signal, the weight, the direction)
4. What hypotheses are now RULED OUT (failed 2+ times)

Be concise and specific. Focus on what will improve the NEXT cycle.`;

  try {
    const insight = await callLLM([{ role: 'user', content: prompt }], 800);
    return insight;
  } catch(e) {
    return null;
  }
}

// ── Update program.md with new hypotheses ─────────────────────
async function updateProgramHypotheses(insights, state) {
  if (!insights) return;

  // Append insights to program.md as a rolling cycle log
  const entry = `\n## Cycle log — ${new Date().toISOString().slice(0,16)} UTC\nBest: val=${state.bestValSharpe?.toFixed(3)} aud=${state.bestAudSharpe?.toFixed(3)} combined=${state.bestScore?.toFixed(3)}\n${insights}\n`;
  
  const current = fs.readFileSync(PROGRAM, 'utf8');
  // Keep only last 3 cycle logs to avoid bloating the prompt
  const cycleMarker = '## Cycle log —';
  const parts = current.split(cycleMarker);
  const base = parts[0]; // keep the base instructions
  const recentLogs = parts.slice(-3).filter(Boolean).map(p => cycleMarker + p); // keep last 3 logs
  
  fs.writeFileSync(PROGRAM, base + recentLogs.join('') + entry);
}

// ── Run single experiment ─────────────────────────────────────
async function runExperiment(state, experiments, cycleInsights) {
  const backup = fs.readFileSync(CANDIDATE, 'utf8');
  let accepted = false, description = 'unknown', valSharpe = -999, audSharpe = 0, score = -999;

  try {
    const t0 = Date.now();
    const newCode = await proposeExperiment(state, experiments, cycleInsights);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!newCode || newCode.length < 100) throw new Error('response too short');

    // Syntax check
    try { new Function(newCode); } catch(e) { throw new Error(`syntax: ${e.message.slice(0, 60)}`); }
    if (!newCode.includes('scoreToken') || !newCode.includes('module.exports')) {
      throw new Error('missing scoreToken or module.exports');
    }

    const match = newCode.match(/\/\/ (exp \d+:|change:|hypothesis:|note:|\w+:) (.+)/i);
    description = match ? match[2].slice(0, 70) : `experiment ${state.expCount + 1}`;

    fs.writeFileSync(CANDIDATE, newCode);
    const result = runEvaluate();
    if (!result) throw new Error('evaluator returned null');

    valSharpe = result.validation.sharpe;
    audSharpe = result.audit.sharpe;
    score     = combinedScore(result);
    const oldScore = state.bestScore || -999;
    const delta = score - oldScore;
    const sign = delta >= 0 ? '+' : '';

    log(`  ${state.expCount + 1}: val=${valSharpe.toFixed(3)} aud=${audSharpe.toFixed(3)} score=${score.toFixed(3)} (${sign}${delta.toFixed(3)}) [${elapsed}s] — ${description}`);

    if (score > oldScore && audSharpe > -0.5) {
      state.expCount++;
      state.bestValSharpe = valSharpe;
      state.bestAudSharpe = audSharpe;
      state.bestScore     = score;
      saveState(state);
      accepted = true;
      log(`  ✅ KEPT — new best combined=${score.toFixed(3)}`);
      gitCommit(`exp ${state.expCount}: ${sign}${delta.toFixed(3)} combined (val=${valSharpe.toFixed(3)} aud=${audSharpe.toFixed(3)}) — ${description}`);
    } else {
      state.expCount++;
      saveState(state);
      fs.writeFileSync(CANDIDATE, backup);
      log(`  ❌ REVERTED`);
    }

  } catch(e) {
    state.expCount++;
    saveState(state);
    fs.writeFileSync(CANDIDATE, backup);
    log(`  ⚠️  ERROR: ${e.message}`);
    description = `error: ${e.message.slice(0, 50)}`;
    valSharpe = -999;
  }

  const expRecord = { n: state.expCount, valSharpe, audSharpe, isSharpe: 0, accepted, description, ts: Date.now() };
  const allExps = loadExps();
  saveExps([...allExps, expRecord]);
  return { ...expRecord, score };
}

// ── Main overnight loop ────────────────────────────────────────
async function overnight() {
  log(`\n${'═'.repeat(60)}`);
  log(`  delu overnight research — ${EXP_PER_CYCLE} exp/cycle, ${CYCLE_MS/60000}min cycles`);
  log(`  model: ${BANKR_LLM_MODEL} | budget: $${MAX_SPEND_USD}`);
  log(`${'═'.repeat(60)}`);

  const baseline = runEvaluate();
  if (!baseline) { log('❌ Baseline eval failed — check candidate.js'); process.exit(1); }

  let state = loadState();
  log(`📏 Baseline: val=${state.bestValSharpe?.toFixed(3)} aud=${state.bestAudSharpe?.toFixed(3)} combined=${state.bestScore?.toFixed(3)}`);
  log(`   Experiments so far: ${state.expCount} | Budget: $${loadCost().estimatedSpend.toFixed(3)} spent\n`);

  let cycleNum = 0;
  let cycleInsights = null;

  while (true) {
    cycleNum++;
    const cycleStart = Date.now();
    log(`\n${'─'.repeat(60)}`);
    log(`CYCLE ${cycleNum} — ${new Date().toISOString().slice(0,16)} UTC | best combined=${state.bestScore?.toFixed(3)}`);
    log(`${'─'.repeat(60)}`);

    const cycleExps = [];

    for (let i = 0; i < EXP_PER_CYCLE; i++) {
      budgetOk();
      state = loadState();
      const experiments = loadExps();
      log(`\n[${i+1}/${EXP_PER_CYCLE}] exp ${(state.expCount||0)+1}`);

      const expResult = await runExperiment(state, experiments, cycleInsights);
      cycleExps.push(expResult);

      // Short pause between experiments (rate limiting)
      if (i < EXP_PER_CYCLE - 1) await new Promise(r => setTimeout(r, 2000));
    }

    // Synthesise what we learned this cycle
    log(`\n📊 Synthesising cycle ${cycleNum} learnings...`);
    state = loadState();
    cycleInsights = await synthesiseLearnings(cycleExps, {
      val: state.bestValSharpe,
      aud: state.bestAudSharpe,
      combined: state.bestScore
    });

    if (cycleInsights) {
      log(`💡 Insights:\n${cycleInsights.split('\n').map(l => '   ' + l).join('\n')}`);
      await updateProgramHypotheses(cycleInsights, state);
    }

    // Summary
    const accepted = cycleExps.filter(e => e.accepted).length;
    const cost = loadCost();
    log(`\n📈 Cycle ${cycleNum} complete: ${accepted}/${EXP_PER_CYCLE} improved | best combined=${state.bestScore?.toFixed(3)} | $${cost.estimatedSpend.toFixed(3)} spent`);

    // Sleep until next 15min mark
    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, CYCLE_MS - elapsed);
    if (remaining > 0) {
      log(`😴 Sleeping ${(remaining/60000).toFixed(1)}min until next cycle...`);
      await new Promise(r => setTimeout(r, remaining));
    }
  }
}

overnight().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
