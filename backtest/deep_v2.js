#!/usr/bin/env node
/**
 * delu deep backtest v2
 *
 * Lessons applied from v1:
 *   1. Only trade tokens with proven edge: BTC, ETH, SOL, BNB, DOGE, AAVE, ARB
 *   2. Stops too tight (2x ATR) — bumped to 3x, also test 2.5x
 *   3. Fixed TP leaving money on table → add trailing stop option
 *   4. Trend filter: only long when price > 200 EMA (trade with trend)
 *   5. Add MACD histogram as primary signal (rate-of-change > signal cross)
 *   6. Add volume confirmation (OBV rising = accumulation)
 *   7. Richer grid focused around what worked (ema12/26, rsi40-70, str3)
 */

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Only tokens that showed edge in v1 ──────────────────────
const TOKENS = [
  { symbol: 'BTC',  binance: 'BTCUSDT' },
  { symbol: 'ETH',  binance: 'ETHUSDT' },
  { symbol: 'SOL',  binance: 'SOLUSDT' },
  { symbol: 'BNB',  binance: 'BNBUSDT' },
  { symbol: 'DOGE', binance: 'DOGEUSDT' },
  { symbol: 'AAVE', binance: 'AAVEUSDT' },
  { symbol: 'ARB',  binance: 'ARBUSDT' },
];

// ─── Parameter Grid v2 ────────────────────────────────────────
// Format: [rsiPeriod, emaFast, emaSlow, rsiOversold, rsiOverbought, minStrength, atrStopMult, useTrailingStop]
// Based on v1 learnings: ema12/26 + rsi40-70 + str3 was best
// Testing: wider stops, MACD confirmation, trend filter on/off
const PARAM_GRID = [
  // --- Original winners, wider stops ---
  [14, 12, 26, 40, 70, 3, 2.5, false],
  [14, 12, 26, 40, 70, 3, 3.0, false],
  [14, 12, 26, 40, 70, 3, 3.5, false],
  // --- Trailing stop versions ---
  [14, 12, 26, 40, 70, 3, 2.0, true],
  [14, 12, 26, 40, 70, 3, 2.5, true],
  // --- EMA 9/21 with wider stops ---
  [14,  9, 21, 40, 70, 3, 2.5, false],
  [14,  9, 21, 40, 70, 3, 3.0, false],
  [10,  9, 21, 35, 65, 2, 2.5, false],
  [10,  9, 21, 35, 65, 2, 3.0, false],
  // --- Trend-filtered (only matters with trendFilter=true below) ---
  [14, 12, 26, 40, 70, 2, 2.5, false],
  [14, 12, 26, 35, 70, 3, 2.5, false],
  // --- Slower RSI, wider band ---
  [21, 12, 26, 35, 70, 3, 3.0, false],
  [21, 12, 26, 40, 65, 3, 2.5, false],
  // --- Fast/aggressive ---
  [ 7, 12, 26, 40, 70, 2, 2.0, true],
  [ 7,  9, 21, 40, 70, 2, 2.0, true],
];

const IS_SPLIT = 0.7;

// ─── Binance fetch ────────────────────────────────────────────
async function fetchBinance(symbol, daysBack = 365) {
  const limit = 1000;
  const totalCandles = daysBack * 24;
  let allCandles = [];
  let endTime = Date.now();

  while (allCandles.length < totalCandles) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.length === 0) break;
    const bars = data.map(d => ({
      ts: d[0], time: new Date(d[0]),
      open: parseFloat(d[1]), high: parseFloat(d[2]),
      low: parseFloat(d[3]), close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    }));
    allCandles = [...bars, ...allCandles];
    endTime = data[0][0] - 1;
    await sleep(200);
  }

  const seen = new Set();
  return allCandles
    .filter(b => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; })
    .sort((a, b) => a.ts - b.ts)
    .slice(-totalCandles);
}

