/**
 * loop.js — autonomous research loop
 *
 * Runs forever:
 *   1. Read program.md + current candidate.js + experiment history
 *   2. Ask Venice to propose ONE specific change
 *   3. Apply the change (Venice rewrites candidate.js)
 *   4. Run evaluate.js — get validation Sharpe
 *   5. If better: git commit
 *   6. If worse:  git revert candidate.js
 *   7. Log to experiments.json
 *   8. Sleep INTERVAL, repeat
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const { execSync, spawnSync } = require('child_process');
const https   = require('https');

// ── Config ───────────────────────────────────────────────────
const DIR          = __dirname;
const CANDIDATE    = path.join(DIR, 'candidate.js');
const PROGRAM      = path.join(DIR, 'program.md');
const EXPERIMENTS  = path.join(DIR, 'experiments.json');
const STATE        = path.join(DIR, 'state.json');
const INTERVAL_MS  = 90_000;   // 90s between experiments
const VENICE_KEY   = fs.readFileSync('/home/openclaw/.venice_key', 'utf8').trim();
const VENICE_MODEL = 'llama-3.3-70b';

// ── State ────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { bestValSharpe: -999, expCount: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

function loadExperiments() {
  try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); } catch { return []; }
}
function saveExperiments(exps) { fs.writeFileSync(EXPERIMENTS, JSON.stringify(exps, null, 2)); }

// ── Venice call ──────────────────────────────────────────────
async function callVenice(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: VENICE_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 3000,
    });

    const req = https.request({
      hostname: 'api.venice.ai',
      path:     '/api/v1/chat/completions',
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${VENICE_KEY}`,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.choices?.[0]?.message?.content || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Run evaluator ────────────────────────────────────────────
function runEvaluate() {
  // Clear require cache so new candidate.js is picked up
  delete require.cache[require.resolve('./candidate')];
  delete require.cache[require.resolve('./evaluate')];
  try {
    const { evaluate } = require('./evaluate');
    return evaluate(true);
  } catch(e) {
    return null;
  }
}

// ── Git helpers ──────────────────────────────────────────────
function gitCurrentCandidate() {
  return execSync('git -C /data/workspace/delu-agent show HEAD:autoresearch/candidate.js 2>/dev/null || echo ""', { encoding: 'utf8' });
}
function gitCommit(message) {
  execSync(`cd /data/workspace/delu-agent && git add autoresearch/candidate.js autoresearch/experiments.json autoresearch/state.json && git commit -m "${message}"`, { encoding: 'utf8' });
}
function gitRevert() {
  execSync('cd /data/workspace/delu-agent && git checkout HEAD -- autoresearch/candidate.js', { encoding: 'utf8' });
}

// ── Load agent trade history ─────────────────────────────────
function loadAgentHistory() {
  try {
    const logPath = path.join(DIR, '../data/agent_log.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => JSON.parse(l)).slice(-10);
    const recent = entries.map(e =>
      `  ${e.ts?.slice(0,16)} | regime=${e.regime} | decision=${e.decision?.action} ${e.decision?.asset} conf=${e.decision?.confidence}% | "${e.decision?.reasoning?.slice(0,60)}"`
    ).join('\n');
    return `## Agent recent decisions (last ${entries.length})\n${recent}`;
  } catch { return '## Agent history: none yet'; }
}

// ── Propose change via Venice ────────────────────────────────
async function proposeChange(state, experiments) {
  const programMd    = fs.readFileSync(PROGRAM, 'utf8');
  const candidateJs  = fs.readFileSync(CANDIDATE, 'utf8');
  const agentHistory = loadAgentHistory();

  const recentExps = experiments.slice(-6).map(e =>
    `  exp ${e.n}: val_sharpe=${e.valSharpe.toFixed(3)} ${e.accepted ? '✅ KEPT' : '❌ reverted'} — ${e.description}`
  ).join('\n') || '  (none yet)';

  const prompt = `You are an autonomous trading strategy researcher.
You are continuously improving a token-scoring function used by a live crypto trading agent.
The agent uses your score (as "AR signal") alongside other signals (trend, OBV, cross-rank, panic-bounce).
The agent currently has AR score weighted at 20% in BULL regime, 10% in RANGE, 0% in BEAR.

## Current state
- Best validation Sharpe so far: ${state.bestValSharpe.toFixed(3)}
- Experiment count: ${state.expCount}

## Research brief (program.md)
${programMd}

## Current candidate.js
\`\`\`javascript
${candidateJs}
\`\`\`

## Recent experiments
${recentExps}

${agentHistory}

## Your task
Propose ONE specific, small, logical change to improve validation Sharpe.
Avoid overfitting: changes that work only in-sample will be rejected.
Prefer: regime filters, vol-adjusted signals, tighter entry criteria.
The function receives: { prices, btcPrices, flowSignal, attentionDelta }
It must return a number 0-1. Higher = stronger buy signal.

Return ONLY the complete new candidate.js file. No explanation outside the code.
Start with the comment block, end with module.exports. No markdown fences.`;

  const response = await callVenice([{ role: 'user', content: prompt }]);

  // Strip any accidental markdown fences
  return response
    .replace(/^```javascript\n?/, '')
    .replace(/^```js\n?/, '')
    .replace(/```$/, '')
    .trim();
}

// ── Main loop ────────────────────────────────────────────────
async function loop() {
  console.log('🔬 delu autoresearch loop starting...');
  console.log(`   candidate: ${CANDIDATE}`);
  console.log(`   interval:  ${INTERVAL_MS / 1000}s`);
  console.log(`   model:     ${VENICE_MODEL}\n`);

  // Baseline on first run
  const baseline = runEvaluate();
  if (!baseline) { console.error('❌ Evaluator failed on baseline — check candidate.js'); process.exit(1); }

  let state = loadState();
  if (state.expCount === 0) {
    state.bestValSharpe = baseline.validation.sharpe;
    saveState(state);
    console.log(`📏 Baseline: val_sharpe=${baseline.validation.sharpe.toFixed(3)} | is_sharpe=${baseline.inSample.sharpe.toFixed(3)}`);
  }

  while (true) {
    const experiments = loadExperiments();
    state = loadState();
    state.expCount++;

    console.log(`\n🧪 [exp ${state.expCount}] Best so far: val_sharpe=${state.bestValSharpe.toFixed(3)}`);
    console.log('   Asking Venice for a change...');

    // Backup current candidate
    const backup = fs.readFileSync(CANDIDATE, 'utf8');

    let newCode, result, accepted = false, description = 'unknown';
    try {
      newCode = await proposeChange(state, experiments);
      if (!newCode || newCode.length < 100) throw new Error('empty response');

      // Extract description from first comment line
      const match = newCode.match(/\/\/ (exp \d+:|change:|hypothesis:|\w+:) (.+)/i);
      description = match ? match[2].slice(0, 80) : `experiment ${state.expCount}`;

      // Apply the change
      fs.writeFileSync(CANDIDATE, newCode);
      console.log(`   Applying change: "${description}"`);

      // Evaluate
      result = runEvaluate();
      if (!result) throw new Error('evaluator returned null');

      const newValSharpe = result.validation.sharpe;
      const improvement  = newValSharpe - state.bestValSharpe;

      console.log(`   Result: val_sharpe=${newValSharpe.toFixed(3)} (${improvement >= 0 ? '+' : ''}${improvement.toFixed(3)}) | is_sharpe=${result.inSample.sharpe.toFixed(3)}`);

      if (newValSharpe > state.bestValSharpe) {
        // Keep it — commit
        state.bestValSharpe = newValSharpe;
        saveState(state);
        accepted = true;
        const commitMsg = `exp ${state.expCount}: +${improvement.toFixed(3)} val_sharpe — ${description}`;
        try {
          saveExperiments([...experiments, { n: state.expCount, valSharpe: newValSharpe, isSharpe: result.inSample.sharpe, accepted, description, ts: Date.now() }]);
          gitCommit(commitMsg.replace(/"/g, "'"));
          console.log(`   ✅ KEPT — committed: "${commitMsg}"`);
        } catch(e) { console.log(`   ✅ KEPT (commit failed: ${e.message})`); }
      } else {
        // Revert
        fs.writeFileSync(CANDIDATE, backup);
        console.log(`   ❌ REVERTED — no improvement`);
        saveExperiments([...experiments, { n: state.expCount, valSharpe: newValSharpe, isSharpe: result?.inSample?.sharpe || 0, accepted: false, description, ts: Date.now() }]);
        saveState(state);
      }
    } catch(e) {
      console.log(`   ⚠️  Error: ${e.message} — reverting`);
      fs.writeFileSync(CANDIDATE, backup);
      saveExperiments([...experiments, { n: state.expCount, valSharpe: -999, isSharpe: 0, accepted: false, description: `error: ${e.message.slice(0,50)}`, ts: Date.now() }]);
      saveState(state);
    }

    console.log(`   Sleeping ${INTERVAL_MS / 1000}s...`);
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

loop().catch(e => { console.error('Fatal:', e); process.exit(1); });
