/**
 * loop_onchain.js — Autoresearch loop using REAL Base onchain data (Alchemy)
 *
 * No Binance. No synthetic data.
 * Evolves candidate_onchain.js on 18 Base tokens × 720 1h bars.
 * Data refreshed from Alchemy before each run.
 *
 * Metric: 0.5 × val_sharpe + 0.5 × aud_sharpe
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const https = require('https');

const DIR          = __dirname;
const CANDIDATE    = path.join(DIR, 'candidate_onchain.js');
const STATE_FILE   = path.join(DIR, 'state_onchain.json');
const EXPERIMENTS  = path.join(DIR, 'experiments_onchain.json');
const FEEDBACK     = path.join(DIR, 'live_feedback.json');
const INTERVAL_S   = 5;

console.log('\n🔬 Autoresearch — Onchain (Base/Alchemy)');

// ── State helpers ─────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { bestValSharpe: -999, bestAudSharpe: -999, bestScore: -999, expCount: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function loadExps()   { try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); } catch { return []; } }
function saveExps(e)  { fs.writeFileSync(EXPERIMENTS, JSON.stringify(e)); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }

function loadFeedback() {
  try {
    const fb = JSON.parse(fs.readFileSync(FEEDBACK, 'utf8'));
    if (!fb.length) return '';
    const wins = fb.filter(f => f.won).length;
    const avg  = (fb.reduce((s, f) => s + f.pnlPct, 0) / fb.length).toFixed(2);
    const recent = fb.slice(-5).map(f =>
      `  ${f.sym} ${f.won ? 'WIN' : 'LOSS'} ${f.pnlPct?.toFixed(2)}% | regime=${f.regime}`
    ).join('\n');
    return `## Live trade outcomes on Base (${fb.length} closed | WR=${wins}/${fb.length} | avg=${avg}%)\n${recent}`;
  } catch { return ''; }
}

// ── Run evaluator ─────────────────────────────────────────────
function runEval() {
  // Clear require cache so candidate changes take effect
  delete require.cache[require.resolve('./evaluate_onchain')];
  delete require.cache[require.resolve('./candidate_onchain')];
  try {
    const { evaluate } = require('./evaluate_onchain');
    return evaluate(false);
  } catch(e) {
    console.error('[eval] Error:', e.message?.slice(0, 80));
    return null;
  }
}

// ── LLM — Bankr gateway with Anthropic fallback ───────────────
async function callLLM(messages) {
  const bankrKey = (process.env.BANKR_API_KEY || '').replace(/\s/g, '');
  const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');

  // Try Bankr LLM first
  if (bankrKey) {
    try {
      const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, messages });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'llm.bankr.bot', port: 443, method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bankrKey}`, 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => {
            try {
              const j = JSON.parse(d);
              if (j.error?.type === 'insufficient_credits' || j.error?.type === 'rate_limit') {
                reject(new Error('bankr_credits'));
              } else if (j.error) {
                reject(new Error('Bankr: ' + j.error.message));
              } else {
                resolve(j.choices?.[0]?.message?.content || '');
              }
            } catch(e) { reject(new Error('parse: ' + d.slice(0, 60))); }
          });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body); req.end();
      });
      return result;
    } catch(e) {
      if (e.message !== 'bankr_credits') throw e;
      // Credits exhausted — fall through to Anthropic
      console.log('   [llm] Bankr credits exhausted — using Anthropic Haiku');
    }
  }

  // Fallback: Anthropic Haiku direct
  if (!anthropicKey) throw new Error('No LLM available (no Bankr credits, no Anthropic key)');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 4000,
    messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', port: 443, method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) throw new Error('Anthropic: ' + JSON.stringify(j.error));
          resolve(j.content?.[0]?.text || '');
        } catch(e) { reject(new Error('parse: ' + d.slice(0, 60))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// ── Propose a change ──────────────────────────────────────────
async function propose(state, exps) {
  const candidateJs  = fs.readFileSync(CANDIDATE, 'utf8');
  const feedback     = loadFeedback();
  const recentExps   = exps.slice(-5).map(e =>
    `  exp${e.n}: combined=${e.score?.toFixed(3)} ${e.accepted ? '✅' : '❌'} ${e.description?.slice(0, 60)}`
  ).join('\n') || '  (none yet)';

  const scoreIdx = candidateJs.indexOf('\nfunction scoreToken');
  const helpers  = scoreIdx >= 0 ? candidateJs.slice(0, scoreIdx).trim() : '';
  const scoreFn  = scoreIdx >= 0 ? candidateJs.slice(scoreIdx).trim() : candidateJs.slice(-2000);

  const prompt = `You are improving a crypto trading strategy on REAL Base chain tokens (Alchemy onchain data).

IMPORTANT CONTEXT:
- Universe: WETH, AERO, VIRTUAL, AIXBT, BRETT, DEGEN, TOSHI, MOLT, KTA, LUKSO, trending tokens, etc.
- Data: 30 days × 1h bars from Alchemy Prices API — REAL onchain prices, no Binance
- Volume proxy = relative price-change magnitude (no raw DEX volume available)
- btcPrices = WETH prices (reference on Base, not BTC)
- Rebalance: every 4 bars (4h cadence)
- Metric: 0.5 × val_sharpe + 0.5 × aud_sharpe
- Current best: combined=${state.bestScore.toFixed(3)} val=${state.bestValSharpe.toFixed(3)}

AVAILABLE SIGNALS (from data object passed to scoreToken):
  prices[]    — hourly close prices (real Alchemy onchain)
  volumes[]   — relative activity proxy (price-change magnitude, 1=avg)
  highs[]     — hourly high (approx)
  lows[]      — hourly low (approx)
  btcPrices[] — WETH prices (Base reference)
  transferStats — onchain wallet signals (from alchemy_getAssetTransfers, last 500 txs):
    .uniqueBuyers         — distinct wallet addresses buying (high = distributed demand, organic)
    .transferVelocity     — total recent transfer count (high = active/hot token)
    .repeatBuyers         — wallets buying 3+ times (high = smart money accumulating)
    .topBuyerConcentration — fraction of txs from single wallet (> 0.3 = whale/bot risk)
    .txnCount24h          — 24h trade count from Bankr (< 100 = low activity)

Key insights for Base ecosystem:
- repeatBuyers > 3 is a strong accumulation signal (smart wallets loading up)
- High transferVelocity + low topBuyerConcentration = organic demand
- VIRTUAL/AIXBT/BRETT/DEGEN are meme/AI tokens: momentum + social velocity matters
- Relative strength vs WETH is the #1 signal (sector rotation on Base)
- RSI-8 outperforms RSI-14 on intraday data

## Recent experiments
${recentExps}

${feedback}

## Current scoreToken
${scoreFn.slice(0, 2000)}

## Task
DESCRIPTION: <one sentence describing your specific change>
function scoreToken(data) {
  // ONE targeted improvement
}
module.exports = { scoreToken };

Pure JS only. No markdown.`;

  const response = await callLLM([{ role: 'user', content: prompt }]);
  const descMatch = response.match(/^DESCRIPTION:\s*(.+)/m);
  const description = descMatch ? descMatch[1].trim().slice(0, 100) : `exp ${state.expCount + 1}`;
  let code = response.replace(/^DESCRIPTION:.*\n?/m, '').trim();
  code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (code.includes('function scoreToken') && !code.startsWith('function') && !code.startsWith('//') && !code.startsWith("'use strict'")) {
    code = helpers + '\n' + code;
  }
  return { code, description };
}

// ── Refresh onchain data every 6h ────────────────────────────
let lastDataRefresh = 0;
async function maybeRefreshData() {
  const age = Date.now() - lastDataRefresh;
  if (age < 6 * 3600 * 1000) return;
  try {
    const { fetchOnchainData } = require('./fetch_onchain');
    await fetchOnchainData();
    lastDataRefresh = Date.now();
    console.log('[data] Onchain data refreshed from Alchemy');
  } catch(e) {
    console.warn('[data] Refresh failed:', e.message?.slice(0, 50));
  }
}

// ── Main loop ─────────────────────────────────────────────────
async function main() {
  // Refresh data on startup
  await maybeRefreshData();
  lastDataRefresh = Date.now();

  const state = loadState();
  const best  = { code: fs.readFileSync(CANDIDATE, 'utf8') };

  // Bootstrap baseline
  if (state.bestScore <= -999) {
    console.log('Bootstrapping onchain baseline...');
    const r = runEval();
    if (r) {
      state.bestValSharpe = r.validation.sharpe;
      state.bestAudSharpe = r.audit.sharpe;
      state.bestScore     = 0.5 * r.validation.sharpe + 0.5 * r.audit.sharpe;
      saveState(state);
      console.log(`Baseline: val=${r.validation.sharpe.toFixed(3)} aud=${r.audit.sharpe.toFixed(3)} combined=${state.bestScore.toFixed(3)}`);
    }
  }

  let expN = state.expCount || 0;

  while (true) {
    expN++;
    await maybeRefreshData();

    console.log(`\n🧪 [onchain exp ${expN}] Best: val=${state.bestValSharpe.toFixed(3)} combined=${state.bestScore.toFixed(3)}`);
    const exps    = loadExps();
    const prevCode = fs.readFileSync(CANDIDATE, 'utf8');
    let accepted = false, description = `exp ${expN}`;
    let valSharpe = -999, audSharpe = -999, score = -999, isSharpe = -999;

    try {
      const t0 = Date.now();
      const { code: newCode, description: desc } = await propose(state, exps);
      description = desc;
      console.log(`   [llm] ${((Date.now()-t0)/1000).toFixed(1)}s | ${description}`);

      if (!newCode || newCode.length < 50) throw new Error('empty response');
      try { new Function(newCode); } catch(e) { throw new Error('syntax: ' + e.message.slice(0, 50)); }
      if (!newCode.includes('function scoreToken')) throw new Error('missing scoreToken');

      fs.writeFileSync(CANDIDATE, newCode);
      const result = runEval();

      if (result) {
        valSharpe = result.validation.sharpe;
        audSharpe = result.audit.sharpe;
        isSharpe  = result.inSample.sharpe;
        score     = 0.5 * valSharpe + 0.5 * audSharpe;
        const delta = score - (state.bestScore || -999);
        console.log(`   val=${valSharpe.toFixed(3)} aud=${audSharpe.toFixed(3)} combined=${score.toFixed(3)} (${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`);

        if (score > (state.bestScore || -999)) {
          accepted = true;
          state.bestValSharpe = valSharpe;
          state.bestAudSharpe = audSharpe;
          state.bestScore     = score;
          best.code           = newCode;
          saveState(state);
          console.log(`   ✅ ACCEPTED — new best! Promoting to quant_score.js...`);
          // Promote to live agent brain
          try {
            const agentDir = path.join(DIR, '../agent');
            const qsFile   = path.join(agentDir, 'quant_score.js');
            // Wrap with the hourly adapter header
            const header = `/**\n * quant_score.js — Promoted from onchain autoresearch exp ${expN}\n * val=${valSharpe.toFixed(3)} aud=${audSharpe.toFixed(3)} combined=${score.toFixed(3)}\n * Base tokens, Alchemy 1h data, ${new Date().toISOString()}\n */\n\n`;
            const adapted = newCode.replace('module.exports = { scoreToken };',
              `\nfunction scoreTokenHourly(data) { return scoreToken(data); }\nmodule.exports = { scoreToken, scoreTokenHourly };`);
            fs.writeFileSync(qsFile, header + adapted);
            console.log(`   🧠 quant_score.js updated`);
          } catch(e) { console.warn('   quant_score update failed:', e.message?.slice(0, 40)); }
        } else {
          console.log(`   ❌ REVERTED`);
          fs.writeFileSync(CANDIDATE, prevCode);
        }
      } else {
        console.log('   ❌ Eval null — reverted');
        fs.writeFileSync(CANDIDATE, prevCode);
      }
    } catch(e) {
      console.warn(`   Error: ${e.message?.slice(0, 80)}`);
      fs.writeFileSync(CANDIDATE, prevCode);
    }

    exps.push({ n: expN, ts: new Date().toISOString(), valSharpe, audSharpe, isSharpe, score, accepted, description });
    saveExps(exps);
    state.expCount = expN;
    saveState(state);

    await sleep(INTERVAL_S * 1000);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