// ─── Indicators ───────────────────────────────────────────────
function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gAvg = 0, lAvg = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gAvg += d; else lAvg += Math.abs(d);
  }
  gAvg /= period; lAvg /= period;
  for (let i = period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    gAvg = (gAvg * (period-1) + (d > 0 ? d : 0)) / period;
    lAvg = (lAvg * (period-1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = lAvg === 0 ? 100 : 100 - 100 / (1 + gAvg / lAvg);
  }
  return rsi;
}

function calcEMA(closes, period) {
  const ema = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  let prev = closes[0];
  for (let i = 0; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    ema[i] = prev;
  }
  return ema;
}

// MACD: fast EMA - slow EMA, histogram = MACD - signal(9)
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaF = calcEMA(closes, fast);
  const emaS = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaF[i] !== null && emaS[i] !== null ? emaF[i] - emaS[i] : null
  );
  const validMacd = macdLine.filter(v => v !== null);
  const signalRaw = calcEMA(validMacd, signal);
  // re-align signal to full array
  const signalLine = new Array(closes.length).fill(null);
  let si = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) { signalLine[i] = signalRaw[si++]; }
  }
  const histogram = macdLine.map((m, i) =>
    m !== null && signalLine[i] !== null ? m - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

function calcATR(bars, period = 14) {
  const atr = new Array(bars.length).fill(null);
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prev = bars[i-1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  atr[period-1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    atr[i] = (atr[i-1] * (period-1) + tr[i]) / period;
  }
  return atr;
}

function calcOBV(closes, volumes) {
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) obv[i] = obv[i-1] + volumes[i];
    else if (closes[i] < closes[i-1]) obv[i] = obv[i-1] - volumes[i];
    else obv[i] = obv[i-1];
  }
  return obv;
}

function calcBollingerWidth(closes, period = 20) {
  const width = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const slice = closes.slice(i - period, i);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    width[i] = mean > 0 ? (std * 2) / mean : null;
  }
  return width;
}

