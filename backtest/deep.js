#!/usr/bin/env node
/**
 * delu deep backtest
 * 
 * Design goals:
 *   - 1000s of trades for statistical confidence
 *   - 1 year of hourly data per token
 *   - 15+ tokens (Binance for majors, CoinGecko for Base tokens)
 *   - Parameter grid sweep (find what actually works, not lucky 3 trades)
 *   - Walk-forward validation (in-sample vs out-of-sample)
 *   - Proper metrics: Sharpe, Calmar, profit factor, max drawdown
 *
 * Data sources:
 *   - Binance public API (no key needed, 1yr hourly, paginated)
 *   - CoinGecko (Base tokens: BRETT, DEGEN, AERO)
 */

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Token List ───────────────────────────────────────────────
// Binance symbols (free, paginated, 1yr+) + CoinGecko fallback for Base tokens
const TOKENS = [
  { symbol: 'ETH',     binance: 'ETHUSDT' },
  { symbol: 'BTC',     binance: 'BTCUSDT' },
  { symbol: 'SOL',     binance: 'SOLUSDT' },
  { symbol: 'BNB',     binance: 'BNBUSDT' },
  { symbol: 'LINK',    binance: 'LINKUSDT' },
  { symbol: 'AAVE',    binance: 'AAVEUSDT' },
  { symbol: 'AVAX',    binance: 'AVAXUSDT' },
  { symbol: 'ARB',     binance: 'ARBUSDT' },
  { symbol: 'OP',      binance: 'OPUSDT' },
  { symbol: 'MATIC',   binance: 'MATICUSDT' },
  { symbol: 'DOGE',    binance: 'DOGEUSDT' },
  { symbol: 'ADA',     binance: 'ADAUSDT' },
  { symbol: 'DOT',     binance: 'DOTUSDT' },
  { symbol: 'UNI',     binance: 'UNIUSDT' },
  { symbol: 'LTC',     binance: 'LTCUSDT' },
  // Base-native (CoinGecko fallback, max 365d)
  { symbol: 'BRETT',   coingecko: 'based-brett' },
  { symbol: 'DEGEN',   coingecko: 'degen-base' },
  { symbol: 'AERO',    coingecko: 'aerodrome-finance' },
];

// ─── Parameter Grid ───────────────────────────────────────────
// Grid sweep: find the best combination, not just one lucky set
const PARAM_GRID = [
  // [rsiPeriod, emaFast, emaSlow, rsiOversold, rsiOverbought, minStrength]
  [14, 9,  21,  35, 65, 3],
  [14, 9,  21,  40, 70, 3],
  [14, 12, 26,  35, 65, 3],
  [14, 12, 26,  40, 70, 3],
  [10, 9,  21,  35, 65, 2],  // looser — more signals
  [10, 9,  21,  40, 70, 2],
  [21, 9,  21,  30, 70, 3],  // slower RSI
  [14, 9,  21,  40, 65, 2],  // asymmetric
  [14, 5,  15,  35, 65, 2],  // faster EMAs
  [14, 9,  21,  45, 55, 3],  // tight RSI band
];

// Walk-forward split: 70% in-sample, 30% out-of-sample
const IS_SPLIT = 0.7;

// ─── Binance Data Fetch ───────────────────────────────────────
// Paginate backwards to get ~1 year of hourly candles
async function fetchBinance(symbol, daysBack = 365) {
  const interval = '1h';
  const limit = 1000;  // Binance max per request
  const totalCandles = daysBack * 24;
  let allCandles = [];
  let endTime = Date.now();

  while (allCandles.length < totalCandles) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance HTTP ${res.status}: ${text.slice(0, 100)}`);
    }
    const data = await res.json();
    if (!data || data.length === 0) break;

    // Binance format: [openTime, open, high, low, close, volume, closeTime, ...]
    const bars = data.map(d => ({
      ts: d[0],
      time: new Date(d[0]),
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    }));

    allCandles = [...bars, ...allCandles];
    endTime = data[0][0] - 1;  // go further back
    await sleep(200);  // gentle rate limit
  }

  // Sort ascending, deduplicate
  const seen = new Set();
  return allCandles
    .filter(b => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; })
    .sort((a, b) => a.ts - b.ts)
    .slice(-totalCandles);  // cap at requested amount
}

// ─── CoinGecko Fallback ───────────────────────────────────────
async function fetchCoinGecko(coinId, days = 365) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status} for ${coinId}`);
  const data = await res.json();
  const prices = data.prices || [];
  const volumes = data.total_volumes || [];
  
  return prices.map(([ts, price], i) => ({
    ts,
    time: new Date(ts),
    open: i > 0 ? prices[i-1][1] : price,
    high: price,
    low: price,
    close: price,
    volume: volumes[i]?.[1] || 0,
  }));
}

