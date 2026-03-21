/**
 * loop_multi.js — Multi-timeframe autoresearch launcher
 * 
 * Usage: node loop_multi.js <timeframe>
 * Timeframe: 4h | 30m | 15m
 * 
 * Each loop evolves its own candidate_<tf>.js using the same
 * hourly evaluator pattern but with different bar data.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const https = require('https');

const TF = process.argv[2] || '4h';
const VALID_TFS = ['4h', '30m', '15m'];
if (!VALID_TFS.includes(TF)) {
  console.error(`Usage: node loop_multi.js <${VALID_TFS.join('|')}>`);
  process.exit(1);
}

console.log(`\n🔬 Autoresearch loop — ${TF} bars`);

const DIR           = __dirname;
const CANDIDATE     = path.join(DIR, `candidate_${TF}.js`);
const STATE_FILE    = path.join(DIR, `state_${TF}.json`);
const EXPERIMENTS   = path.join(DIR, `experiments_${TF}.json`);
const FEEDBACK_FILE = path.join(DIR, 'live_feedback.json');
const COST_TRACK    = path.join(DIR, `cost_track_${TF}.json`);
const INTERVAL_S    = 5;

// ── Config per timeframe ──────────────────────────────────────
const TF_CONFIG = {
  '4h':  { suffix: '4h',  rebal: 1, barsDesc: '540 bars (90d)',  annualSqrt: Math.sqrt(365 * 6),   splits: { is: 0.6, val: 0.8 } },
  '30m': { suffix: '30m', rebal: 2, barsDesc: '1440 bars (30d)', annualSqrt: Math.sqrt(365 * 48),  splits: { is: 0.6, val: 0.8 } },
  '15m': { suffix: '15m', rebal: 4, barsDesc: '1440 bars (15d)', annualSqrt: Math.sqrt(365 * 96),  splits: { is: 0.6, val: 0.8 } },
};
const cfg = TF_CONFIG[TF];

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { bestValSharpe: -999, bestAudSharpe: -999, bestScore: -999, expCount: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function loadExperiments() {
  try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); } catch { return []; }
}
function saveExperiments(e) { fs.writeFileSync(EXPERIMENTS, JSON.stringify(e)); }

function loadCost() {
  try { return JSON.parse(fs.readFileSync(COST_TRACK, 'utf8')); } catch { return { spend: 0, calls: 0 }; }
}
function saveCost(c) { fs.writeFileSync(COST_TRACK, JSON.stringify(c)); }

function loadLiveFeedback() {
  try {
    const fb = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    if (!fb.length) return '';
    const wins = fb.filter(f => f.won).length;
    const avg  = (fb.reduce((s, f) => s + f.pnlPct, 0) / fb.length).toFixed(2);
    return `## Live trade outcomes (${fb.length} closed | WR=${wins}/${fb.length} | avg=${avg}%)`;
  } catch { return ''; }
}

// ── Load data ─────────────────────────────────────────────────
const HISTORY_DIR = path.join(__dirname, '../data/history');
const TOKENS = [
  'BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOGE',
  'LINK','AAVE','UNI','ARB','OP','MATIC',
  'FET','AGIX','OCEAN','RNDR',
  'PEPE','SHIB','BONK','WIF',
  'NEAR','APT','SUI','INJ',
];

function loadData() {
  const result = [];
  for (const sym of TOKENS) {
    const file = path.join(HISTORY_DIR, `${sym}_binance_${cfg.suffix}.json`);
    try {
      const bars = JSON.parse(fs.readFileSync(file, 'utf8'));
      result.push({ sym, bars });
    } catch { /* skip missing */ }
  }
  return result;
}

