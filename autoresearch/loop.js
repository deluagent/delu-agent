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
// Use node-fetch instead of built-in fetch — avoids undici connection-pool hang in nohup background
const nodeFetch = require('node-fetch');

// ── Config ───────────────────────────────────────────────────
const DIR          = __dirname;
const CANDIDATE    = path.join(DIR, 'candidate.js');
const PROGRAM      = path.join(DIR, 'program.md');
const EXPERIMENTS  = path.join(DIR, 'experiments.json');
const STATE        = path.join(DIR, 'state.json');
const INTERVAL_MS  = 5_000;   // 5s — maximize experiment throughput   // 90s between experiments

// Model: Venice AI — claude-sonnet-4-6 with private mode
// Private inference: no data logging, no training on our strategy
const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const VENICE_MODEL   = 'claude-haiku-4-5-20251001'; // used in log only
const ANTHROPIC_KEY  = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');

// Keep Bankr as fallback reference (credits exhausted)
const BANKR_LLM_API   = 'https://llm.bankr.bot/v1/chat/completions';
const BANKR_API_KEY   = process.env.BANKR_API_KEY;

// Cost guard (Venice is within plan — just track calls)
const COST_PER_CALL_EST = 0.003; // claude-sonnet-4-5 ~3k tokens in+out
const MAX_SPEND_USD     = 999;   // effectively unlimited on Venice plan
const COST_TRACK_FILE   = path.join(DIR, 'cost_track.json');

function loadCostTrack() {
  try { return JSON.parse(fs.readFileSync(COST_TRACK_FILE, 'utf8')); } catch { return { totalCalls: 0, estimatedSpend: 0 }; }
}
function saveCostTrack(t) { fs.writeFileSync(COST_TRACK_FILE, JSON.stringify(t, null, 2)); }
function checkBudget() {
  const t = loadCostTrack();
  if (t.estimatedSpend >= MAX_SPEND_USD) {
    console.error(`\n⛔ Budget guard: estimated spend $${t.estimatedSpend.toFixed(3)} >= $${MAX_SPEND_USD} limit. Stopping loop.`);
    console.error(`   Total calls: ${t.totalCalls} | Add more Bankr LLM credits to continue.`);
    process.exit(1);
  }
  return t;
}

// ── State ────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { bestValSharpe: -999, expCount: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

function loadExperiments() {
  try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); } catch { return []; }
}
function saveExperiments(exps) { fs.writeFileSync(EXPERIMENTS, JSON.stringify(exps, null, 2)); }

