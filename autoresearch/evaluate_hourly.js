/**
 * evaluate_hourly.js — Hourly evaluator for intraday signal research
 *
 * Same structure as evaluate.js but:
 *   - 1h bars (4320 = 180 days)
 *   - Rebalances every 4h (not daily)
 *   - Signals can use intraday patterns: volume spikes, momentum bursts, OBV divergence
 *   - Sharpe annualised from 4h returns (× sqrt(2190) = sqrt(365×6))
 *
 * Data splits (4320 bars = 180 days):
 *   IS:  bars 0–2591    (60%) — first 108 days
 *   VAL: bars 2592–3455 (20%) — next  36 days
 *   AUD: bars 3456–4319 (20%) — last  36 days
 *
 * Rebalance: every 4 bars (4h cadence)
 * Execution: at open of bar+1 after signal (no lookahead)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '../data/history');

const TOTAL_BARS  = 4320;  // 180 days × 24h
const IS_END      = 2592;  // 60% — Sep 2025 → Jan 2026 (bear)
const VAL_END     = 3456;  // 80% — Jan → Feb 2026 (crash)
const REBAL_BARS  = 4;     // rebalance every 4h
const LONG_COUNT  = 3;     // top 3 longs
const SHORT_COUNT = 2;     // bottom 2 shorts (where score < -MIN_SCORE)
const MIN_SCORE   = 0.05;  // minimum absolute score to trade

const TOKENS = [
  'BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOGE','TRX','HBAR',
  'LINK','AAVE','UNI','MKR','CRV','COMP','SNX','BAL','YFI','SUSHI',
  'ARB','OP','MATIC','STX','IMX',
  'FET','AGIX','OCEAN','RNDR',
  'PEPE','SHIB','BONK','WIF','FLOKI',
  'NEAR','APT','SUI','INJ','ATOM','DOT','ALGO',
  'LTC','BCH','FIL','ETC','XLM',
  'SAND','MANA','AXS','1INCH',
];

function loadHistory() {
  const data = {};
  for (const sym of TOKENS) {
    const file = path.join(HISTORY_DIR, `${sym}_binance_hourly.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bars = raw.bars || raw;
      if (Array.isArray(bars) && bars.length >= 200) {
        // Normalise to last TOTAL_BARS
        const slice = bars.slice(-TOTAL_BARS);
        data[sym] = slice.map(b => ({
          close:  b.close,
          open:   b.open   || b.close,
          high:   b.high   || b.close,
          low:    b.low    || b.close,
          volume: b.volume || 0,
          time:   b.time   || b.ts,
        }));
      }
    } catch(e) { /* skip */ }
  }
  return data;
}

function simulatePeriod(history, scoreToken, startBar, endBar) {
  const symbols  = Object.keys(history);
  const returns  = [];
  const btcBars  = history['BTC'] || [];

  // Only score every REBAL_BARS — simulate 4h rebalance
  for (let bar = startBar; bar < endBar - 1; bar += REBAL_BARS) {
    const btcPrices = btcBars.slice(0, bar + 1).map(b => b.close);

    const scores = {};
    for (const sym of symbols) {
      const bars = history[sym];
      if (!bars || bars.length <= bar + 1) continue;

      const slice   = bars.slice(0, bar + 1);
      const prices  = slice.map(b => b.close);
      const volumes = slice.map(b => b.volume);
      const highs   = slice.map(b => b.high);
      const lows    = slice.map(b => b.low);
      const opens   = slice.map(b => b.open);

      try {
        scores[sym] = scoreToken({ prices, volumes, highs, lows, opens, btcPrices, flowSignal: 0, attentionDelta: 0 });
      } catch(e) { scores[sym] = 0; }
    }

    // Long: top LONG_COUNT where score > MIN_SCORE
    const longs = Object.entries(scores)
      .filter(([, s]) => typeof s === 'number' && s > MIN_SCORE && isFinite(s))
      .sort(([, a], [, b]) => b - a)
      .slice(0, LONG_COUNT);

    // Short: bottom SHORT_COUNT where score < -MIN_SCORE
    const shorts = Object.entries(scores)
      .filter(([, s]) => typeof s === 'number' && s < -MIN_SCORE && isFinite(s))
      .sort(([, a], [, b]) => a - b)
      .slice(0, SHORT_COUNT);

    if (longs.length === 0 && shorts.length === 0) {
      for (let i = 0; i < Math.min(REBAL_BARS, endBar - bar - 1); i++) returns.push(0);
      continue;
    }

    let ret = 0, count = 0;
    for (const [sym] of longs) {
      const bars  = history[sym];
      const entry = bars[bar + 1]?.open;
      const exitBar = Math.min(bar + REBAL_BARS, endBar - 1);
      const exit  = bars[exitBar]?.close;
      if (entry && exit && entry > 0) {
        ret += (exit - entry) / entry;
        count++;
      }
    }
    for (const [sym] of shorts) {
      const bars  = history[sym];
      const entry = bars[bar + 1]?.open;
      const exitBar = Math.min(bar + REBAL_BARS, endBar - 1);
      const exit  = bars[exitBar]?.close;
      if (entry && exit && entry > 0) {
        ret += -(exit - entry) / entry; // inverted for short
        count++;
      }
    }
    const periodRet = count > 0 ? ret / count : 0;
    // Spread over REBAL_BARS for correct Sharpe calculation
    for (let i = 0; i < Math.min(REBAL_BARS, endBar - bar - 1); i++) {
      returns.push(periodRet / Math.min(REBAL_BARS, endBar - bar - 1));
    }
  }

  return returns;
}