// ── Evaluate ──────────────────────────────────────────────────
function runEval(allData) {
  try {
    delete require.cache[require.resolve(CANDIDATE)];
    const { scoreToken } = require(CANDIDATE);
    if (typeof scoreToken !== 'function') return null;

    // Split data
    const n = allData[0]?.bars?.length || 0;
    const isEnd  = Math.floor(n * cfg.splits.is);
    const valEnd = Math.floor(n * cfg.splits.val);

    function evalPeriod(start, end) {
      const rebalBars = cfg.rebal;
      const dailyRets = [];
      
      for (let bar = start + 168; bar < end - rebalBars; bar += rebalBars) {
        const scores = allData.map(({ sym, bars }) => {
          const slice = bars.slice(0, bar);
          if (slice.length < 100) return { sym, score: 0 };
          try {
            const score = scoreToken({
              prices:    slice.map(b => b.close),
              volumes:   slice.map(b => b.volume),
              highs:     slice.map(b => b.high),
              lows:      slice.map(b => b.low),
              btcPrices: allData.find(d => d.sym === 'BTC')?.bars?.slice(0, bar)?.map(b => b.close) || [],
            }) || 0;
            return { sym, score: Math.max(-1, Math.min(1, score)) };
          } catch { return { sym, score: 0 }; }
        });

        const sorted = [...scores].sort((a, b) => b.score - a.score);
        const longs  = sorted.slice(0, 3).filter(s => s.score > 0.05);
        const shorts = sorted.slice(-2).filter(s => s.score < -0.05);
        if (!longs.length && !shorts.length) continue;

        let cycleRet = 0;
        for (const pos of longs) {
          const d = allData.find(d => d.sym === pos.sym);
          if (!d?.bars[bar + rebalBars]) continue;
          const ret = (d.bars[bar + rebalBars].close - d.bars[bar].close) / d.bars[bar].close;
          cycleRet += ret / (longs.length + shorts.length);
        }
        for (const pos of shorts) {
          const d = allData.find(d => d.sym === pos.sym);
          if (!d?.bars[bar + rebalBars]) continue;
          const ret = (d.bars[bar + rebalBars].close - d.bars[bar].close) / d.bars[bar].close;
          cycleRet -= ret / (longs.length + shorts.length);
        }
        dailyRets.push(cycleRet);
      }

      if (dailyRets.length < 10) return { sharpe: -999 };
      const mean = dailyRets.reduce((s, r) => s + r, 0) / dailyRets.length;
      const std  = Math.sqrt(dailyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyRets.length);
      const sharpe = std === 0 ? 0 : (mean / std) * cfg.annualSqrt;
      return { sharpe: parseFloat(sharpe.toFixed(4)) };
    }

    const is  = evalPeriod(0, isEnd);
    const val = evalPeriod(isEnd, valEnd);
    const aud = evalPeriod(valEnd, n);
    return { inSample: is, validation: val, audit: aud };
  } catch(e) {
    return null;
  }
}

// ── LLM ──────────────────────────────────────────────────────
const MODEL = 'claude-haiku-4-5-20251001';

