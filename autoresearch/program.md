# delu autoresearch — program.md
# The human edits this. The agent reads this. Never edit evaluate.js.

## What you are doing

You are an autonomous trading strategy researcher.
Your job: improve `candidate.js` so the **combined score** (0.7 × val_sharpe + 0.3 × audit_sharpe) increases.
You commit every improvement to git. You revert every failure.

## The evaluation setup

- `evaluate.js` is fixed — do not modify it.
- `candidate.js` is yours — modify it freely.
- Data: 55 tokens total — 50 majors (Binance 730d) + 5 Base tokens (GeckoTerminal 181d)
  - Mar 2024 → Mar 2026 (2-year history, BULL + BEAR regimes)
- Split (majors):
  - In-sample  (IS):  bars 0–437   (60%) — Mar 2024–Jul 2025 — early bull + correction
  - Validation (VAL): bars 438–583 (20%) — Jul 2025–Dec 2025 — bull continuation + peak
  - Audit      (AUD): bars 584–729 (20%) — Dec 2025–Mar 2026 — bear drawdown (NEVER used for decisions)
- Strategy: rank all tokens by scoreToken(), long top 5 if score > MIN_SCORE (0.05)
- Metric: **combined score = 0.7 × val_sharpe + 0.3 × audit_sharpe**
  - Both must be positive. Never sacrifice audit Sharpe for val Sharpe.
  - Minimum bar: val_sharpe > 1.5 AND audit_sharpe > 0.3

## Current baseline (exp 55, 2026-03-21)

```
In-Sample   (437d):  Sharpe=  0.700  ret=  52.1%  DD=55.3%  WR=40%
Validation  (180d):  Sharpe=  3.126  ret= 162.5%  DD=19.1%  WR=47%  [majors=3.50 base=0.00]
Audit       (180d):  Sharpe=  1.424  ret=  21.4%  DD= 9.0%  WR= 6%  [majors=1.59 base=0.00]
Combined score: 0.7×3.126 + 0.3×1.424 = 2.615
```

Beat: combined > 2.615. Val alone is not enough — audit must stay positive.

## What scoreToken receives (UPDATED — now includes OHLCV)

```javascript
scoreToken({
  prices:         float[],  // daily close prices, oldest first
  volumes:        float[],  // daily volumes (same length as prices) — NEW
  opens:          float[],  // daily open prices — NEW  
  highs:          float[],  // daily high prices — NEW
  lows:           float[],  // daily low prices — NEW
  btcPrices:      float[],  // BTC daily closes — for regime detection
  flowSignal:     float,    // Binance perp funding z-score, INVERTED [-1,+1]
                            // Positive = bullish (shorts paying = crowded short)
  attentionDelta: float,    // 0 in backtest (future: social attention)
})
// → returns a number. Higher = stronger long signal. Return 0 or negative to skip.
```

## Available helpers (already in candidate.js)

- `pctChange(prices, lookback)` — % return over N bars
- `realizedVol(prices, window)` — annualized realized vol (~0.3–1.5 for crypto)
- `sma(prices, period)` — simple moving average of last N bars
- `emaVal(prices, period)` — exponential moving average (use this, not ema())
- `emaGap(prices, fast, slow)` — (ema_fast - ema_slow) / ema_slow
- `zScore(prices, window)` — (price - mean) / std — mean reversion signal

You can add new helpers. Keep them pure (no I/O, no randomness).

## NEW SIGNALS NOW AVAILABLE (volumes, highs, lows)

These are from TRADING_BRAIN.md — our actual quant framework. Implement them:

### OBV Divergence (high priority)
```javascript
// Price flat + OBV rising = accumulation = bullish
// Build OBV series, compare OBV trend vs price trend
// Divergence = OBV outperforming price
let obv = 0;
const obvSeries = [];
for (let i = 1; i < n; i++) {
  if (prices[i] > prices[i-1]) obv += volumes[i];
  else if (prices[i] < prices[i-1]) obv -= volumes[i];
  obvSeries.push(obv);
}
// Compare OBV 20d slope vs price 20d slope → divergence signal
```

### Volume Surprise (confirmation signal)
```javascript
// Today's volume vs 30d rolling average
// High vol on up day = strong move. High vol on down day = distribution.
const avgVol = sma(volumes.slice(0, n-1), 30);
const volSurprise = avgVol > 0 ? (volumes[n-1] - avgVol) / avgVol : 0;
// Use directionally: volSurprise * sign(momentum) as confirmation
```

### ATR Penalty (risk sizing — from TRADING_BRAIN)
```javascript
// ATR as % of price — tokens with huge daily swings are harder to trade
// Penalize if ATR > 5% of price
const trs = [];
for (let i = Math.max(1, n-14); i < n; i++) {
  trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-prices[i-1]), Math.abs(lows[i]-prices[i-1])));
}
const atr = trs.reduce((s,v) => s+v, 0) / trs.length;
const atrPct = prices[n-1] > 0 ? atr / prices[n-1] : 0.03;
const atrPenalty = -Math.max(0, atrPct - 0.05) * 1.5;
```

### GARCH(1,1) Vol Proxy (better than realized vol)
```javascript
// σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}  (Engle/Bollerslev)
// Better than realized vol because it captures vol clustering
const omega = 0.000001, alpha = 0.10, beta = 0.85;
const rets = [];
for (let i = n-20; i < n; i++) if (prices[i-1] > 0) rets.push(Math.log(prices[i]/prices[i-1]));
let garchVar = rets.reduce((s,r) => s + r*r, 0) / rets.length;
for (let i = 1; i < rets.length; i++) garchVar = omega + alpha*rets[i-1]**2 + beta*garchVar;
const garchVol = Math.sqrt(Math.max(garchVar, 0) * 252);
// Use garchVol instead of realizedVol for vol-scaling momentum
```

### RSI Divergence (contrarian signal)
```javascript
// Price new high but RSI weakening = bearish divergence
// Price new low but RSI strengthening = bullish divergence
function rsi(prices, period=14) {
  let gains=0, losses=0;
  for (let i = prices.length-period; i < prices.length; i++) {
    const d = prices[i] - prices[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = losses === 0 ? 100 : gains/losses;
  return 100 - 100/(1+rs);
}
```

## Hypotheses to test (ONE per experiment)

### Volume-based (new, unexplored — high expected value)
1. **OBV divergence**: add OBV trend vs price trend divergence signal (weight 0.10–0.15)
2. **Volume surprise confirmation**: directional vol surprise = momentum × volSurprise × small_weight
3. **Volume on breakout**: only enter momentum positions when today's vol > 1.5× 30d avg

### Risk sizing improvements
4. **ATR penalty**: penalize tokens where daily ATR > 5% of price (reduces drawdown)
5. **GARCH vol**: replace realizedVol with garchVol in the vol penalty — better vol clustering

### Regime refinements
6. **Volatility regime**: add σ_7d / σ_30d ratio — if > 1.8, reduce all scores by 50% (panic signal)
7. **RSI divergence**: add as small contrarian overlay (±0.06)

### Momentum improvements
8. **120d lookback**: add r120d = pctChange(prices, 120) with weight 0.15 (longer trend)
9. **Cross-sectional**: current ranking is already cross-sectional — try wider spread

## Rules

- Make ONE small, specific change per experiment.
- If combined score (0.7×val + 0.3×aud) improves AND audit > -0.5: commit.
- Otherwise: revert.
- **Current target**: combined > 2.615 (val=3.126, aud=1.424)
- Vol signals (OBV, volume surprise) are the highest priority — never tried, maximum info gain.
