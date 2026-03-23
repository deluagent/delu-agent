/**
 * multi_tf_score.js — Multi-timeframe signal layer for live agent
 *
 * Blends three evolved scoring functions:
 *   - Hourly (quant_score.js)   — already live, uses Alchemy 1h bars
 *   - 5-minute (candidate_5m)  — 1h/4h momentum at 5m resolution via GeckoTerminal
 *   - Onchain (candidate_onchain) — RSI + relative strength + smart wallet via Alchemy
 *
 * For each candidate token:
 *   1. Run hourly score (always — Alchemy data already fetched)
 *   2. Fetch 5m bars from GeckoTerminal (only for top candidates)
 *   3. Run 5m score on 1h/4h signals
 *   4. Blend: 40% hourly + 35% 5m + 25% onchain
 *
 * Returns enriched score with per-timeframe breakdown for Venice context.
 */

'use strict';

const https = require('https');
const path  = require('path');

// Load evolved candidates
const { scoreToken: scoreHourly  } = require('./quant_score');
const { scoreToken: scoreOnchain } = require('../autoresearch/candidate_onchain');
const { scoreToken: score5m      } = require('../autoresearch/candidate_5m');

const GT_BASE = 'https://api.geckoterminal.com/api/v2';

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Accept: 'application/json;version=20230302' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('GT timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch 5m OHLCV bars from GeckoTerminal for a pool
 * Returns { prices, volumes, highs, lows, opens } arrays
 */
async function fetch5mBars(poolAddress, network = 'base', limit = 576) { // 576 = 2 days of 5m bars
  try {
    const r = await get(
      `${GT_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/minute?aggregate=5&limit=${limit}`
    );
    const list = r.data?.attributes?.ohlcv_list || [];
    if (list.length < 100) return null;

    const sorted = list.sort((a, b) => a[0] - b[0]);
    return {
      prices:  sorted.map(b => b[4]), // close
      volumes: sorted.map(b => b[5]),
      highs:   sorted.map(b => b[2]),
      lows:    sorted.map(b => b[3]),
      opens:   sorted.map(b => b[1]),
    };
  } catch { return null; }
}

/**
 * Fetch 4h OHLCV bars from GeckoTerminal
 */
async function fetch4hBars(poolAddress, network = 'base', limit = 90) { // 90 × 4h = 15 days
  try {
    const r = await get(
      `${GT_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/hour?aggregate=4&limit=${limit}`
    );
    const list = r.data?.attributes?.ohlcv_list || [];
    if (list.length < 10) return null;

    const sorted = list.sort((a, b) => a[0] - b[0]);
    return {
      prices:  sorted.map(b => b[4]),
      volumes: sorted.map(b => b[5]),
      highs:   sorted.map(b => b[2]),
      lows:    sorted.map(b => b[3]),
      opens:   sorted.map(b => b[1]),
    };
  } catch { return null; }
}

/**
 * Get pool address for a token from GeckoTerminal
 */
async function getPoolAddress(symbol, contractAddress, network = 'base') {
  try {
    let poolData;
    if (contractAddress) {
      const r = await get(`${GT_BASE}/networks/${network}/tokens/${contractAddress}/pools?page=1`);
      poolData = r.data?.[0];
    }
    if (!poolData) {
      const r = await get(`${GT_BASE}/search/pools?query=${symbol}&network=${network}&page=1`);
      poolData = r.data?.[0];
    }
    return poolData?.attributes?.address || null;
  } catch { return null; }
}

/**
 * Score a token across all timeframes
 *
 * @param {string} symbol
 * @param {string|null} contractAddress
 * @param {object} alchemySignal - from getTokenSignal() — has bars, transferStats
 * @param {Array} btcBars - BTC hourly prices (for relative strength)
 * @returns {object} { score, breakdown, bars5m, bars4h }
 */
async function scoreMultiTF(symbol, contractAddress, alchemySignal, btcBars = []) {
  const result = {
    symbol,
    score:     null,
    scoreH:    null, // hourly
    score5m:   null, // 5-minute
    scoreOC:   null, // onchain
    score4h:   null, // 4h momentum
    breakdown: '',
    poolAddress: null,
  };

  // ── 1. Hourly score (Alchemy data — always available) ────────
  if (alchemySignal?.bars?.length >= 20) {
    const hBars = alchemySignal.bars;
    const data = {
      prices:   hBars.map(b => b.close || b.price || b.c),
      volumes:  hBars.map(b => b.volume || b.v || 0),
      highs:    hBars.map(b => b.high || b.h || b.close || b.c),
      lows:     hBars.map(b => b.low || b.l || b.close || b.c),
      opens:    hBars.map(b => b.open || b.o || b.close || b.c),
      btcPrices: btcBars,
      transferStats: alchemySignal.transferStats,
    };
    try { result.scoreH = scoreHourly(data); } catch {}
    try { result.scoreOC = scoreOnchain(data); } catch {}
  }

  // ── 2. GeckoTerminal pool lookup ──────────────────────────────
  const poolAddr = await getPoolAddress(symbol, contractAddress);
  result.poolAddress = poolAddr;

  if (poolAddr) {
    await sleep(400); // GT rate limit

    // ── 3. 5m bars → 5m score ────────────────────────────────
    const bars5m = await fetch5mBars(poolAddr);
    if (bars5m && bars5m.prices.length >= 288) {
      // For BTC 5m we'd need separate fetch — use hourly BTC as proxy scaled
      const btc5mProxy = btcBars.flatMap(p => Array(12).fill(p)); // stretch hourly to 5m
      try {
        result.score5m = score5m({
          ...bars5m,
          btcPrices: btc5mProxy.slice(-bars5m.prices.length),
        });
      } catch {}
    }

    await sleep(400);

    // ── 4. 4h bars → 4h momentum context ─────────────────────
    const bars4h = await fetch4hBars(poolAddr);
    if (bars4h && bars4h.prices.length >= 10) {
      const p4 = bars4h.prices;
      const n4 = p4.length;
      const ret4h  = (p4[n4-1] - p4[n4-2]) / p4[n4-2];
      const ret12h = n4 >= 4 ? (p4[n4-1] - p4[n4-4]) / p4[n4-4] : 0;
      const ret24h = n4 >= 7 ? (p4[n4-1] - p4[n4-7]) / p4[n4-7] : 0;
      // Simple 4h momentum score: are all timeframes aligned upward?
      const aligned = ret4h > 0 && ret12h > 0;
      result.score4h = aligned
        ? Math.min(1, Math.tanh(ret4h * 20) * 0.5 + Math.tanh(ret12h * 10) * 0.5)
        : Math.max(-1, Math.tanh(ret4h * 20) * 0.5 + Math.tanh(ret12h * 10) * 0.5);
    }
  }

  // ── 5. Blend scores ──────────────────────────────────────────
  // Load evolved fusion weights (from loop_fusion.js auto-research)
  // Falls back to hardcoded defaults if no state file yet
  let fusionWeights = { w1h: 0.35, w5m: 0.30, wOC: 0.25, w4h: 0.10 };
  try {
    const stateFile = path.join(__dirname, '../autoresearch/state_fusion.json');
    const fusionState = JSON.parse(require('fs').readFileSync(stateFile, 'utf8'));
    const p = fusionState.bestParams || {};
    // Detect regime from BTC prices (simple: use btcBars slope)
    const bN = btcBars.length;
    const btcRet7d = bN >= 169 ? (btcBars[bN-1] - btcBars[bN-169]) / btcBars[bN-169] : 0;
    const regime = btcRet7d > 0.05 ? 'bull' : btcRet7d < -0.03 ? 'bear' : 'range';
    const w1h = p[`${regime}_w1h`] || 0.35;
    const w5m = p[`${regime}_w5m`] || 0.30;
    const wOC = p[`${regime}_wOC`] || 0.25;
    const w4h = p[`${regime}_w4h`] || 0.10;
    const total = w1h + w5m + wOC + w4h;
    fusionWeights = { w1h: w1h/total, w5m: w5m/total, wOC: wOC/total, w4h: w4h/total };
  } catch {}

  // Weights: hourly ${(fusionWeights.w1h*100).toFixed(0)}%, 5m ${(fusionWeights.w5m*100).toFixed(0)}%, onchain ${(fusionWeights.w5m*100).toFixed(0)}%, 4h ${(fusionWeights.w4h*100).toFixed(0)}% [auto-evolved]
  const available = [
    { score: result.scoreH,   w: fusionWeights.w1h, name: '1h'      },
    { score: result.score5m,  w: fusionWeights.w5m, name: '5m'      },
    { score: result.scoreOC,  w: fusionWeights.wOC, name: 'onchain' },
    { score: result.score4h,  w: fusionWeights.w4h, name: '4h'      },
  ].filter(s => s.score != null && !isNaN(s.score));

  if (available.length === 0) {
    result.score = null;
  } else {
    const totalW = available.reduce((s, a) => s + a.w, 0);
    result.score = available.reduce((s, a) => s + (a.score * a.w / totalW), 0);
    result.score = parseFloat(result.score.toFixed(4));
  }

  // ── 6. Breakdown string for Venice ───────────────────────────
  const parts = [];
  if (result.scoreH   != null) parts.push(`1h=${result.scoreH.toFixed(3)}`);
  if (result.score5m  != null) parts.push(`5m=${result.score5m.toFixed(3)}`);
  if (result.scoreOC  != null) parts.push(`onchain=${result.scoreOC.toFixed(3)}`);
  if (result.score4h  != null) parts.push(`4h=${result.score4h.toFixed(3)}`);
  result.breakdown = parts.join(' | ');

  return result;
}

module.exports = { scoreMultiTF, fetch5mBars, fetch4hBars };
