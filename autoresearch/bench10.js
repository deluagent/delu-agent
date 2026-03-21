/**
 * bench10.js — run 10 experiments back-to-back, no sleep
 * Tests model quality: how often does Gemini 3 Flash beat baseline?
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');

const CANDIDATE    = path.join(__dirname, 'candidate.js');
const PROGRAM      = path.join(__dirname, 'program.md');
const EXPERIMENTS  = path.join(__dirname, 'experiments.json');
const STATE        = path.join(__dirname, 'state.json');
const COST_FILE    = path.join(__dirname, 'cost_track.json');

const BANKR_LLM_API   = 'https://llm.bankr.bot/v1/chat/completions';
const BANKR_LLM_MODEL = 'gemini-3-flash';
const BANKR_API_KEY   = process.env.BANKR_API_KEY;
const N_EXPERIMENTS   = 10;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { bestValSharpe: -999, expCount: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
function loadExps() { try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); } catch { return []; } }
function saveExps(e) { fs.writeFileSync(EXPERIMENTS, JSON.stringify(e, null, 2)); }
function loadCost() { try { return JSON.parse(fs.readFileSync(COST_FILE, 'utf8')); } catch { return { totalCalls: 0, estimatedSpend: 0 }; } }
function saveCost(c) { fs.writeFileSync(COST_FILE, JSON.stringify(c, null, 2)); }

function runEvaluate() {
  delete require.cache[require.resolve('./candidate')];
  delete require.cache[require.resolve('./evaluate')];
  try {
    const { evaluate } = require('./evaluate');
    return evaluate(true);
  } catch(e) {
    console.log(`   evaluate error: ${e.message.slice(0, 80)}`);
    return null;
  }
}

function gitCommit(msg) {
  const { execSync } = require('child_process');
  execSync(`cd ${path.join(__dirname, '..')} && git add autoresearch/candidate.js autoresearch/state.json autoresearch/experiments.json && git commit -m "${msg}"`, { stdio: 'pipe' });
}

async function callLLM(messages) {
  const res = await fetch(BANKR_LLM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BANKR_API_KEY}` },
    body: JSON.stringify({ model: BANKR_LLM_MODEL, messages, temperature: 0.7, max_tokens: 8000 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Bankr LLM ${res.status}: ${(await res.text()).slice(0,100)}`);
  const data = await res.json();

  const cost = loadCost();
  cost.totalCalls++;
  cost.estimatedSpend += 0.002;
  saveCost(cost);

  let code = (data.choices?.[0]?.message?.content || '').trim();
  // Strip fences
  code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
  if (code.includes('```')) {
    const m = code.match(/```[a-zA-Z]*\n([\s\S]+?)\n?```/);
    if (m) code = m[1];
    else code = code.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');
  }
  return code.trim();
}

async function proposeChange(state, experiments) {
  const programMd   = fs.readFileSync(PROGRAM, 'utf8');
  const candidateJs = fs.readFileSync(CANDIDATE, 'utf8');
  const recent      = experiments.slice(-5).map(e =>
    `  exp ${e.n}: val=${e.valSharpe.toFixed(3)} ${e.accepted ? '✅' : '❌'} — ${e.description}`
  ).join('\n') || '  (none yet)';

  const prompt = `You are a quantitative researcher improving a crypto momentum strategy.
The strategy scores tokens 0–1. Top 5 scorers are held equal-weight each day.
Evaluated on 55 tokens (50 majors + 5 Base chain) across 730 days.
Regime: Currently BEAR (BTC below 200d MA). BEAR = 0.3× score multiplier.

## Current state
- Best validation Sharpe: ${state.bestValSharpe.toFixed(3)}
- Experiment: ${state.expCount + 1}

## Research brief
${programMd.slice(0, 1500)}

## Current candidate.js
\`\`\`javascript
${candidateJs}
\`\`\`

## Recent experiments (last 5)
${recent}

## Your task
Make ONE small, specific change to improve out-of-sample (validation) Sharpe.
Think about: what signal is being double-counted? what's overfit? what's missing?

RULES — CRITICAL:
1. Output ONLY valid JavaScript — NO markdown fences, NO backticks, NO prose
2. File MUST start with /** and end with: module.exports = { scoreToken };
3. scoreToken MUST be defined and exported
4. No require/import statements
5. Keep changes minimal — one hypothesis at a time`;

  return callLLM([{ role: 'user', content: prompt }]);
}

async function run() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  delu bench10 — ${N_EXPERIMENTS} experiments with ${BANKR_LLM_MODEL}`);
  console.log(`${'═'.repeat(50)}`);

  const baseline = runEvaluate();
  if (!baseline) { console.error('❌ baseline eval failed'); process.exit(1); }

  let state = loadState();
  console.log(`  Baseline: val=${state.bestValSharpe.toFixed(3)} | is=${baseline.inSample.sharpe.toFixed(3)}\n`);

  const results = [];
  let improvements = 0;

  for (let i = 0; i < N_EXPERIMENTS; i++) {
    const experiments = loadExps();
    state = loadState();
    state.expCount++;

    console.log(`[${'█'.repeat(i+1)}${'░'.repeat(N_EXPERIMENTS-i-1)}] exp ${state.expCount} / best=${state.bestValSharpe.toFixed(3)}`);

    const backup = fs.readFileSync(CANDIDATE, 'utf8');
    let accepted = false, description = 'unknown', newVal = -999;

    try {
      const t0 = Date.now();
      const newCode = await proposeChange(state, experiments);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (!newCode || newCode.length < 100) throw new Error('response too short');

      // Syntax check
      try { new Function(newCode); } catch(e) { throw new Error(`syntax: ${e.message.slice(0,60)}`); }
      if (!newCode.includes('scoreToken') || !newCode.includes('module.exports')) {
        throw new Error('missing scoreToken or module.exports');
      }

      fs.writeFileSync(CANDIDATE, newCode);
      const result = runEvaluate();
      if (!result) throw new Error('evaluator returned null');

      newVal = result.validation.sharpe;
      const delta = newVal - state.bestValSharpe;
      const sign = delta >= 0 ? '+' : '';

      const match = newCode.match(/\/\/ (exp \d+:|change:|hypothesis:|\w+:) (.+)/i);
      description = match ? match[2].slice(0, 60) : `experiment ${state.expCount}`;

      if (newVal > state.bestValSharpe) {
        state.bestValSharpe = newVal;
        accepted = true;
        improvements++;
        console.log(`  ✅ IMPROVED  val=${newVal.toFixed(3)} (${sign}${delta.toFixed(3)}) is=${result.inSample.sharpe.toFixed(3)} [${elapsed}s]`);
        console.log(`     → "${description}"`);
        try { gitCommit(`exp ${state.expCount}: ${sign}${delta.toFixed(3)} val_sharpe — ${description}`.replace(/"/g,"'")); } catch {}
      } else {
        fs.writeFileSync(CANDIDATE, backup);
        console.log(`  ❌ reverted  val=${newVal.toFixed(3)} (${sign}${delta.toFixed(3)}) is=${result.inSample.sharpe.toFixed(3)} [${elapsed}s]`);
      }

      results.push({ n: state.expCount, val: newVal, delta, accepted, description });
      saveExps([...experiments, { n: state.expCount, valSharpe: newVal, isSharpe: result.inSample.sharpe, accepted, description, ts: Date.now() }]);
      saveState(state);

    } catch(e) {
      fs.writeFileSync(CANDIDATE, backup);
      console.log(`  ⚠️  ERROR: ${e.message}`);
      results.push({ n: state.expCount, val: -999, delta: -999, accepted: false, description: `error: ${e.message.slice(0,40)}` });
      saveExps([...experiments, { n: state.expCount, valSharpe: -999, isSharpe: 0, accepted: false, description: `error: ${e.message.slice(0,50)}`, ts: Date.now() }]);
      saveState(state);
    }

    // Small delay to avoid rate limits
    if (i < N_EXPERIMENTS - 1) await new Promise(r => setTimeout(r, 2000));
  }

  const cost = loadCost();
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${improvements}/${N_EXPERIMENTS} improved`);
  console.log(`  Final best val: ${state.bestValSharpe.toFixed(3)}`);
  console.log(`  Cost: ~$${cost.estimatedSpend.toFixed(3)} total (${cost.totalCalls} calls)`);
  console.log(`${'═'.repeat(50)}\n`);
}

run().catch(e => { console.error(e); process.exit(1); });
