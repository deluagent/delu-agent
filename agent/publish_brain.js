/**
 * publish_brain.js — Publish brain evolution data to delu-site
 *
 * Exports:
 *   - breakthroughs: timeline of score improvements per loop
 *   - currentBrain: plain-english summary of live scoring logic
 *   - stats: total experiments, acceptance rate, best scores
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const AGENT_DIR = path.join(__dirname, '..');
const SITE_DIR  = '/data/workspace/delu-site';
const OUT_FILE  = path.join(SITE_DIR, 'public', 'data', 'brain.json');

const LOOPS = [
  { file: 'experiments_5m.json',      name: '5m',      metric: 'score',     candidate: 'candidate_5m.js',      color: 'orange'  },
  { file: 'experiments_onchain.json', name: 'Onchain', metric: 'score',     candidate: 'candidate_onchain.js', color: 'indigo'  },
  { file: 'experiments_hourly.json',  name: 'Hourly',  metric: 'score',     candidate: 'candidate_hourly.js',  color: 'emerald' },
  { file: 'experiments.json',         name: 'Daily',   metric: 'valSharpe', candidate: 'candidate.js',         color: 'blue'    },
];

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function extractBreakthroughs(exps, metric) {
  let best = -999;
  const out = [];
  exps.forEach(e => {
    const score = e[metric] ?? e.score ?? -999;
    if (e.accepted && score > best && score > 0) {
      best = score;
      const desc = e.description &&
        !e.description.startsWith('exp ') &&
        !e.description.startsWith('experiment') &&
        !e.description.startsWith('error') ? e.description : null;
      out.push({
        n:    e.n,
        score: parseFloat(score.toFixed(3)),
        ts:   e.ts,
        description: desc,
      });
    }
  });
  return out;
}

// Extract key signals from candidate JS source as plain english
function summariseBrain(candidateFile) {
  try {
    const src = fs.readFileSync(path.join(AGENT_DIR, 'autoresearch', candidateFile), 'utf8');
    const signals = [];

    // ── Relative strength signals ──────────────────────────────
    if (src.includes('relStr7d') || src.includes('tokenRet7d')) signals.push('Relative strength vs BTC (7d)');
    else if (src.includes('relStr4h') || src.includes('relStr') || src.includes('rs =')) signals.push('Relative strength vs BTC (4h)');

    // ── RSI signals ───────────────────────────────────────────
    if (src.includes('oversoldBounce')) {
      signals.push('RSI oversold bounce + volume confirmation');
    } else if (src.includes('rsi')) {
      const rsiMatch = src.match(/rsi\(prices,\s*(\d+)\)/);
      const period = rsiMatch ? rsiMatch[1] : '14';
      if (src.match(/rsi\w*\s*[>]\s*5[5-9]|rsi\w*\s*[>]\s*6\d/)) signals.push(`RSI(${period}) momentum zone`);
      if (src.match(/rsi\w*\s*[<]\s*[34]\d/)) signals.push(`RSI(${period}) oversold bounce`);
    }

    // ── Onchain / wallet signals ──────────────────────────────
    if (src.includes('uniqueBuyers') && src.includes('repeatBuyers')) signals.push('Smart wallet accumulation (unique + repeat buyers)');
    else if (src.includes('transferStats') || src.includes('uniqueBuyers')) signals.push('Onchain transfer stats (Alchemy)');
    if (src.includes('topBuyerConcentration')) signals.push('Whale concentration penalty (>50% = red flag)');
    if (src.includes('transferVelocity')) signals.push('Transfer velocity burst detection');

    // ── Volatility / regime signals ───────────────────────────
    if (src.includes('rangeCoil') || src.includes('coilBreakout')) signals.push('Range coil + breakout detection');
    if (src.includes('realizedVol')) signals.push('Realized volatility regime filter');
    if (src.includes('adaptiveVolThreshold')) signals.push('Adaptive volume threshold (momentum-scaled)');
    else if (src.includes('volBurst') || src.includes('volSignal')) signals.push('Volume burst (directional-filtered)');

    // ── Momentum signals ─────────────────────────────────────
    if (src.includes('relAccel') || src.includes('momentumAccel')) signals.push('Momentum acceleration vs BTC');
    if (src.includes('isMomentum') && src.includes('isMeanReversion')) signals.push('Dual-regime: momentum / mean-reversion');
    else if (src.includes('isMomentum')) signals.push('Momentum regime detection');
    if (src.includes('meanRev') || src.includes('meanReversionBoost')) signals.push('Mean-reversion Z-score filter');

    // ── Trend / MA signals ────────────────────────────────────
    if (src.includes('sma8') && src.includes('sma20')) signals.push('SMA(8/20) trend crossover');
    else if (src.includes('ema(') || src.includes('sma(')) signals.push('EMA/SMA trend filter');

    // ── BTC gate / correlation ────────────────────────────────
    if (src.includes('btcGate')) signals.push('BTC gate (blocks entry on BTC breakdown)');
    else if (src.includes('btcPrices') || src.includes('btcRet')) signals.push('BTC correlation context');

    // ── Bounce / pullback ─────────────────────────────────────
    if (src.includes('bounceSignal') || src.includes('coilBreakout')) signals.push('Coil breakout + pullback entry');

    return signals.slice(0, 7);
  } catch { return []; }
}

function run() {
  const allBreakthroughs = [];
  const loopStats = [];

  LOOPS.forEach(({ file, name, metric, candidate, color }) => {
    const exps = readJSON(path.join(AGENT_DIR, 'autoresearch', file), []);
    const accepted = exps.filter(e => e.accepted && (e[metric] ?? e.score ?? -999) > 0);
    const bts = extractBreakthroughs(exps, metric);
    const bestScore = bts.length ? bts[bts.length - 1].score : 0;
    const signals = summariseBrain(candidate);

    bts.forEach(b => allBreakthroughs.push({ ...b, loop: name, color }));

    loopStats.push({
      name, color,
      expCount:      exps.length,
      acceptedCount: accepted.length,
      acceptRate:    exps.length ? parseFloat((accepted.length / exps.length * 100).toFixed(1)) : 0,
      bestScore,
      breakthroughCount: bts.length,
      signals,
      latestDescription: bts.filter(b => b.description).slice(-1)[0]?.description || null,
    });
  });

  // Sort all breakthroughs by time
  allBreakthroughs.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const totalExp   = loopStats.reduce((s, l) => s + l.expCount, 0);
  const totalAcc   = loopStats.reduce((s, l) => s + l.acceptedCount, 0);
  const topScore   = Math.max(...loopStats.map(l => l.bestScore));
  const topLoop    = loopStats.find(l => l.bestScore === topScore)?.name || '';

  const out = {
    generatedAt:    new Date().toISOString(),
    totalExp,
    totalAccepted:  totalAcc,
    topScore:       parseFloat(topScore.toFixed(3)),
    topLoop,
    loops:          loopStats,
    breakthroughs:  allBreakthroughs,
  };

  fs.mkdirSync(path.join(SITE_DIR, 'public', 'data'), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`[publish_brain] ${totalExp} experiments, ${allBreakthroughs.length} breakthroughs → ${OUT_FILE}`);
  return out;
}

module.exports = { run };
if (require.main === module) run();
