/**
 * evaluate_onchain.js — Onchain signal evaluator (Alchemy Base data)
 *
 * Uses real Base token price history from Alchemy (30d × 1h = 721 bars).
 * No Binance. No synthetic data. Real onchain prices only.
 *
 * Data splits (721 bars = 30 days):
 *   IS:  bars 0–432   (60%) — first 18 days
 *   VAL: bars 433–576 (20%) — next  6 days
 *   AUD: bars 577–720 (20%) — last  6 days
 *
 * Strategy: long/short, rebalance every 4h (4 bars)
 * Top 3 long + bottom 2 short each cycle
 * Metric: 0.5 × val_sharpe + 0.5 × aud_sharpe
 *
 * Volume proxy: Alchemy gives price-only → relative price change used as activity proxy
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '../data/history_onchain');
const CANDIDATE   = path.join(__dirname, 'candidate_onchain.js');

const IS_END  = 432;
const VAL_END = 576;
const TOTAL   = 720;
const REBAL   = 4;   // rebalance every 4 bars (4h)
const ANNUAL  = Math.sqrt(365 * 6); // hourly annualisation (sqrt(2190))
const MIN_BARS_WARMUP = 48; // need at least 48 bars of history before scoring

function loadData() {
  const tokens = [];
  if (!fs.existsSync(HISTORY_DIR)) return tokens;
  for (const file of fs.readdirSync(HISTORY_DIR)) {
    if (!file.endsWith('_alchemy_1h.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
      if (d.bars?.length >= 100 && !['USDC','USDT','DAI'].includes(d.sym)) {
        tokens.push({
          sym:           d.sym,
          addr:          d.addr,
          bars:          d.bars,
          transferStats: d.transferStats || null, // smart wallet signals
        });
      }
    } catch { /* skip */ }
  }
  return tokens;
}

function evalPeriod(allData, start, end) {
  if (!allData.length) return { sharpe: -999 };

  // Get WETH as "BTC proxy" for relative strength signals
  const wethData = allData.find(d => d.sym === 'WETH');

  // Load scoreToken once per period (not inside inner loop)
  delete require.cache[require.resolve(CANDIDATE)];
  const { scoreToken } = require(CANDIDATE);

  const rets = [];
  for (let bar = start + MIN_BARS_WARMUP; bar < end - REBAL; bar += REBAL) {
    const scores = allData.map(({ sym, bars, transferStats }) => {
      const slice = bars.slice(0, bar);
      if (slice.length < MIN_BARS_WARMUP) return { sym, score: 0 };
      try {
        const score = scoreToken({
          prices:    slice.map(b => b.close),
          volumes:   slice.map(b => b.volume),
          highs:     slice.map(b => b.high),
          lows:      slice.map(b => b.low),
          // Use WETH as the "btcPrices" reference for relative strength
          btcPrices: (wethData?.bars?.slice(0, bar) || slice).map(b => b.close),
          // Smart wallet signals: static per token (latest snapshot from Alchemy transfers)
          transferStats: transferStats || null,
        });
        return { sym, score: Math.max(-1, Math.min(1, score || 0)) };
      } catch { return { sym, score: 0 }; }
    });

    const sorted = [...scores].sort((a, b) => b.score - a.score);
    const longs  = sorted.slice(0, 3).filter(s => s.score >  0.05);
    const shorts = sorted.slice(-2).filter(s => s.score < -0.05);
    if (!longs.length && !shorts.length) continue;

    const n = longs.length + shorts.length;
    let cycleRet = 0;

    for (const pos of longs) {
      const d = allData.find(d => d.sym === pos.sym);
      if (!d?.bars[bar + REBAL]) continue;
      const ret = (d.bars[bar + REBAL].close - d.bars[bar].close) / d.bars[bar].close;
      cycleRet += ret / n;
    }
    for (const pos of shorts) {
      const d = allData.find(d => d.sym === pos.sym);
      if (!d?.bars[bar + REBAL]) continue;
      const ret = (d.bars[bar + REBAL].close - d.bars[bar].close) / d.bars[bar].close;
      cycleRet -= ret / n;
    }
    rets.push(cycleRet);
  }

  if (rets.length < 5) return { sharpe: -999 };
  const mean  = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std   = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const sharpe = std === 0 ? 0 : (mean / std) * ANNUAL;
  const totalRet = rets.reduce((s, r) => s + r, 0);
  return {
    sharpe: parseFloat(sharpe.toFixed(4)),
    ret:    parseFloat((totalRet * 100).toFixed(2)),
    trades: rets.length,
  };
}

function evaluate(verbose = false) {
  const allData = loadData();
  if (allData.length < 3) {
    if (verbose) console.error('[eval_onchain] Not enough tokens loaded:', allData.length);
    return null;
  }

  try {
    // Validate candidate loads
    delete require.cache[require.resolve(CANDIDATE)];
    const mod = require(CANDIDATE);
    if (typeof mod.scoreToken !== 'function') throw new Error('scoreToken not a function');
  } catch (e) {
    if (verbose) console.error('[eval_onchain] Candidate error:', e.message);
    return null;
  }

  const is  = evalPeriod(allData, 0,       IS_END);
  const val = evalPeriod(allData, IS_END,  VAL_END);
  const aud = evalPeriod(allData, VAL_END, TOTAL);

  if (verbose) {
    console.log(`[eval_onchain] ${allData.length} tokens | IS=${is.sharpe.toFixed(3)} VAL=${val.sharpe.toFixed(3)} AUD=${aud.sharpe.toFixed(3)}`);
  }

  return { inSample: is, validation: val, audit: aud };
}

module.exports = { evaluate, loadData, IS_END, VAL_END, TOTAL };
