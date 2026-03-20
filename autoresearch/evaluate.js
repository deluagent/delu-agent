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
 *
 * Signals passed to scoreToken:
 *   - prices, btcPrices: daily close arrays
 *   - fundingSignal: daily Binance perp funding rate z-score (inverted, bullish=positive)
 *     Cached in data/history/{SYM}_funding.json by fetch.js
 *     Falls back to 0 if not available (backward compatible)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────
const HISTORY_DIR = path.join(__dirname, '../data/history');
// 730 bars total (Mar 2024 – Mar 2026)
// IS:  bars 0–437   (60%) — Mar 2024 → Jul 2025 — includes bull run + correction
// VAL: bars 438–583 (20%) — Jul 2025 → Dec 2025 — bull continuation + peak
// AUD: bars 584–729 (20%) — Dec 2025 → Mar 2026 — bear drawdown (unseen)
const IS_END      = 438;
const VAL_END     = 584;
const TOTAL_BARS  = 730;
const LONG_COUNT  = 2;     // top N to hold
const MIN_SCORE   = 0.02;  // minimum score to enter a position

// Majors: 730 bars from Binance
const MAJOR_TOKENS = ['ETH', 'BTC', 'SOL', 'BNB', 'ARB', 'OP', 'LINK'];
// Base tokens: 181 bars from GeckoTerminal (Sep 2025 → Mar 2026)
// Split for Base: IS=0–108 (60%), VAL=109–144 (20%), AUD=145–180 (20%)
const BASE_TOKENS  = ['BRETT', 'VIRTUAL', 'AERO', 'DEGEN', 'CLANKER'];
const BASE_IS_END  = 109;
const BASE_VAL_END = 145;
const BASE_TOTAL   = 181;
const TOKENS = [...MAJOR_TOKENS, ...BASE_TOKENS];

