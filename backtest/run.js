#!/usr/bin/env node
/**
 * delu overnight backtest
 * Fetches 30 days of OHLCV, runs signal strategy, finds patterns
 *
 * Data sources (no API key needed):
 *   - CoinGecko: OHLCV history for ETH + Base tokens
 *   - Chainlink: price rounds for ETH (onchain truth)
 *
 * Outputs: backtest/results/YYYY-MM-DD.json
 */

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Tokens to backtest — CoinGecko IDs + DEX Screener addresses
const TOKENS = [
  { symbol: 'ETH',    id: 'ethereum' },
  { symbol: 'BTC',    id: 'bitcoin' },
  { symbol: 'BRETT',  id: 'based-brett' },
  { symbol: 'DEGEN',  id: 'degen-base' },
  { symbol: 'TOSHI',  id: 'toshi', dex: '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4' },
  { symbol: 'AERO',   id: 'aerodrome-finance' },
  { symbol: 'BNKR',   id: 'bankr-bot', dex: null },
];

const RATE_LIMIT_MS = 6000;  // 6s between CoinGecko calls (free tier = 10-30 req/min)

// ─── Data Fetching ────────────────────────────────────────────

async function fetchOHLCV(coinId, days = 30) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // CoinGecko OHLC: [timestamp, open, high, low, close]
    return data.map(([ts, o, h, l, c]) => ({
      ts, time: new Date(ts),
      open: o, high: h, low: l, close: c,
      volume: 0  // OHLC endpoint doesn't include volume
    }));
  } catch (e) {
    console.warn(`[fetch] ${coinId} OHLC failed: ${e.message}, trying market_chart...`);
    return fetchMarketChart(coinId, days);
  }
}

