/**
 * evaluate_5m.js — Backtester for 5-minute signal candidates
 *
 * 30 days × 8640 bars per token
 * Rebalance: every 12 bars (1 hour)
 * Long/short: top 3 long + bottom 2 short
 * Metric: 0.5*val_sharpe + 0.5*aud_sharpe
 *
 * Data: data/history/{SYM}_binance_5m.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '../data/history');

const TOTAL_BARS  = 8640;   // 30 days of 5m bars
const IS_END      = 5184;   // 60% — Feb 19 → Mar 9
const VAL_END     = 6912;   // 80% — Mar 9 → Mar 15
// AUD: Mar 15 → Mar 21 (latest data)

const REBAL_BARS  = 12;     // rebalance every 12 bars = 1 hour
const LONG_COUNT  = 3;
const SHORT_COUNT = 2;
const MIN_SCORE   = 0.05;

// Annualisation: 5m bars/year = 252 * 6.5 * 12 = ~19656 (using crypto 365*24*12)
const ANNUAL_FACTOR = Math.sqrt(365 * 24 * 12);

const TOKENS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'LINK', 'AAVE', 'ARB',
  'NEAR', 'INJ', 'PEPE', 'WIF', 'MATIC', 'OP', 'UNI', 'AVAX',
  // AI / agent tokens (if fetched)
  'VIRTUAL', 'AGIX', 'RNDR', 'OCEAN', 'TAO', 'KAITO', 'TRUMP', 'BERA', 'FET', 'GRT', 'AIXBT',
];

// ── Load history ──────────────────────────────────────────────
function loadHistory() {
  const history = {};
  for (const sym of TOKENS) {
    const f = path.join(HISTORY_DIR, `${sym}_binance_5m.json`);
    if (!fs.existsSync(f)) continue;
    try {
      const raw  = JSON.parse(fs.readFileSync(f, 'utf8'));
      const bars = (raw.bars || raw).slice(-TOTAL_BARS);
      if (bars.length < 500) continue;
      history[sym] = bars;
    } catch {}
  }
  return history;
}

// ── Simulate one period ───────────────────────────────────────
function simulate(scoreToken, history, startBar, endBar) {
  const syms    = Object.keys(history);
  const btcBars = history['BTC'] || [];
  const returns = [];

  for (let bar = startBar; bar < endBar - 1; bar += REBAL_BARS) {
    const btcPrices = btcBars.slice(0, bar + 1).map(b => b.close);

    const scores = {};
    for (const sym of syms) {
      const bars = history[sym];
      if (!bars || bars.length <= bar + 1) continue;
      const sl = bars.slice(0, bar + 1);
      try {
        scores[sym] = scoreToken({
          prices:   sl.map(b => b.close),
          volumes:  sl.map(b => b.volume),
          highs:    sl.map(b => b.high),
          lows:     sl.map(b => b.low),
          opens:    sl.map(b => b.open),
          btcPrices,
          flowSignal:     0,
          attentionDelta: 0,
        }) || 0;
      } catch { scores[sym] = 0; }
    }

    // Long top LONG_COUNT where score > MIN_SCORE
    const longs = Object.entries(scores)
      .filter(([, s]) => s > MIN_SCORE && isFinite(s))
      .sort(([, a], [, b]) => b - a)
      .slice(0, LONG_COUNT);

    // Short bottom SHORT_COUNT where score < -MIN_SCORE
    const shorts = Object.entries(scores)
      .filter(([, s]) => s < -MIN_SCORE && isFinite(s))
      .sort(([, a], [, b]) => a - b)
      .slice(0, SHORT_COUNT);

    if (!longs.length && !shorts.length) {
      for (let i = 0; i < Math.min(REBAL_BARS, endBar - bar - 1); i++) returns.push(0);
      continue;
    }

    let ret = 0, cnt = 0;
    const exitBar = Math.min(bar + REBAL_BARS, endBar - 1);

    for (const [sym] of longs) {
      const bars  = history[sym];
      const entry = bars[bar + 1]?.open;
      const exit  = bars[exitBar]?.close;
      if (entry && exit && entry > 0) { ret += (exit - entry) / entry; cnt++; }
    }
    for (const [sym] of shorts) {
      const bars  = history[sym];
      const entry = bars[bar + 1]?.open;
      const exit  = bars[exitBar]?.close;
      if (entry && exit && entry > 0) { ret += -(exit - entry) / entry; cnt++; }
    }

    const periodRet = cnt ? ret / cnt : 0;
    const barsInPeriod = Math.min(REBAL_BARS, endBar - bar - 1);
    for (let i = 0; i < barsInPeriod; i++) returns.push(periodRet / barsInPeriod);
  }
  return returns;
}

// ── Metrics ───────────────────────────────────────────────────
function sharpe(rets) {
  if (rets.length < 10) return -999;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std  = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) || 1e-9;
  return (mean / std) * ANNUAL_FACTOR;
}

function maxDD(rets) {
  let peak = 1, equity = 1, dd = 0;
  for (const r of rets) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    dd = Math.max(dd, (peak - equity) / peak);
  }
  return dd;
}

function totalRet(rets) {
  return rets.reduce((e, r) => e * (1 + r), 1) - 1;
}

// ── Main ──────────────────────────────────────────────────────
function evaluate(silent = false) {
  const history = loadHistory();
  const tokenCount = Object.keys(history).length;

  // Load candidate
  let scoreToken;
  try {
    delete require.cache[require.resolve('./candidate_5m')];
    ({ scoreToken } = require('./candidate_5m'));
  } catch (e) {
    // fallback to candidate_hourly
    try {
      delete require.cache[require.resolve('./candidate_hourly')];
      ({ scoreToken } = require('./candidate_hourly'));
    } catch {
      console.error('No candidate found');
      process.exit(1);
    }
  }

  const isR  = simulate(scoreToken, history, 0, IS_END);
  const valR = simulate(scoreToken, history, IS_END, VAL_END);
  const audR = simulate(scoreToken, history, VAL_END, TOTAL_BARS);

  const result = {
    inSample:   { sharpe: sharpe(isR),  ret: totalRet(isR),  dd: maxDD(isR)  },
    validation: { sharpe: sharpe(valR), ret: totalRet(valR), dd: maxDD(valR) },
    audit:      { sharpe: sharpe(audR), ret: totalRet(audR), dd: maxDD(audR) },
    combined: 0.5 * sharpe(valR) + 0.5 * sharpe(audR),
    tokenCount,
  };

  if (!silent) {
    console.log('════════════════════════════════════════');
    console.log('  delu autoresearch — 5M evaluator');
    console.log(`  ${tokenCount} tokens | 5m bars | 1h rebalance`);
    console.log('════════════════════════════════════════');
    console.log(`  In-Sample   (${isR.length} bars):   Sharpe=${sharpe(isR).toFixed(3).padStart(7)}  ret=${(totalRet(isR)*100).toFixed(1).padStart(7)}%  DD=${(maxDD(isR)*100).toFixed(1)}%`);
    console.log(`  Validation  (${valR.length} bars):   Sharpe=${sharpe(valR).toFixed(3).padStart(7)}  ret=${(totalRet(valR)*100).toFixed(1).padStart(7)}%  DD=${(maxDD(valR)*100).toFixed(1)}%`);
    console.log(`  Audit       (${audR.length} bars):   Sharpe=${sharpe(audR).toFixed(3).padStart(7)}  ret=${(totalRet(audR)*100).toFixed(1).padStart(7)}%  DD=${(maxDD(audR)*100).toFixed(1)}%`);
    console.log('════════════════════════════════════════');
  }

  return result;
}

module.exports = { evaluate };

if (require.main === module) evaluate(false);