// ─── Indicators ───────────────────────────────────────────────
function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period-1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
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

function calcOBV(closes, volumes) {
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) obv[i] = obv[i-1] + volumes[i];
    else if (closes[i] < closes[i-1]) obv[i] = obv[i-1] - volumes[i];
    else obv[i] = obv[i-1];
  }
  return obv;
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

// ─── Signal Generator ─────────────────────────────────────────
function generateSignals(bars, params) {
  const [rsiPeriod, emaFast, emaSlow, rsiOversold, rsiOverbought, minStrength] = params;
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const lookback = Math.max(rsiPeriod, emaSlow, 20) + 5;

  const rsi    = calcRSI(closes, rsiPeriod);
  const emaF   = calcEMA(closes, emaFast);
  const emaS   = calcEMA(closes, emaSlow);
  const obv    = calcOBV(closes, volumes);
  const bbW    = calcBollingerWidth(closes, 20);
  const atr    = calcATR(bars, 14);

  const signals = [];

  for (let i = lookback; i < bars.length; i++) {
    if (rsi[i] === null || emaF[i] === null || emaS[i] === null) continue;

    let strength = 0;
    let type = null;

    // --- LONG signals ---
    // 1. EMA bullish cross
    if (emaF[i-1] < emaS[i-1] && emaF[i] > emaS[i]) strength += 2;
    // 2. RSI oversold bounce
    if (rsi[i] > rsiOversold && rsi[i-1] <= rsiOversold) strength += 2;
    // 3. RSI bullish divergence: price lower, RSI higher
    if (i >= 10 && bars[i].close < bars[i-10].close && rsi[i] > rsi[i-10]) strength += 1;
    // 4. OBV rising while price flat/down (accumulation)
    if (i >= 5) {
      const priceDelta = (bars[i].close - bars[i-5].close) / bars[i-5].close;
      if (priceDelta < 0.02 && obv[i] > obv[i-5]) strength += 1;
    }
    // 5. BB squeeze
    if (bbW[i] !== null && i >= 50) {
      const bbSlice = bbW.slice(i-50, i).filter(v => v !== null);
      if (bbSlice.length > 20) {
        const sorted = [...bbSlice].sort((a, b) => a - b);
        if (bbW[i] <= sorted[Math.floor(sorted.length * 0.25)]) strength += 1;
      }
    }

    if (strength >= minStrength) {
      signals.push({ i, time: bars[i].time, price: bars[i].close, type: 'BUY', strength, atr: atr[i] });
    }

    // --- SHORT/EXIT signals ---
    let exitStrength = 0;
    if (emaF[i-1] > emaS[i-1] && emaF[i] < emaS[i]) exitStrength += 2;  // death cross
    if (rsi[i] < rsiOverbought && rsi[i-1] >= rsiOverbought) exitStrength += 2;  // RSI overbought reversal
    if (i >= 10 && bars[i].close > bars[i-10].close && rsi[i] < rsi[i-10]) exitStrength += 1;  // bearish div

    if (exitStrength >= 2) {
      signals.push({ i, time: bars[i].time, price: bars[i].close, type: 'SELL', strength: exitStrength, atr: atr[i] });
    }
  }

  return signals;
}