function sharpe(returns) {
  if (returns.length < 10) return -999;
  const n    = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const std  = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n);
  // Annualise: hourly returns × sqrt(8760 hours/year)
  return std === 0 ? 0 : (mean / std) * Math.sqrt(8760);
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

function totalReturn(returns) {
  return returns.reduce((eq, r) => eq * (1 + r), 1) - 1;
}

function winRate(returns) {
  const wins = returns.filter(r => r > 0).length;
  return returns.length > 0 ? wins / returns.length : 0;
}

function evaluate(silent = false) {
  const history = loadHistory();
  const tokenCount = Object.keys(history).length;

  if (tokenCount < 5) {
    if (!silent) console.log(`[eval_hourly] Only ${tokenCount} tokens loaded — run fetch_hourly.js first`);
    return null;
  }

  // Load candidate_hourly if exists, else fall back to candidate
  let scoreToken;
  try {
    scoreToken = require('./candidate_hourly').scoreToken;
  } catch(e) {
    scoreToken = require('./candidate').scoreToken;
  }

  const isRet  = simulatePeriod(history, scoreToken, 0,       IS_END);
  const valRet = simulatePeriod(history, scoreToken, IS_END,  VAL_END);
  const audRet = simulatePeriod(history, scoreToken, VAL_END, TOTAL_BARS);

  const results = {
    inSample:   { sharpe: +sharpe(isRet).toFixed(4),  totalReturn: +totalReturn(isRet).toFixed(4),  maxDrawdown: +maxDrawdown(isRet).toFixed(4),  winRate: +winRate(isRet).toFixed(4),  bars: isRet.length  },
    validation: { sharpe: +sharpe(valRet).toFixed(4), totalReturn: +totalReturn(valRet).toFixed(4), maxDrawdown: +maxDrawdown(valRet).toFixed(4), winRate: +winRate(valRet).toFixed(4), bars: valRet.length },
    audit:      { sharpe: +sharpe(audRet).toFixed(4), totalReturn: +totalReturn(audRet).toFixed(4), maxDrawdown: +maxDrawdown(audRet).toFixed(4), winRate: +winRate(audRet).toFixed(4), bars: audRet.length },
  };

  if (!silent) {
    console.log('\n════════════════════════════════════════');
    console.log('  delu autoresearch — HOURLY evaluator');
    console.log(`  ${tokenCount} tokens | 1h bars | 4h rebalance`);
    console.log('════════════════════════════════════════');
    console.log(`  In-Sample   (${results.inSample.bars}h):   Sharpe=${results.inSample.sharpe.toFixed(3).padStart(7)}  ret=${(results.inSample.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.inSample.maxDrawdown*100).toFixed(1)}%`);
    console.log(`  Validation  (${results.validation.bars}h):   Sharpe=${results.validation.sharpe.toFixed(3).padStart(7)}  ret=${(results.validation.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.validation.maxDrawdown*100).toFixed(1)}%`);
    console.log(`  Audit       (${results.audit.bars}h):   Sharpe=${results.audit.sharpe.toFixed(3).padStart(7)}  ret=${(results.audit.totalReturn*100).toFixed(1).padStart(7)}%  DD=${(results.audit.maxDrawdown*100).toFixed(1)}%`);
    console.log('════════════════════════════════════════\n');
  }

  return results;
}

if (require.main === module) evaluate(false);
module.exports = { evaluate };