async function fetchMarketChart(coinId, days = 30) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${coinId}`);
  const data = await res.json();
  const prices = data.prices || [];
  const volumes = data.total_volumes || [];
  return prices.map(([ts, price], i) => ({
    ts,
    time: new Date(ts),
    close: price,
    open: i > 0 ? prices[i-1][1] : price,
    high: price,
    low: price,
    volume: volumes[i]?.[1] || 0
  }));
}

// ─── Technical Indicators ─────────────────────────────────────

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi[i] = 100 - (100 / (1 + rs));
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

function calcBollingerWidth(closes, period = 20) {
  const width = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const slice = closes.slice(i - period, i);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    width[i] = (std * 2) / mean;  // normalized band width
  }
  return width;
}

// ─── Signal Detection ─────────────────────────────────────────

function detectSignals(bars, indicators) {
  const { rsi, ema9, ema21, obv, bbWidth } = indicators;
  const signals = [];

  for (let i = 25; i < bars.length; i++) {
    const sig = {
      i,
      time: bars[i].time,
      price: bars[i].close,
      rsi: rsi[i],
      ema_cross: null,
      obv_divergence: false,
      bb_squeeze: false,
      entry: null,
      strength: 0
    };

    // EMA crossover: 9 crosses above 21
    if (ema9[i] !== null && ema21[i] !== null && ema9[i-1] !== null && ema21[i-1] !== null) {
      if (ema9[i-1] < ema21[i-1] && ema9[i] > ema21[i]) sig.ema_cross = 'BULLISH';
      if (ema9[i-1] > ema21[i-1] && ema9[i] < ema21[i]) sig.ema_cross = 'BEARISH';
    }

    // RSI divergence: price makes new low but RSI doesn't (bullish)
    if (i >= 5 && rsi[i] !== null) {
      const priceDown = bars[i].close < bars[i-5].close;
      const rsiUp = rsi[i] > rsi[i-5];
      if (priceDown && rsiUp) sig.obv_divergence = true;  // using as proxy
    }

    // OBV divergence: price flat/down but OBV rising
    if (i >= 4 && obv[i] !== undefined) {
      const priceFlat = Math.abs(bars[i].close - bars[i-4].close) / bars[i-4].close < 0.02;
      const obvRising = obv[i] > obv[i-4];
      sig.obv_divergence = sig.obv_divergence || (priceFlat && obvRising);
    }

    // Bollinger squeeze
    if (bbWidth[i] !== null) {
      const bbSlice = bbWidth.slice(Math.max(0, i-90), i).filter(v => v !== null);
      if (bbSlice.length > 20) {
        const sorted = [...bbSlice].sort((a, b) => a - b);
        const p20 = sorted[Math.floor(sorted.length * 0.2)];
        sig.bb_squeeze = bbWidth[i] <= p20;
      }
    }

    // RSI oversold + not in extreme downtrend
    const rsiOversold = rsi[i] !== null && rsi[i] < 40;
    const rsiNotExtreme = rsi[i] !== null && rsi[i] > 20;

    // ENTRY SIGNAL: multiple confirmations
    let strength = 0;
    if (sig.ema_cross === 'BULLISH') strength += 2;
    if (sig.obv_divergence) strength += 2;
    if (rsiOversold && rsiNotExtreme) strength += 1;
    if (sig.bb_squeeze) strength += 1;

    sig.strength = strength;
    if (strength >= 3) {
      sig.entry = 'BUY';
      signals.push(sig);
    }

    // EXIT SIGNAL: RSI overbought or EMA death cross
    const rsiOverbought = rsi[i] !== null && rsi[i] > 70;
    if (rsiOverbought || sig.ema_cross === 'BEARISH') {
      sig.entry = 'SELL';
      if (rsiOverbought || sig.ema_cross === 'BEARISH') signals.push({ ...sig, entry: 'SELL', strength: 2 });
    }
  }

  return signals;
}

// ─── Backtest Simulation ──────────────────────────────────────

function simulate(bars, signals, startCapital = 10) {
  let cash = startCapital;
  let position = null;
  const trades = [];
  const equity = [{ time: bars[0].time, value: cash }];

  for (const sig of signals.filter(s => s.entry !== null)) {
    if (sig.entry === 'BUY' && position === null) {
      const sizeUsd = cash * 0.2;  // 20% Kelly-ish
      const qty = sizeUsd / sig.price;
      position = { entryPrice: sig.price, qty, sizeUsd, entryTime: sig.time, entryRSI: sig.rsi };
      cash -= sizeUsd;
      equity.push({ time: sig.time, value: cash + position.qty * sig.price });
    }
    else if (sig.entry === 'SELL' && position !== null) {
      const exitValue = position.qty * sig.price;
      const pnl = exitValue - position.sizeUsd;
      const returnPct = (pnl / position.sizeUsd) * 100;

      trades.push({
        entryTime: position.entryTime,
        exitTime: sig.time,
        entryPrice: position.entryPrice,
        exitPrice: sig.price,
        pnl: Math.round(pnl * 10000) / 10000,
        returnPct: Math.round(returnPct * 100) / 100,
        win: pnl > 0,
        holdHours: Math.round((sig.time - position.entryTime) / 3600000)
      });

      cash += exitValue;
      equity.push({ time: sig.time, value: cash });
      position = null;
    }
  }

  // Close any open position at last price
  if (position !== null && bars.length > 0) {
    const lastPrice = bars[bars.length - 1].close;
    const exitValue = position.qty * lastPrice;
    trades.push({
      entryTime: position.entryTime,
      exitTime: bars[bars.length - 1].time,
      entryPrice: position.entryPrice,
      exitPrice: lastPrice,
      pnl: Math.round((exitValue - position.sizeUsd) * 10000) / 10000,
      returnPct: Math.round(((exitValue - position.sizeUsd) / position.sizeUsd) * 10000) / 100,
      win: exitValue > position.sizeUsd,
      open: true
    });
    cash += exitValue;
    equity.push({ time: bars[bars.length - 1].time, value: cash });
  }

  return { trades, finalCapital: cash, equity };
}

function calcStats(trades, startCapital) {
  if (trades.length === 0) return { error: 'no trades' };

  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const totalReturn = ((trades.reduce((s, t) => s + t.pnl, 0)) / startCapital) * 100;
  const maxDrawdown = calcMaxDrawdown(trades, startCapital);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.returnPct, 0) / losses.length : 0;
  const sharpe = trades.length > 2 ? calcSharpe(trades) : null;

  return {
    totalTrades: trades.length,
    winRate: Math.round((wins.length / trades.length) * 100),
    totalReturnPct: Math.round(totalReturn * 100) / 100,
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
    sharpe: sharpe ? Math.round(sharpe * 100) / 100 : null,
    avgHoldHours: Math.round(trades.reduce((s, t) => s + (t.holdHours || 0), 0) / trades.length),
    kellyFraction: wins.length > 0 && losses.length > 0
      ? Math.round(((wins.length/trades.length) - (losses.length/trades.length) / (avgWin / Math.abs(avgLoss))) * 1000) / 10
      : null
  };
}

function calcMaxDrawdown(trades, startCapital) {
  let capital = startCapital;
  let peak = capital;
  let maxDD = 0;
  for (const t of trades) {
    capital += t.pnl;
    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

function calcSharpe(trades) {
  const returns = trades.map(t => t.returnPct / 100);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);  // annualized
}

// ─── Pattern Analysis ─────────────────────────────────────────

function findPatterns(allResults) {
  const patterns = [];

  // Which indicators have highest win rate?
  const withEmaCross = allResults.flatMap(r => r.trades.filter(t => t.hasEmaCross));
  const withOBVDiv = allResults.flatMap(r => r.trades.filter(t => t.hasOBVDiv));

  // Best performing tokens
  const byToken = allResults.map(r => ({
    token: r.token,
    winRate: r.stats.winRate,
    totalReturn: r.stats.totalReturnPct,
    sharpe: r.stats.sharpe,
    avgHold: r.stats.avgHoldHours
  })).sort((a, b) => (b.sharpe || 0) - (a.sharpe || 0));

  patterns.push('=== TOP PERFORMERS BY SHARPE ===');
  byToken.forEach(t => {
    patterns.push(`  ${t.token}: sharpe=${t.sharpe} winRate=${t.winRate}% return=${t.totalReturn}% avgHold=${t.avgHold}h`);
  });

  // Optimal hold time
  const allTrades = allResults.flatMap(r => r.trades || []);
  const holdBuckets = {};
  allTrades.forEach(t => {
    const bucket = Math.floor((t.holdHours || 0) / 4) * 4;
    if (!holdBuckets[bucket]) holdBuckets[bucket] = { wins: 0, total: 0 };
    holdBuckets[bucket].total++;
    if (t.win) holdBuckets[bucket].wins++;
  });

  patterns.push('\n=== WIN RATE BY HOLD TIME ===');
  Object.entries(holdBuckets).sort((a, b) => +a[0] - +b[0]).forEach(([hours, data]) => {
    const wr = Math.round((data.wins / data.total) * 100);
    patterns.push(`  ${hours}-${+hours+4}h: ${wr}% win rate (${data.total} trades)`);
  });

  return patterns.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────

async function runBacktest() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`delu backtest — ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(50)}\n`);

  const results = [];

  for (const token of TOKENS) {
    console.log(`\n[${token.symbol}] Fetching 30d data...`);
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));  // rate limit CoinGecko

    let bars;
    try {
      bars = await fetchOHLCV(token.id, 30);
    } catch (e) {
      // Retry once after longer wait
      console.warn(`[${token.symbol}] Failed (${e.message}), retrying in 15s...`);
      await new Promise(r => setTimeout(r, 15000));
      try {
        bars = await fetchOHLCV(token.id, 30);
      } catch (e2) {
        console.warn(`[${token.symbol}] Retry failed: ${e2.message}`);
        results.push({ token: token.symbol, error: e2.message });
        continue;
      }
    }

    if (!bars || bars.length < 30) {
      console.warn(`[${token.symbol}] Insufficient data: ${bars?.length} bars`);
      results.push({ token: token.symbol, error: `Only ${bars?.length} bars` });
      continue;
    }

    console.log(`[${token.symbol}] ${bars.length} bars | price range: $${Math.min(...bars.map(b => b.close)).toFixed(4)} – $${Math.max(...bars.map(b => b.close)).toFixed(4)}`);

    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    const indicators = {
      rsi: calcRSI(closes, 14),
      ema9: calcEMA(closes, 9),
      ema21: calcEMA(closes, 21),
      obv: calcOBV(closes, volumes),
      bbWidth: calcBollingerWidth(closes, 20)
    };

    const signals = detectSignals(bars, indicators);
    const buySignals = signals.filter(s => s.entry === 'BUY');
    console.log(`[${token.symbol}] ${buySignals.length} BUY signals detected`);
    if (buySignals.length > 0) {
      buySignals.slice(0, 3).forEach(s => {
        console.log(`  → ${s.time.toISOString().slice(0, 16)} price=$${s.price.toFixed(4)} rsi=${s.rsi?.toFixed(1)} strength=${s.strength}`);
      });
    }

    const { trades, finalCapital, equity } = simulate(bars, signals, 10);
    const stats = calcStats(trades, 10);

    console.log(`[${token.symbol}] ${trades.length} trades | winRate=${stats.winRate}% | return=${stats.totalReturnPct}% | sharpe=${stats.sharpe}`);

    results.push({
      token: token.symbol,
      bars: bars.length,
      signals: signals.length,
      trades,
      stats,
      equity: equity.slice(-5),  // just last 5 equity points for summary
    });
  }

  // Pattern analysis
  console.log('\n' + findPatterns(results));

  // Save results
  const outFile = path.join(RESULTS_DIR, `${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(),
    summary: results.map(r => ({ token: r.token, stats: r.stats, signals: r.signals, error: r.error })),
    full: results
  }, null, 2));

  console.log(`\n[backtest] Results saved to ${outFile}`);
  console.log('\n=== SUMMARY ===');
  results.forEach(r => {
    if (r.error) {
      console.log(`  ${r.token}: ERROR — ${r.error}`);
    } else {
      const s = r.stats;
      console.log(`  ${r.token}: ${s.totalTrades} trades | ${s.winRate}% wins | ${s.totalReturnPct}% return | sharpe=${s.sharpe}`);
    }
  });

  return results;
}

// Run immediately and schedule every 2h for fresh data
runBacktest().catch(console.error);

if (process.argv.includes('--loop')) {
  console.log('\n[backtest] Scheduling re-runs every 2 hours...');
  setInterval(() => runBacktest().catch(console.error), 2 * 60 * 60 * 1000);
}