// ─── Simulation ───────────────────────────────────────────────
function simulate(bars, signals, capital = 100, kellyFrac = 0.20) {
  let cash = capital;
  let position = null;
  const trades = [];

  // Sort signals by bar index to process in order
  const sorted = [...signals].sort((a, b) => a.i - b.i);

  for (const sig of sorted) {
    if (sig.type === 'BUY' && position === null) {
      const sizeUsd = cash * kellyFrac;
      if (sizeUsd < 1) continue;  // skip dust
      const qty = sizeUsd / sig.price;
      // ATR-based stop loss: 2x ATR below entry
      const stopLoss = sig.atr ? sig.price - (2 * sig.atr) : sig.price * 0.95;
      const takeProfit = sig.atr ? sig.price + (4 * sig.atr) : sig.price * 1.10;  // 2:1 R/R
      position = {
        entryIdx: sig.i,
        entryTime: sig.time,
        entryPrice: sig.price,
        qty,
        sizeUsd,
        stopLoss,
        takeProfit,
        strength: sig.strength,
      };
      cash -= sizeUsd;
    }
    else if (sig.type === 'SELL' && position !== null) {
      // Check if stop/TP was hit before this signal
      const barsInPosition = bars.slice(position.entryIdx + 1, sig.i + 1);
      let exitPrice = sig.price;
      let exitTime = sig.time;
      let exitReason = 'signal';

      for (const b of barsInPosition) {
        if (b.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitTime = b.time;
          exitReason = 'stop';
          break;
        }
        if (b.high >= position.takeProfit) {
          exitPrice = position.takeProfit;
          exitTime = b.time;
          exitReason = 'tp';
          break;
        }
      }

      const exitValue = position.qty * exitPrice;
      const pnl = exitValue - position.sizeUsd;
      const returnPct = (pnl / position.sizeUsd) * 100;
      const holdHours = Math.round((exitTime - position.entryTime) / 3600000);

      trades.push({
        entryTime: position.entryTime,
        exitTime,
        entryPrice: position.entryPrice,
        exitPrice,
        pnl,
        returnPct: Math.round(returnPct * 100) / 100,
        win: pnl > 0,
        holdHours,
        exitReason,
        entryStrength: position.strength,
      });

      cash += exitValue;
      position = null;
    }
  }

  // Close any open position at last bar
  if (position !== null && bars.length > 0) {
    const lastBar = bars[bars.length - 1];
    // Check stop/TP first
    const barsInPosition = bars.slice(position.entryIdx + 1);
    let exitPrice = lastBar.close;
    let exitReason = 'open';
    for (const b of barsInPosition) {
      if (b.low <= position.stopLoss) { exitPrice = position.stopLoss; exitReason = 'stop'; break; }
      if (b.high >= position.takeProfit) { exitPrice = position.takeProfit; exitReason = 'tp'; break; }
    }
    const exitValue = position.qty * exitPrice;
    trades.push({
      entryTime: position.entryTime,
      exitTime: lastBar.time,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl: exitValue - position.sizeUsd,
      returnPct: Math.round(((exitValue - position.sizeUsd) / position.sizeUsd) * 10000) / 100,
      win: exitValue > position.sizeUsd,
      holdHours: Math.round((lastBar.time - position.entryTime) / 3600000),
      exitReason,
      open: true,
    });
    cash += exitValue;
  }

  return { trades, finalCapital: cash };
}

// ─── Statistics ───────────────────────────────────────────────
function stats(trades, startCapital) {
  if (trades.length < 3) return { error: `only ${trades.length} trades` };
  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const returns = trades.map(t => t.returnPct / 100);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;  // annualized

  // Max drawdown
  let capital = startCapital;
  let peak = capital;
  let maxDD = 0;
  for (const t of trades) {
    capital += t.pnl;
    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const totalReturn = ((trades.reduce((a, t) => a + t.pnl, 0)) / startCapital) * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.returnPct, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (wins.length * avgWin) / (losses.length * avgLoss) : Infinity;
  const calmar = maxDD > 0 ? totalReturn / (maxDD * 100) : 0;
  const stopPct = trades.filter(t => t.exitReason === 'stop').length / trades.length * 100;
  const tpPct = trades.filter(t => t.exitReason === 'tp').length / trades.length * 100;

  return {
    n: trades.length,
    winRate: Math.round((wins.length / trades.length) * 100),
    totalReturnPct: Math.round(totalReturn * 10) / 10,
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 1000) / 10,
    calmar: Math.round(calmar * 100) / 100,
    avgHoldHours: Math.round(trades.reduce((s, t) => s + (t.holdHours || 0), 0) / trades.length),
    stopHitPct: Math.round(stopPct),
    tpHitPct: Math.round(tpPct),
    kellyFrac: wins.length > 0 && losses.length > 0 && avgLoss > 0
      ? Math.round(((wins.length/trades.length) - (losses.length/trades.length) / (avgWin / avgLoss)) * 100) / 100
      : null,
  };
}

