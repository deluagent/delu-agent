/**
 * evaluate.js — FIXED EVALUATOR — do not modify
 *
 * Three-way data split (Wayfinder-style):
 *   In-sample  (IS):  days 0–219   (60%) — agent sees this implicitly via score
 *   Validation (VAL): days 220–292 (20%) — used to accept/reject experiments
 *   Audit      (AUD): days 293–364 (20%) — reported only, never used for decisions
 *
 * Strategy: cross-sectional daily rebalance
 *   - Score all tokens each day using candidate.js
 *   - Long top 2 (equal weight) if score > MIN_SCORE
 *   - Execute at NEXT bar open (no lookahead)
 *   - No shorting, no leverage
 *
 * Metric: annualized Sharpe ratio on daily returns
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────
const HISTORY_DIR = path.join(__dirname, '../data/history');
const IS_END      = 219;   // in-sample ends at bar 219
const VAL_END     = 292;   // validation ends at bar 292 (audit = rest)
const LONG_COUNT  = 2;     // top N to hold
const MIN_SCORE   = 0.02;  // minimum score to enter a position
const TOKENS      = ['ETH', 'BTC', 'SOL', 'BNB', 'ARB', 'OP', 'LINK'];

// ── Load history ─────────────────────────────────────────────
function loadHistory() {
  const data = {};
  for (const sym of TOKENS) {
    const file = path.join(HISTORY_DIR, `${sym}_binance.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bars = raw.bars || raw;
      if (Array.isArray(bars) && bars.length >= 60) {
        data[sym] = bars.map(b => ({
          close:  b.close,
          open:   b.open,
          volume: b.volume,
          time:   b.time || b.ts,
        }));
      }
    } catch (e) { /* skip */ }
  }
  return data;
}

// ── Simulate period ───────────────────────────────────────────
function simulatePeriod(history, scoreToken, startBar, endBar) {
  const symbols  = Object.keys(history);
  const dailyRet = [];

  for (let day = startBar; day < endBar - 1; day++) {
    // Score each token using prices up to and including day (no lookahead)
    // Also pass BTC prices for regime detection
    const btcBars  = history['BTC'] || [];
    const btcPrices = btcBars.slice(0, day + 1).map(b => b.close);
    const scores = {};
    for (const sym of symbols) {
      const bars   = history[sym];
      if (!bars || bars.length <= day + 1) continue;
      const prices = bars.slice(0, day + 1).map(b => b.close);
      try {
        scores[sym] = scoreToken({ prices, btcPrices, flowSignal: 0, attentionDelta: 0 });
      } catch (e) {
        scores[sym] = 0;
      }
    }

    // Rank — long top LONG_COUNT above MIN_SCORE
    const ranked = Object.entries(scores)
      .filter(([, s]) => s > MIN_SCORE)
      .sort(([, a], [, b]) => b - a)
      .slice(0, LONG_COUNT);

    if (ranked.length === 0) {
      dailyRet.push(0);
      continue;
    }

    // Return = average of next-bar returns (open of day+1 to close of day+1)
    let ret = 0;
    let count = 0;
    for (const [sym] of ranked) {
      const bars  = history[sym];
      const entry = bars[day + 1]?.open;   // execute at next open
      const exit  = bars[day + 1]?.close;  // mark at next close
      if (entry && exit && entry > 0) {
        ret += (exit - entry) / entry;
        count++;
      }
    }
    dailyRet.push(count > 0 ? ret / count : 0);
  }

  return dailyRet;
}

// ── Metrics ───────────────────────────────────────────────────
function sharpe(returns) {
  if (returns.length < 5) return -999;
  const n    = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const std  = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

function maxDrawdown(returns) {
  let peak = 0, equity = 1, maxDD = 0;
  for (const r of returns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function winRate(returns) {
  const wins = returns.filter(r => r > 0).length;
  return returns.length > 0 ? wins / returns.length : 0;
}

function totalReturn(returns) {
  return returns.reduce((eq, r) => eq * (1 + r), 1) - 1;
}

// ── Main ──────────────────────────────────────────────────────
function evaluate(silent = false) {
  const history     = loadHistory();
  const { scoreToken } = require('./candidate');

  const isReturns  = simulatePeriod(history, scoreToken, 0,       IS_END);
  const valReturns = simulatePeriod(history, scoreToken, IS_END,   VAL_END);
  const audReturns = simulatePeriod(history, scoreToken, VAL_END,  365);

  const results = {
    inSample: {
      sharpe:      +sharpe(isReturns).toFixed(4),
      totalReturn: +totalReturn(isReturns).toFixed(4),
      maxDrawdown: +maxDrawdown(isReturns).toFixed(4),
      winRate:     +winRate(isReturns).toFixed(4),
      bars:        isReturns.length,
    },
    validation: {
      sharpe:      +sharpe(valReturns).toFixed(4),
      totalReturn: +totalReturn(valReturns).toFixed(4),
      maxDrawdown: +maxDrawdown(valReturns).toFixed(4),
      winRate:     +winRate(valReturns).toFixed(4),
      bars:        valReturns.length,
    },
    audit: {
      sharpe:      +sharpe(audReturns).toFixed(4),
      totalReturn: +totalReturn(audReturns).toFixed(4),
      maxDrawdown: +maxDrawdown(audReturns).toFixed(4),
      winRate:     +winRate(audReturns).toFixed(4),
      bars:        audReturns.length,
    },
  };

  if (!silent) {
    console.log('\n════════════════════════════════════════');
    console.log('  delu autoresearch — evaluator');
    console.log('════════════════════════════════════════');
    console.log(`  In-Sample   (${results.inSample.bars}d):  Sharpe=${results.inSample.sharpe.toFixed(3).padStart(7)}  ret=${(results.inSample.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.inSample.maxDrawdown*100).toFixed(1)}%  WR=${(results.inSample.winRate*100).toFixed(0)}%`);
    console.log(`  Validation  (${results.validation.bars}d):  Sharpe=${results.validation.sharpe.toFixed(3).padStart(7)}  ret=${(results.validation.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.validation.maxDrawdown*100).toFixed(1)}%  WR=${(results.validation.winRate*100).toFixed(0)}%`);
    console.log(`  Audit       (${results.audit.bars}d):  Sharpe=${results.audit.sharpe.toFixed(3).padStart(7)}  ret=${(results.audit.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.audit.maxDrawdown*100).toFixed(1)}%  WR=${(results.audit.winRate*100).toFixed(0)}%`);
    console.log('════════════════════════════════════════\n');
  }

  return results;
}

// Run standalone
if (require.main === module) evaluate(false);
module.exports = { evaluate };