// ── Anthropic direct (Bankr credits exhausted) ────────────────
async function callLLM(messages) {
  const track = checkBudget();
  const _t0 = Date.now();
  return callAnthropic(messages).then(r => { track.totalCalls++; track.estimatedSpend += COST_PER_CALL_EST; saveCostTrack(track); return r; });
}
async function callLLM_BANKR_DISABLED(messages) {
  const _t0 = Date.now();
  const bankrKey = (process.env.BANKR_API_KEY || '').replace(/\s/g, '');
  if (!bankrKey) throw new Error('No BANKR_API_KEY');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages,
  });
  const data = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'llm.bankr.bot', port: 443, method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bankrKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error(`JSON parse failed: ${raw.slice(0,100)}`)); }
      });
    });
    req.on('error', reject);
    const _timeout = setTimeout(() => { req.destroy(); reject(new Error('Bankr LLM timeout 60s')); }, 60000);
    req.on('close', () => clearTimeout(_timeout));
    req.write(body); req.end();
  });
  console.log(`   [bankr-llm] ${((Date.now()-_t0)/1000).toFixed(1)}s | tokens=${data.usage?.completion_tokens}`);
  if (data.error) {
    const msg = JSON.stringify(data.error);
    if (msg.includes('Insufficient') || msg.includes('credits') || msg.includes('402') || msg.includes('rate_limit') || msg.includes('Too many')) {
      console.log('   [bankr-llm] Credits exhausted — Anthropic fallback');
      return callAnthropic(messages);
    }
    throw new Error(`Bankr LLM error: ${msg.slice(0,100)}`);
  }

  track.totalCalls++;
  track.estimatedSpend += COST_PER_CALL_EST;
  saveCostTrack(track);

  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(messages) {
  const key = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
  if (!key) throw new Error('No ANTHROPIC_API_KEY');
  const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, messages });
  const data = await new Promise((resolve, reject) => {
    const req = require('https').request({
      hostname: 'api.anthropic.com', port: 443, method: 'POST',
      path: '/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let r=''; res.on('data',d=>r+=d); res.on('end',()=>{ try{resolve(JSON.parse(r))}catch(e){reject(new Error(r.slice(0,100)))} }); });
    req.on('error', reject);
    req.write(body); req.end();
  });
  if (data.error) throw new Error(`Anthropic error: ${JSON.stringify(data.error).slice(0,80)}`);
  return data.content?.[0]?.text || '';
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

function loadLiveFeedback() {
  try {
    const fb = JSON.parse(fs.readFileSync(path.join(DIR, 'live_feedback.json'), 'utf8'));
    if (!fb.length) return '';
    const wins = fb.filter(f => f.won).length;
    const avg  = (fb.reduce((s, f) => s + f.pnlPct, 0) / fb.length).toFixed(2);
    const recent = fb.slice(-5).map(f =>
      `  ${f.sym} | ${f.won ? 'WIN' : 'LOSS'} ${f.pnlPct?.toFixed(2)}% | regime=${f.regime} | reason=${f.reason}`
    ).join('\n');
    return `## Live trade outcomes (${fb.length} closed trades | WR=${wins}/${fb.length} | avgPnL=${avg}%)\n${recent}`;
  } catch { return ''; }
}

// ── Propose change via Venice ────────────────────────────────
async function proposeChange(state, experiments) {
  const programMd    = fs.readFileSync(PROGRAM, 'utf8');
  const candidateJs  = fs.readFileSync(CANDIDATE, 'utf8');
  const agentHistory = loadAgentHistory();
  const liveFeedback = loadLiveFeedback();

  const recentExps = experiments.slice(-6).map(e =>
    `  exp ${e.n}: val_sharpe=${e.valSharpe.toFixed(3)} ${e.accepted ? '✅ KEPT' : '❌ reverted'} — ${e.description}`
  ).join('\n') || '  (none yet)';

  // Extract just the scoreToken function to keep prompt small (avoid Bankr LLM token cap)
  const scoreTokenIdx = candidateJs.indexOf('\nfunction scoreToken');
  const scoreTokenSection = scoreTokenIdx >= 0 ? candidateJs.slice(scoreTokenIdx).trim() : candidateJs.slice(-2000);
  const helperSection = scoreTokenIdx >= 0 ? candidateJs.slice(0, scoreTokenIdx).trim() : '';

  const prompt = `You are improving a crypto momentum trading strategy (55 tokens, 730 days OHLCV).
Strategy: score tokens daily, hold top 5. Metric: 0.7*val_sharpe + 0.3*aud_sharpe.
Current best: val=${state.bestValSharpe.toFixed(3)} combined=${(state.bestScore||0).toFixed(3)}

Available helpers already defined (DO NOT redefine): pctChange, realizedVol, sma, emaVal, emaGap, zScore
scoreToken receives: { prices, volumes, highs, lows, btcPrices, flowSignal }

## Recent experiments
${recentExps}

${liveFeedback ? liveFeedback + '\n' : ''}## Key hypotheses to try (pick ONE)
${programMd.match(/## Hypotheses[\s\S]*?(?=\n##|\n#|$)/)?.[0]?.slice(0, 600) || '- Try OBV divergence\n- Try volume surprise\n- Try ATR penalty'}

## Current scoreToken function
${scoreTokenSection}

## Task
First line: DESCRIPTION: <one short sentence describing your change, e.g. "RSI period 8 instead of 14">
Then the new scoreToken function + module.exports line.
Start with: DESCRIPTION: ...
Then: function scoreToken(data) {
End with: }

module.exports = { scoreToken };

ONE small change. No helpers redefined. No markdown. Pure JS only.`;

  const response = await callLLM([{ role: 'user', content: prompt }]);

  // Reconstruct full candidate: helpers + new scoreToken
  const stripped = response
    .replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    .trim();

  // If response has full file (starts with /**), use as-is
  if (stripped.startsWith('/**') || stripped.startsWith('//')) {
    return stripped;
  }
  // Otherwise prepend helpers
  if (stripped.includes('function scoreToken')) {
    return helperSection + '\n' + stripped;
  }
  return stripped; // fallback — syntax check will catch it
}

// ── Main loop ────────────────────────────────────────────────
async function loop() {
  console.log('🔬 delu autoresearch loop starting...');
  console.log(`   candidate: ${CANDIDATE}`);
  console.log(`   interval:  ${INTERVAL_MS / 1000}s`);
  console.log(`   model:     claude-sonnet-4-5 via Bankr LLM`);
  const ct = loadCostTrack();
  console.log(`   budget:    $${ct.estimatedSpend.toFixed(3)} spent / $${MAX_SPEND_USD} limit (${ct.totalCalls} calls)\n`);

  // Baseline on first run
  const baseline = runEvaluate();
  if (!baseline) { console.error('❌ Evaluator failed on baseline — check candidate.js'); process.exit(1); }

  let state = loadState();
  // Use the higher of: fresh eval OR previously saved best (handles manual resets)
  const measuredBaseline = baseline.validation.sharpe;
  if (state.expCount === 0 || measuredBaseline > state.bestValSharpe) {
    // Only update if measured is better (don't clobber a manually-set baseline)
    if (measuredBaseline > state.bestValSharpe) {
      state.bestValSharpe = measuredBaseline;
      saveState(state);
    }
  }
  console.log(`📏 Baseline: val_sharpe=${state.bestValSharpe.toFixed(3)} | measured=${measuredBaseline.toFixed(3)} | is_sharpe=${baseline.inSample.sharpe.toFixed(3)}`);

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

      // Extract DESCRIPTION: line first, then strip it from code
      const descMatch = newCode.match(/^DESCRIPTION:\s*(.+)/m);
      if (descMatch) {
        description = descMatch[1].trim().slice(0, 100);
        newCode = newCode.replace(/^DESCRIPTION:.*\n?/m, '').trim();
      } else {
        // Fallback: extract from first comment line
        const match = newCode.match(/\/\/ (exp \d+:|change:|hypothesis:|\w+:) (.+)/i);
        description = match ? match[2].slice(0, 80) : `experiment ${state.expCount}`;
      }

      // Validate JS syntax before writing
      try {
        new Function(newCode); // throws SyntaxError if invalid
      } catch(syntaxErr) {
        throw new Error(`syntax error in generated code: ${syntaxErr.message.slice(0, 100)}`);
      }
      // Must export scoreToken
      if (!newCode.includes('scoreToken') || !newCode.includes('module.exports')) {
        throw new Error('generated code missing scoreToken or module.exports');
      }

      // Apply the change
      fs.writeFileSync(CANDIDATE, newCode);
      console.log(`   Applying change: "${description}"`);

      // Evaluate
      result = runEvaluate();
      if (!result) throw new Error('evaluator returned null');

      const newValSharpe = result.validation.sharpe;
      const newAudSharpe = result.audit.sharpe;
      // Combined score: val must improve AND audit must stay >= 0
      // Weight: 70% val, 30% audit (want val to lead but audit can't collapse)
      const newScore    = 0.7 * newValSharpe + 0.3 * newAudSharpe;
      const oldScore    = state.bestScore ?? (0.7 * state.bestValSharpe + 0.3 * 0);
      const improvement = newValSharpe - state.bestValSharpe;

      console.log(`   Result: val=${newValSharpe.toFixed(3)} aud=${newAudSharpe.toFixed(3)} score=${newScore.toFixed(3)} (${improvement >= 0 ? '+' : ''}${improvement.toFixed(3)} val) | is=${result.inSample.sharpe.toFixed(3)}`);

      // Accept only if combined score improves AND audit is non-catastrophic (> -0.5)
      if (newScore > oldScore && newAudSharpe > -0.5) {
        // Keep it — commit
        state.bestValSharpe = newValSharpe;
        state.bestScore     = newScore;
        saveState(state);
        accepted = true;
        const commitMsg = `exp ${state.expCount}: +${improvement.toFixed(3)} val_sharpe (aud=${newAudSharpe.toFixed(2)}) — ${description}`;
        try {
          saveExperiments([...experiments, { n: state.expCount, valSharpe: newValSharpe, audSharpe: newAudSharpe, isSharpe: result.inSample.sharpe, accepted, description, ts: Date.now() }]);
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