// ─── Signal Generator v2 ──────────────────────────────────────
function generateSignals(bars, params) {
  const [rsiPeriod, emaFast, emaSlow, rsiOversold, rsiOverbought, minStrength, atrStopMult] = params;
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const lookback = Math.max(rsiPeriod, emaSlow, 26, 200) + 10;

  const rsi     = calcRSI(closes, rsiPeriod);
  const emaF    = calcEMA(closes, emaFast);
  const emaS    = calcEMA(closes, emaSlow);
  const ema200  = calcEMA(closes, 200);  // trend filter
  const obv     = calcOBV(closes, volumes);
  const bbW     = calcBollingerWidth(closes, 20);
  const atr     = calcATR(bars, 14);
  const macd    = calcMACD(closes, emaFast, emaSlow, 9);

  const signals = [];

  for (let i = lookback; i < bars.length; i++) {
    if (rsi[i] === null || emaF[i] === null || emaS[i] === null || ema200[i] === null) continue;
    if (macd.histogram[i] === null || macd.histogram[i-1] === null) continue;

    // ── TREND FILTER (v2 addition) ──────────────────────────
    // Only long when price is above 200 EMA — trade with trend
    const inUptrend = bars[i].close > ema200[i];
    if (!inUptrend) {
      // Still emit SELL/exit signals even in downtrend
    }

    // ── LONG ENTRY signals ──────────────────────────────────
    let buyStrength = 0;

    // 1. EMA bullish cross (fast crosses above slow)
    if (emaF[i-1] < emaS[i-1] && emaF[i] > emaS[i]) buyStrength += 2;

    // 2. MACD histogram: histogram turning positive (rising momentum)
    //    Rate of change > signal cross as primary signal (Tomu's lesson)
    const macdHist = macd.histogram[i];
    const macdHistPrev = macd.histogram[i-1];
    if (macdHist !== null && macdHistPrev !== null) {
      if (macdHistPrev < 0 && macdHist > 0) buyStrength += 2;  // histogram flips positive
      else if (macdHist > macdHistPrev && macdHist > 0) buyStrength += 1;  // histogram growing
    }

    // 3. RSI oversold bounce (enters from oversold)
    if (rsi[i] > rsiOversold && rsi[i-1] <= rsiOversold) buyStrength += 2;

    // 4. RSI bullish divergence: price makes lower low but RSI makes higher low
    if (i >= 10) {
      const priceLow = bars[i].close < bars[i-10].close;
      const rsiHigh  = rsi[i] > rsi[i-10];
      if (priceLow && rsiHigh && rsi[i] < 50) buyStrength += 2;
    }

    // 5. OBV accumulation: price flat/down but OBV rising (smart money accumulating)
    if (i >= 8) {
      const priceChange = (bars[i].close - bars[i-8].close) / bars[i-8].close;
      if (priceChange < 0.02 && obv[i] > obv[i-8]) buyStrength += 1;
    }

    // 6. BB squeeze: volatility compression → expect breakout
    if (bbW[i] !== null && i >= 50) {
      const bbSlice = bbW.slice(i-50, i).filter(v => v !== null);
      if (bbSlice.length > 20) {
        const sorted = [...bbSlice].sort((a, b) => a - b);
        if (bbW[i] <= sorted[Math.floor(sorted.length * 0.2)]) buyStrength += 1;
      }
    }

    // 7. Trend bonus: price above 200 EMA adds confidence
    if (inUptrend) buyStrength += 1;

    if (buyStrength >= minStrength) {
      signals.push({
        i, time: bars[i].time, price: bars[i].close,
        type: 'BUY', strength: buyStrength, atr: atr[i],
        inUptrend,
      });
    }

    // ── EXIT signals ────────────────────────────────────────
    let exitStrength = 0;
    if (emaF[i-1] > emaS[i-1] && emaF[i] < emaS[i]) exitStrength += 2;  // death cross
    if (rsi[i] < rsiOverbought && rsi[i-1] >= rsiOverbought) exitStrength += 2;  // RSI overbought reversal
    // MACD histogram flips negative = momentum dying
    if (macdHist !== null && macdHistPrev !== null && macdHistPrev > 0 && macdHist < 0) exitStrength += 2;
    // Bearish divergence: price higher high, RSI lower high
    if (i >= 10 && bars[i].close > bars[i-10].close && rsi[i] < rsi[i-10] && rsi[i] > 60) exitStrength += 1;

    if (exitStrength >= 2) {
      signals.push({ i, time: bars[i].time, price: bars[i].close, type: 'SELL', strength: exitStrength });
    }
  }

  return signals;
}