// ─── Walk-Forward Test ────────────────────────────────────────
function walkForward(bars, params) {
  const splitIdx = Math.floor(bars.length * IS_SPLIT);
  const inSample = bars.slice(0, splitIdx);
  const outSample = bars.slice(splitIdx);

  const isSignals = generateSignals(inSample, params);
  const oosSignals = generateSignals(outSample, params);

  // Adjust OOS signal indices (they're relative to outSample start)
  const { trades: isTrades } = simulate(inSample, isSignals);
  const { trades: oosTrades } = simulate(outSample, oosSignals);

  return {
    is:  stats(isTrades, 100),
    oos: stats(oosTrades, 100),
    isTradeCount: isTrades.length,
    oosTradeCount: oosTrades.length,
  };
}

// ─── Main ─────────────────────────────────────────────────────
async function runDeepBacktest() {
  const startTime = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`delu DEEP backtest — ${new Date().toISOString()}`);
  console.log(`Tokens: ${TOKENS.length} | Param combos: ${PARAM_GRID.length}`);
  console.log(`Walk-forward: 70% IS / 30% OOS`);
  console.log(`${'═'.repeat(60)}\n`);

  const allResults = [];
  const allParamResults = [];

  for (const token of TOKENS) {
    const src = token.binance ? 'Binance' : 'CoinGecko';
    process.stdout.write(`[${token.symbol}] Fetching 1yr hourly from ${src}...`);

    let bars;
    try {
      if (token.binance) {
        bars = await fetchBinance(token.binance, 365);
        await sleep(300);
      } else {
        bars = await fetchCoinGecko(token.coingecko, 365);
        await sleep(6000);
      }
    } catch (e) {
      console.log(` FAILED: ${e.message}`);
      allResults.push({ token: token.symbol, error: e.message });
      continue;
    }

    if (!bars || bars.length < 200) {
      console.log(` SKIP: only ${bars?.length} bars`);
      allResults.push({ token: token.symbol, error: `only ${bars?.length} bars` });
      continue;
    }

    console.log(` ${bars.length} bars | $${bars[0].close.toFixed(4)} → $${bars[bars.length-1].close.toFixed(4)}`);

    // Run all param combos
    let bestParams = null, bestSharpe = -Infinity, bestStats = null;
    let totalTokenTrades = 0;

    for (let pi = 0; pi < PARAM_GRID.length; pi++) {
      const params = PARAM_GRID[pi];
      try {
        const wf = walkForward(bars, params);
        const totalTrades = (wf.isTradeCount || 0) + (wf.oosTradeCount || 0);
        totalTokenTrades += totalTrades;

        const oosSharpe = wf.oos?.sharpe || -999;
        if (oosSharpe > bestSharpe && !wf.oos?.error) {
          bestSharpe = oosSharpe;
          bestParams = params;
          bestStats = wf;
        }

        allParamResults.push({
          token: token.symbol,
          paramIdx: pi,
          params: `rsi${params[0]}_ema${params[1]}/${params[2]}_rsiBand${params[3]}-${params[4]}_str${params[5]}`,
          is: wf.is,
          oos: wf.oos,
          isN: wf.isTradeCount,
          oosN: wf.oosTradeCount,
        });
      } catch (e) {
        // skip bad param combo
      }
    }

    console.log(`  → ${totalTokenTrades} total trades across ${PARAM_GRID.length} param combos`);
    if (bestStats && bestStats.oos && !bestStats.oos.error) {
      const o = bestStats.oos;
      console.log(`  → BEST OOS: sharpe=${o.sharpe} winRate=${o.winRate}% return=${o.totalReturnPct}% maxDD=${o.maxDrawdownPct}% PF=${o.profitFactor} (${bestStats.oosTradeCount} trades)`);
    }

    allResults.push({
      token: token.symbol,
      bars: bars.length,
      totalParamTrades: totalTokenTrades,
      bestParams: bestParams ? `rsi${bestParams[0]}_ema${bestParams[1]}/${bestParams[2]}` : null,
      bestStats,
    });
  }

  // ─── Summary ─────────────────────────────────────────────────
  const totalTrades = allParamResults.reduce((s, r) => s + (r.isN || 0) + (r.oosN || 0), 0);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`DEEP BACKTEST COMPLETE — ${totalTrades.toLocaleString()} total trades simulated | ${elapsed}s`);
  console.log(`${'═'.repeat(60)}`);

  // Top 10 param combos by OOS Sharpe
  const ranked = allParamResults
    .filter(r => r.oos && !r.oos.error && r.oosN >= 5)
    .sort((a, b) => (b.oos?.sharpe || 0) - (a.oos?.sharpe || 0))
    .slice(0, 15);

  console.log('\n🏆 TOP CONFIGURATIONS (by OOS Sharpe, min 5 trades):');
  console.log(`${'─'.repeat(90)}`);
  console.log(`${'Token'.padEnd(8)} ${'Params'.padEnd(30)} ${'OOS-N'.padEnd(7)} ${'WinRate'.padEnd(9)} ${'Return'.padEnd(9)} ${'Sharpe'.padEnd(8)} ${'MaxDD'.padEnd(8)} ${'PF'}`);
  console.log(`${'─'.repeat(90)}`);
  for (const r of ranked) {
    const o = r.oos;
    console.log(
      `${r.token.padEnd(8)} ` +
      `${r.params.padEnd(30)} ` +
      `${String(r.oosN).padEnd(7)} ` +
      `${String(o.winRate + '%').padEnd(9)} ` +
      `${String(o.totalReturnPct + '%').padEnd(9)} ` +
      `${String(o.sharpe).padEnd(8)} ` +
      `${String(o.maxDrawdownPct + '%').padEnd(8)} ` +
      `${o.profitFactor}`
    );
  }

  // Overall stats across all best configs
  const validOOS = allResults.filter(r => r.bestStats?.oos && !r.bestStats.oos.error);
  if (validOOS.length > 0) {
    const avgSharpe = validOOS.reduce((s, r) => s + r.bestStats.oos.sharpe, 0) / validOOS.length;
    const avgWinRate = validOOS.reduce((s, r) => s + r.bestStats.oos.winRate, 0) / validOOS.length;
    const avgReturn = validOOS.reduce((s, r) => s + r.bestStats.oos.totalReturnPct, 0) / validOOS.length;
    const avgDD = validOOS.reduce((s, r) => s + r.bestStats.oos.maxDrawdownPct, 0) / validOOS.length;

    console.log(`\n📊 AGGREGATE (best per token, OOS):`);
    console.log(`   Avg Sharpe:   ${Math.round(avgSharpe * 100) / 100}`);
    console.log(`   Avg Win Rate: ${Math.round(avgWinRate)}%`);
    console.log(`   Avg Return:   ${Math.round(avgReturn * 10) / 10}%`);
    console.log(`   Avg Max DD:   ${Math.round(avgDD * 10) / 10}%`);
    console.log(`   Tokens with edge: ${validOOS.filter(r => r.bestStats.oos.sharpe > 0.5).length}/${validOOS.length}`);
  }

  // Winning parameter combos analysis
  const winningCombos = {};
  for (const r of allParamResults.filter(r => r.oos && !r.oos.error && r.oos.sharpe > 1 && r.oosN >= 5)) {
    const key = r.params;
    if (!winningCombos[key]) winningCombos[key] = { count: 0, totalSharpe: 0 };
    winningCombos[key].count++;
    winningCombos[key].totalSharpe += r.oos.sharpe;
  }

  const sortedCombos = Object.entries(winningCombos)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  if (sortedCombos.length > 0) {
    console.log('\n🎯 MOST ROBUST PARAM COMBOS (Sharpe > 1 across multiple tokens):');
    for (const [combo, data] of sortedCombos) {
      console.log(`   ${combo} → works on ${data.count} tokens | avg sharpe ${Math.round(data.totalSharpe / data.count * 100) / 100}`);
    }
  }

  // Save full results
  const outFile = path.join(RESULTS_DIR, `deep-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(),
    config: {
      tokens: TOKENS.length,
      paramCombos: PARAM_GRID.length,
      wfSplit: IS_SPLIT,
      totalTradesSimulated: totalTrades,
      elapsedSeconds: elapsed,
    },
    topConfigs: ranked,
    tokenSummary: allResults.map(r => ({
      token: r.token,
      bars: r.bars,
      totalParamTrades: r.totalParamTrades,
      bestParams: r.bestParams,
      oosBestStats: r.bestStats?.oos,
      isBestStats: r.bestStats?.is,
      error: r.error,
    })),
    allParamResults,
  }, null, 2));

  console.log(`\n💾 Full results saved: ${outFile}`);
  console.log(`   Total trades simulated: ${totalTrades.toLocaleString()}`);

  return { ranked, allResults, totalTrades };
}

runDeepBacktest().catch(e => {
  console.error('Deep backtest error:', e);
  process.exit(1);
});