function callLLM(messages) {
  return new Promise((resolve, reject) => {
    const key = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
    if (!key) return reject(new Error('No ANTHROPIC_API_KEY'));
    const body = JSON.stringify({ model: MODEL, max_tokens: 4000, messages });
    const req = https.request({
      hostname: 'api.anthropic.com', port: 443, method: 'POST',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'x-api-key': key, 'anthropic-version': '2023-06-01',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.content?.[0]?.text || '');
        } catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

async function proposeChange(state, experiments, allData) {
  const candidateJs  = fs.readFileSync(CANDIDATE, 'utf8');
  const liveFeedback = loadLiveFeedback();
  const recentExps   = experiments.slice(-5).map(e =>
    `  exp${e.n}: combined=${e.score?.toFixed(3)} ${e.accepted ? '✅' : '❌'} ${e.description}`
  ).join('\n') || '  (none yet)';

  const scoreIdx = candidateJs.indexOf('\nfunction scoreToken');
  const scoreSection = scoreIdx >= 0 ? candidateJs.slice(scoreIdx).trim() : candidateJs.slice(-2000);
  const helpers = scoreIdx >= 0 ? candidateJs.slice(0, scoreIdx).trim() : '';

  const prompt = `You are improving a crypto trading strategy on ${TF} bars (${cfg.barsDesc}).
Score range: [-1, +1]. Top 3 long + bottom 2 short. Rebalance every ${cfg.rebal} bar(s).
Metric: 0.5*val_sharpe + 0.5*aud_sharpe. Current best: combined=${state.bestScore.toFixed(3)}

Proven insights from similar research:
- RSI period 8 outperforms RSI 14 on hourly/intraday data (+5 Sharpe in study)
- Ensemble voting (majority of signals) beats weighted sums
- BB width compression (low percentile) precedes breakouts
- Simpler signals often outperform complex ones

Available helpers (DO NOT redefine): pctChange, realizedVol, sma, emaVal, zScore

## Recent experiments
${recentExps}

${liveFeedback}

## Current scoreToken
${scoreSection.slice(0, 2000)}

## Task
DESCRIPTION: <one sentence describing your change>
function scoreToken(data) {
  // ONE targeted change — test RSI-8, BB width, ensemble voting, or simplification
}
module.exports = { scoreToken };

Pure JS only. No markdown.`;

  const response = await callLLM([{ role: 'user', content: prompt }]);

  const descMatch = response.match(/^DESCRIPTION:\s*(.+)/m);
  const description = descMatch ? descMatch[1].trim().slice(0, 100) : `exp ${state.expCount + 1}`;
  let code = response.replace(/^DESCRIPTION:.*\n?/m, '').trim();
  code = code.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();

  if (code.includes('function scoreToken') && !code.startsWith('/**')) {
    code = helpers + '\n' + code;
  }

  return { code, description };
}

// ── Main loop ─────────────────────────────────────────────────
async function main() {
  const allData = loadData();
  console.log(`Loaded ${allData.length} tokens × ${allData[0]?.bars?.length || 0} ${TF} bars`);

  const state = loadState();
  const best  = { code: fs.readFileSync(CANDIDATE, 'utf8') };

  // Bootstrap best score if needed
  if (state.bestScore <= -999) {
    console.log('Bootstrapping baseline...');
    const r = runEval(allData);
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
    console.log(`\n🧪 [${TF} exp ${expN}] Best: combined=${state.bestScore.toFixed(3)}`);

    const experiments = loadExperiments();
    const prevCode = fs.readFileSync(CANDIDATE, 'utf8');

    let accepted = false, description = `exp ${expN}`;
    let valSharpe = -999, audSharpe = -999, score = -999, isSharpe = -999;

    try {
      const t0 = Date.now();
      const { code: newCode, description: desc } = await proposeChange(state, experiments, allData);
      description = desc;
      const ms = Date.now() - t0;
      console.log(`   [llm] ${(ms/1000).toFixed(1)}s | ${description}`);

      try { new Function(newCode); } catch(e) {
        console.log(`   ❌ Syntax error: ${e.message.slice(0,60)} — reverted`);
        throw new Error('syntax');
      }

      if (!newCode.includes('function scoreToken')) throw new Error('missing scoreToken');

      fs.writeFileSync(CANDIDATE, newCode);

      const result = runEval(allData);
      if (result) {
        valSharpe = result.validation.sharpe;
        audSharpe = result.audit.sharpe;
        isSharpe  = result.inSample.sharpe;
        score     = 0.5 * valSharpe + 0.5 * audSharpe;

        const improvement = score - (state.bestScore || -999);
        console.log(`   Result: val=${valSharpe.toFixed(3)} aud=${audSharpe.toFixed(3)} combined=${score.toFixed(3)} (${improvement >= 0 ? '+' : ''}${improvement.toFixed(3)})`);

        if (score > (state.bestScore || -999)) {
          accepted = true;
          state.bestValSharpe = valSharpe;
          state.bestAudSharpe = audSharpe;
          state.bestScore     = score;
          best.code           = newCode;
          saveState(state);
          console.log(`   ✅ ACCEPTED — new best!`);
        } else {
          console.log(`   ❌ REVERTED`);
          fs.writeFileSync(CANDIDATE, prevCode);
        }
      } else {
        console.log('   ❌ Eval null — reverted');
        fs.writeFileSync(CANDIDATE, prevCode);
      }
    } catch(e) {
      if (e.message !== 'syntax' && e.message !== 'missing scoreToken') {
        console.warn(`   Error: ${e.message?.slice(0,80)}`);
      }
      fs.writeFileSync(CANDIDATE, prevCode);
    }

    const expLog = loadExperiments();
    expLog.push({ n: expN, ts: new Date().toISOString(), valSharpe, audSharpe, isSharpe, score, accepted, description });
    saveExperiments(expLog);

    state.expCount = expN;
    saveState(state);

    // Cost tracking
    const cost = loadCost();
    cost.calls++;
    cost.spend = parseFloat((cost.spend + 0.001).toFixed(4));
    saveCost(cost);

    await sleep(INTERVAL_S * 1000);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