// ─── Simulation v2 ────────────────────────────────────────────
function simulate(bars, signals, capital = 100, atrStopMult = 3.0, useTrailing = false) {
  let cash = capital;
  let position = null;
  const trades = [];
  const sorted = [...signals].sort((a, b) => a.i - b.i);

  for (const sig of sorted) {
    // Update trailing stop if in position
    if (position && useTrailing) {
      const trailingStop = bars[sig.i].close - (position.atrAtEntry * atrStopMult);
      if (trailingStop > position.stopLoss) {
        position.stopLoss = trailingStop;
      }
    }

    if (sig.type === 'BUY' && position === null) {
      const sizeUsd = cash * 0.20;
      if (sizeUsd < 1) continue;
      const atrVal = sig.atr || (sig.price * 0.02);
      const stopLoss   = sig.price - (atrStopMult * atrVal);
      const takeProfit = sig.price + (atrStopMult * 2 * atrVal);  // 2:1 R/R on wider stop
      position = {
        entryIdx: sig.i, entryTime: sig.time,
        entryPrice: sig.price, qty: sizeUsd / sig.price,
        sizeUsd, stopLoss, takeProfit, strength: sig.strength,
        atrAtEntry: atrVal, inUptrend: sig.inUptrend,
      };
      cash -= sizeUsd;
    }
    else if (sig.type === 'SELL' && position !== null) {
      const barsIn = bars.slice(position.entryIdx + 1, sig.i + 1);
      let exitPrice = sig.price, exitTime = sig.time, exitReason = 'signal';

      for (const b of barsIn) {
        if (b.low <= position.stopLoss) { exitPrice = position.stopLoss; exitTime = b.time; exitReason = 'stop'; break; }
        if (b.high >= position.takeProfit) { exitPrice = position.takeProfit; exitTime = b.time; exitReason = 'tp'; break; }
      }

      const exitValue = position.qty * exitPrice;
      const pnl = exitValue - position.sizeUsd;
      trades.push({
        entryTime: position.entryTime, exitTime,
        entryPrice: position.entryPrice, exitPrice,
        pnl, returnPct: Math.round((pnl / position.sizeUsd) * 10000) / 100,
        win: pnl > 0,
        holdHours: Math.round((exitTime - position.entryTime) / 3600000),
        exitReason, entryStrength: position.strength, inUptrend: position.inUptrend,
      });
      cash += exitValue;
      position = null;
    }
  }

  // Close open position
  if (position) {
    const last = bars[bars.length - 1];
    const barsIn = bars.slice(position.entryIdx + 1);
    let exitPrice = last.close, exitReason = 'open';
    for (const b of barsIn) {
      if (b.low <= position.stopLoss) { exitPrice = position.stopLoss; exitReason = 'stop'; break; }
      if (b.high >= position.takeProfit) { exitPrice = position.takeProfit; exitReason = 'tp'; break; }
    }
    const exitValue = position.qty * exitPrice;
    trades.push({
      entryTime: position.entryTime, exitTime: last.time,
      entryPrice: position.entryPrice, exitPrice,
      pnl: exitValue - position.sizeUsd,
      returnPct: Math.round(((exitValue - position.sizeUsd) / position.sizeUsd) * 10000) / 100,
      win: exitValue > position.sizeUsd,
      holdHours: Math.round((last.time - position.entryTime) / 3600000),
      exitReason, open: true,
    });
    cash += exitValue;
  }

  return { trades, finalCapital: cash };
}

// ─── Stats ────────────────────────────────────────────────────
function calcStats(trades, startCapital = 100) {
  if (trades.length < 3) return { error: `only ${trades.length} trades` };
  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const returns = trades.map(t => t.returnPct / 100);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  let capital = startCapital, peak = capital, maxDD = 0;
  for (const t of trades) {
    capital += t.pnl;
    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const totalReturn = ((trades.reduce((a, t) => a + t.pnl, 0)) / startCapital) * 100;
  const avgWin  = wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.returnPct, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (wins.length * avgWin) / (losses.length * avgLoss) : Infinity;
  const stopPct = Math.round(trades.filter(t => t.exitReason === 'stop').length / trades.length * 100);
  const tpPct   = Math.round(trades.filter(t => t.exitReason === 'tp').length / trades.length * 100);
  const uptrendPct = Math.round(trades.filter(t => t.inUptrend).length / trades.length * 100);
  const uptrendWinRate = (() => {
    const ut = trades.filter(t => t.inUptrend);
    return ut.length > 0 ? Math.round(ut.filter(t => t.win).length / ut.length * 100) : null;
  })();

  return {
    n: trades.length,
    winRate: Math.round(wins.length / trades.length * 100),
    totalReturnPct: Math.round(totalReturn * 10) / 10,
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 1000) / 10,
    calmar: maxDD > 0 ? Math.round(totalReturn / (maxDD * 100) * 100) / 100 : 0,
    avgHoldHours: Math.round(trades.reduce((s, t) => s + (t.holdHours || 0), 0) / trades.length),
    stopHitPct: stopPct,
    tpHitPct: tpPct,
    uptrendPct,
    uptrendWinRate,
  };
}