// ── Load history ─────────────────────────────────────────────
function loadHistory() {
  const data = {};

  // Majors: prefer _binance_daily.json (protected from hourly overwrites)
  for (const sym of MAJOR_TOKENS) {
    const dailyFile  = path.join(HISTORY_DIR, `${sym}_binance_daily.json`);
    const legacyFile = path.join(HISTORY_DIR, `${sym}_binance.json`);
    const file = fs.existsSync(dailyFile) ? dailyFile : legacyFile;
    if (!fs.existsSync(file)) continue;
    try {
      const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bars = raw.bars || raw;
      if (Array.isArray(bars) && bars.length >= 60) {
        data[sym] = bars.map(b => ({ close: b.close, open: b.open, volume: b.volume, time: b.time || b.ts }));
      }
    } catch (e) { /* skip */ }
  }

  // Base tokens: GeckoTerminal daily cache (_gt_daily.json)
  for (const sym of BASE_TOKENS) {
    const file = path.join(HISTORY_DIR, `${sym}_gt_daily.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bars = raw.bars || raw;
      if (Array.isArray(bars) && bars.length >= 30) {
        data[sym] = bars.map(b => ({ close: b.close, open: b.open, volume: b.volume, time: b.time || b.ts }));
      }
    } catch (e) { /* skip */ }
  }

  return data;
}

// ── Load funding signals ──────────────────────────────────────
// Returns { ETH: { '2025-01-01': 0.12, ... }, ... }
// Falls back to empty object if cache doesn't exist
function loadFundingSignals() {
  const result = {};
  for (const sym of TOKENS) {
    const file = path.join(HISTORY_DIR, `${sym}_funding.json`);
    if (!fs.existsSync(file)) { result[sym] = {}; continue; }
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rates  = cached.rates || [];
      // Build date → daily avg signal map
      const byDay = {};
      for (const { ts, rate } of rates) {
        const date = new Date(ts).toISOString().slice(0, 10);
        if (!byDay[date]) byDay[date] = [];
        byDay[date].push(rate);
      }
      const days = Object.keys(byDay).sort();
      const dailyRates = days.map(d => byDay[d].reduce((s, r) => s + r, 0) / byDay[d].length);

      // Rolling 30d z-score → invert (negative funding = bullish = positive signal)
      const dateSignal = {};
      for (let i = 10; i < days.length; i++) {
        const window = dailyRates.slice(Math.max(0, i - 30), i + 1);
        const mean = window.reduce((s, r) => s + r, 0) / window.length;
        const std  = Math.sqrt(window.reduce((s, r) => s + (r - mean) ** 2, 0) / window.length);
        const z    = std > 0 ? (dailyRates[i] - mean) / std : 0;
        dateSignal[days[i]] = +Math.max(-1, Math.min(1, -z * 0.3)).toFixed(4);
      }
      result[sym] = dateSignal;
    } catch (e) { result[sym] = {}; }
  }
  return result;
}

// ── Simulate period ───────────────────────────────────────────
function simulatePeriod(history, scoreToken, startBar, endBar, fundingSignals = {}) {
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

      // Get funding signal for this day (0 if not available — backward compatible)
      const dayDate = new Date(bars[day]?.time || Date.now()).toISOString?.().slice(0, 10)
                   || new Date(bars[day]?.ts   || Date.now()).toISOString().slice(0, 10);
      const fundingSignal = (fundingSignals[sym] || {})[dayDate] || 0;

      try {
        scores[sym] = scoreToken({ prices, btcPrices, flowSignal: fundingSignal, attentionDelta: 0 });
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
  const history        = loadHistory();
  const fundingSignals = loadFundingSignals();
  const { scoreToken } = require('./candidate');

  // Separate histories for different token universes
  const majorHistory = Object.fromEntries(Object.entries(history).filter(([k]) => MAJOR_TOKENS.includes(k)));
  const baseHistory  = Object.fromEntries(Object.entries(history).filter(([k]) => BASE_TOKENS.includes(k)));

  // Majors: 730-bar split
  const isReturns  = simulatePeriod(majorHistory, scoreToken, 0,           IS_END,     fundingSignals);
  const valReturns = simulatePeriod(majorHistory, scoreToken, IS_END,      VAL_END,    fundingSignals);
  const audReturns = simulatePeriod(majorHistory, scoreToken, VAL_END,     TOTAL_BARS, fundingSignals);

  // Base tokens: 181-bar split (shorter history)
  const baseIsReturns  = Object.keys(baseHistory).length > 0 ? simulatePeriod(baseHistory, scoreToken, 0,            BASE_IS_END,  {}) : [];
  const baseValReturns = Object.keys(baseHistory).length > 0 ? simulatePeriod(baseHistory, scoreToken, BASE_IS_END,  BASE_VAL_END, {}) : [];
  const baseAudReturns = Object.keys(baseHistory).length > 0 ? simulatePeriod(baseHistory, scoreToken, BASE_VAL_END, BASE_TOTAL,   {}) : [];

  // Combined validation = majors + Base (equal weight)
  const combinedVal = [...valReturns, ...baseValReturns];
  const combinedAud = [...audReturns, ...baseAudReturns];

  const results = {
    inSample: {
      sharpe:      +sharpe(isReturns).toFixed(4),
      totalReturn: +totalReturn(isReturns).toFixed(4),
      maxDrawdown: +maxDrawdown(isReturns).toFixed(4),
      winRate:     +winRate(isReturns).toFixed(4),
      bars:        isReturns.length,
    },
    // Validation and audit use COMBINED majors + Base returns
    validation: {
      sharpe:      +sharpe(combinedVal).toFixed(4),
      totalReturn: +totalReturn(combinedVal).toFixed(4),
      maxDrawdown: +maxDrawdown(combinedVal).toFixed(4),
      winRate:     +winRate(combinedVal).toFixed(4),
      bars:        combinedVal.length,
    },
    audit: {
      sharpe:      +sharpe(combinedAud).toFixed(4),
      totalReturn: +totalReturn(combinedAud).toFixed(4),
      maxDrawdown: +maxDrawdown(combinedAud).toFixed(4),
      winRate:     +winRate(combinedAud).toFixed(4),
      bars:        combinedAud.length,
    },
    // Breakdown for visibility
    majorVal:  { sharpe: +sharpe(valReturns).toFixed(4),    bars: valReturns.length },
    baseVal:   { sharpe: +sharpe(baseValReturns).toFixed(4), bars: baseValReturns.length },
    majorAud:  { sharpe: +sharpe(audReturns).toFixed(4),    bars: audReturns.length },
    baseAud:   { sharpe: +sharpe(baseAudReturns).toFixed(4), bars: baseAudReturns.length },
  };

  if (!silent) {
    console.log('\n════════════════════════════════════════');
    console.log('  delu autoresearch — evaluator');
    console.log('  Tokens: 7 majors (Binance) + 5 Base (GeckoTerminal)');
    console.log('════════════════════════════════════════');
    console.log(`  In-Sample   (${results.inSample.bars}d):  Sharpe=${results.inSample.sharpe.toFixed(3).padStart(7)}  ret=${(results.inSample.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.inSample.maxDrawdown*100).toFixed(1)}%  WR=${(results.inSample.winRate*100).toFixed(0)}%`);
    console.log(`  Validation  (${results.validation.bars}d):  Sharpe=${results.validation.sharpe.toFixed(3).padStart(7)}  ret=${(results.validation.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.validation.maxDrawdown*100).toFixed(1)}%  WR=${(results.validation.winRate*100).toFixed(0)}%  [majors=${results.majorVal.sharpe.toFixed(2)} base=${results.baseVal.sharpe.toFixed(2)}]`);
    console.log(`  Audit       (${results.audit.bars}d):  Sharpe=${results.audit.sharpe.toFixed(3).padStart(7)}  ret=${(results.audit.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.audit.maxDrawdown*100).toFixed(1)}%  WR=${(results.audit.winRate*100).toFixed(0)}%  [majors=${results.majorAud.sharpe.toFixed(2)} base=${results.baseAud.sharpe.toFixed(2)}]`);
    console.log('════════════════════════════════════════\n');
  }

  return results;
}

// Run standalone
if (require.main === module) evaluate(false);
module.exports = { evaluate };