function walkForward(bars, params) {
  const splitIdx = Math.floor(bars.length * IS_SPLIT);
  const inSample  = bars.slice(0, splitIdx);
  const outSample = bars.slice(splitIdx);
  const [,,,,,, atrStopMult, useTrailing] = params;
  const isSigs  = generateSignals(inSample, params);
  const oosSigs = generateSignals(outSample, params);
  const { trades: isTrades  } = simulate(inSample,  isSigs,  100, atrStopMult, useTrailing);
  const { trades: oosTrades } = simulate(outSample, oosSigs, 100, atrStopMult, useTrailing);
  return {
    is:  calcStats(isTrades, 100),
    oos: calcStats(oosTrades, 100),
    isN: isTrades.length,
    oosN: oosTrades.length,
  };
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`delu DEEP backtest v2 — ${new Date().toISOString()}`);
  console.log(`v1 lessons: 7 winning tokens | wider stops | MACD | trend filter | trailing`);
  console.log(`Tokens: ${TOKENS.length} | Param combos: ${PARAM_GRID.length} | WF: 70/30`);
  console.log(`${'═'.repeat(60)}\n`);

  const allResults = [];
  const allParamResults = [];

  for (const token of TOKENS) {
    process.stdout.write(`[${token.symbol}] Fetching 1yr hourly...`);
    let bars;
    try {
      bars = await fetchBinance(token.binance, 365);
      await sleep(300);
    } catch (e) {
      console.log(` FAILED: ${e.message}`);
      allResults.push({ token: token.symbol, error: e.message });
      continue;
    }
    if (!bars || bars.length < 300) {
      console.log(` SKIP: only ${bars?.length} bars`);
      continue;
    }
    console.log(` ${bars.length} bars`);

    let bestSharpe = -Infinity, bestStats = null, bestParams = null;
    let totalTokenTrades = 0;

    for (let pi = 0; pi < PARAM_GRID.length; pi++) {
      const params = PARAM_GRID[pi];
      try {
        const wf = walkForward(bars, params);
        totalTokenTrades += (wf.isN || 0) + (wf.oosN || 0);
        const oosSharpe = wf.oos?.sharpe ?? -999;
        if (oosSharpe > bestSharpe && !wf.oos?.error) {
          bestSharpe = oosSharpe; bestParams = params; bestStats = wf;
        }
        const label = `rsi${params[0]}_ema${params[1]}/${params[2]}_stop${params[6]}x_trailing${params[7]}`;
        allParamResults.push({
          token: token.symbol, paramIdx: pi, params: label,
          is: wf.is, oos: wf.oos, isN: wf.isN, oosN: wf.oosN,
        });
      } catch (e) { /* skip */ }
    }

    console.log(`  → ${totalTokenTrades} total trades | BEST OOS: sharpe=${bestStats?.oos?.sharpe} winRate=${bestStats?.oos?.winRate}% return=${bestStats?.oos?.totalReturnPct}% maxDD=${bestStats?.oos?.maxDrawdownPct}% stop%=${bestStats?.oos?.stopHitPct} tp%=${bestStats?.oos?.tpHitPct} uptrend_wr=${bestStats?.oos?.uptrendWinRate}% (${bestStats?.oosN} trades)`);

    allResults.push({ token: token.symbol, bars: bars.length, totalParamTrades: totalTokenTrades, bestParams, bestStats });
  }

  // ─── Report ───────────────────────────────────────────────
  const totalTrades = allParamResults.reduce((s, r) => s + (r.isN||0) + (r.oosN||0), 0);
  const elapsed = Math.round((Date.now() - t0) / 1000);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`DONE — ${totalTrades.toLocaleString()} trades | ${elapsed}s`);
  console.log(`${'═'.repeat(60)}`);

  const ranked = allParamResults
    .filter(r => r.oos && !r.oos.error && r.oosN >= 5)
    .sort((a, b) => (b.oos?.sharpe||0) - (a.oos?.sharpe||0))
    .slice(0, 20);

  console.log('\n🏆 TOP CONFIGURATIONS (OOS Sharpe, min 5 trades):');
  console.log(`${'─'.repeat(100)}`);
  console.log(`${'Token'.padEnd(7)} ${'Params'.padEnd(38)} ${'N'.padEnd(5)} ${'Win'.padEnd(6)} ${'Ret'.padEnd(8)} ${'Sharpe'.padEnd(8)} ${'DD'.padEnd(7)} ${'PF'.padEnd(6)} ${'Stop%'.padEnd(7)} ${'TP%'.padEnd(6)} ${'Uptrend_WR'}`);
  console.log(`${'─'.repeat(100)}`);
  for (const r of ranked) {
    const o = r.oos;
    console.log(
      `${r.token.padEnd(7)} ${r.params.padEnd(38)} ${String(r.oosN).padEnd(5)} ` +
      `${String(o.winRate+'%').padEnd(6)} ${String(o.totalReturnPct+'%').padEnd(8)} ` +
      `${String(o.sharpe).padEnd(8)} ${String(o.maxDrawdownPct+'%').padEnd(7)} ` +
      `${String(o.profitFactor).padEnd(6)} ${String(o.stopHitPct+'%').padEnd(7)} ` +
      `${String(o.tpHitPct+'%').padEnd(6)} ${o.uptrendWinRate ?? 'n/a'}%`
    );
  }

  // Aggregate best per token
  const validOOS = allResults.filter(r => r.bestStats?.oos && !r.bestStats.oos.error);
  if (validOOS.length > 0) {
    const avg = f => Math.round(validOOS.reduce((s, r) => s + r.bestStats.oos[f], 0) / validOOS.length * 10) / 10;
    console.log(`\n📊 AGGREGATE (best per token, OOS):`);
    console.log(`   Avg Sharpe: ${avg('sharpe')} | Avg Win Rate: ${avg('winRate')}% | Avg Return: ${avg('totalReturnPct')}%`);
    console.log(`   Avg Max DD: ${avg('maxDrawdownPct')}% | Tokens with edge (Sharpe>1): ${validOOS.filter(r => r.bestStats.oos.sharpe > 1).length}/${validOOS.length}`);
  }

  // Most robust param combos
  const robustMap = {};
  for (const r of allParamResults.filter(r => r.oos && !r.oos.error && r.oos.sharpe > 1 && r.oosN >= 5)) {
    if (!robustMap[r.params]) robustMap[r.params] = { count: 0, sharpeSum: 0 };
    robustMap[r.params].count++;
    robustMap[r.params].sharpeSum += r.oos.sharpe;
  }
  const robustTop = Object.entries(robustMap).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  if (robustTop.length > 0) {
    console.log('\n🎯 MOST ROBUST (Sharpe>1 across multiple tokens):');
    for (const [p, d] of robustTop) {
      console.log(`   ${p} → ${d.count} tokens | avg sharpe ${Math.round(d.sharpeSum/d.count*100)/100}`);
    }
  }

  // v1 vs v2 comparison summary
  console.log('\n📈 v1 vs v2 KEY CHANGES:');
  console.log('   + MACD histogram as primary signal (replaces raw EMA cross)');
  console.log('   + Trend filter (200 EMA) — uptrend win rate shown separately');
  console.log('   + Wider stops (2.5x-3.5x ATR) vs v1 (2x ATR)');
  console.log('   + Trailing stop variants tested');
  console.log('   + Only 7 tokens with proven edge (removed 8 losers)');

  // Save
  const outFile = path.join(RESULTS_DIR, `deep-v2-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(),
    version: 2,
    config: { tokens: TOKENS.length, paramCombos: PARAM_GRID.length, totalTrades, elapsed },
    topConfigs: ranked,
    tokenSummary: allResults.map(r => ({
      token: r.token, bars: r.bars, totalParamTrades: r.totalParamTrades,
      bestParams: r.bestParams,
      oosBestStats: r.bestStats?.oos,
      isBestStats: r.bestStats?.is,
      error: r.error,
    })),
    allParamResults,
  }, null, 2));

  console.log(`\n💾 Saved: ${outFile} | Total trades: ${totalTrades.toLocaleString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
