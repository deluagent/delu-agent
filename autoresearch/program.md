# delu autoresearch — program.md

## Mission
Build a trading strategy that could scale to $1M AUM.
We need Sharpe > 4.0 val AND audit > 1.5. Currently at val=3.711, aud=1.393.

## Setup
- 55 tokens (50 Binance majors + 5 Base), 730 daily bars
- Score all tokens daily, long top 5, equal weight, next-bar execution
- In-sample: days 0-436 | Validation: 437-616 | Audit: 617-729
- BEAR period dominates audit — strategy MUST work in bear (oversold bounces, funding divergence)

## Current best (exp 252, val=3.719)
Strategy: adaptive lookback momentum + EMA filter + OBV + funding rate + vol penalty + mean reversion
Key: adaptive lookback (vol > 0.75 → short-term r3/r7, else long-term r20/r60)
Key: hard knife filter (r7 < -0.20 → return 0)
Key: EMA gap filter (|ema| < 0.03 → return 0, removes sideways)

## What scoreToken receives
```
{ prices, volumes, highs, lows, btcPrices, flowSignal, attentionDelta }
prices/btcPrices: daily close float[], oldest first
volumes: daily volume float[]
highs/lows: daily OHLC float[]
flowSignal: Binance perp funding rate z-score INVERTED [-1,+1] (positive = bullish)
attentionDelta: Checkr social attention velocity (0-1, higher = more social attention)
```

## Available helpers (already defined, do NOT redefine)
pctChange(prices, lookback) → float
realizedVol(prices, window) → annualized vol float
sma(prices, period) → float
emaVal(prices, period) → float
emaGap(prices, fast, slow) → float (positive = bullish)
zScore(prices, window) → float
calculateObvSig(prices, volumes, window) → float [-1,+1]

## Untried ideas (priority order — try these next)

### 1. Cross-sectional rank normalization
Instead of raw momentum, use RANK of momentum across the universe.
Rank-based signals are more robust than raw values.
Problem: scoreToken is called per-token and doesn't see others.
Workaround: use z-score of recent returns as a rank proxy.

### 2. ATR-based position quality filter
If ATR(14) > 8% of price → very noisy, return 0 or heavy penalty.
If ATR(14) < 2% of price → consolidating, good entry.
atr = mean of (highs[i] - lows[i]) for last 14 bars / close

### 3. Volume confirmation (breakthrough filter)
If price up > 3% but volume < 0.8× 20d average → false breakout, penalize
If price up > 3% and volume > 1.5× 20d average → confirmed breakout, boost

### 4. Higher-timeframe trend alignment
Use 90d trend as filter gate — only trade tokens trending up over 90 days
pctChange(prices, 90) > 0 required for full score

### 5. Consecutive up-days streak
Count consecutive days of positive closes. 3-5 in a row = momentum confirmed.
Too many (>8) = overbought, penalize.

### 6. Price vs 52-week high
Score = 1 - (price / max52w). Tokens near 52w high have momentum.
Tokens far from 52w high in bear could be recovering.

### 7. Multi-factor composite with strict filters
Require ALL of: EMA bullish + OBV positive + r20 > 0 + not oversold on z-score
Return 0 if ANY filter fails. Only score tokens that pass all gates.
This reduces number of trades but improves quality.

### 8. GARCH-style vol forecast
Use ratio of short-vol to long-vol as regime signal:
shortVol = realizedVol(prices, 5)
longVol = realizedVol(prices, 30)
If shortVol > 1.5 × longVol → vol expanding → reduce position
If shortVol < 0.7 × longVol → vol contracting → boost position

### 9. Drawdown recovery signal
If price is recovering from a recent -20% drawdown:
max20 = max of last 20 prices
drawdown = (max20 - price) / max20
If drawdown > 0.20 and recovering (r7 > 0) → oversold bounce → boost in BEAR

### 10. Funding rate + momentum alignment
Currently funding is additive. Try: if funding bullish AND momentum > 0 → double boost.
If disagreement → cancel out. Require alignment, not just addition.

## What NOT to do
- Don't remove the adaptive lookback (it's core to val=3.719)
- Don't remove the falling knife filter (r7 < -0.20)
- Don't remove the EMA gap filter
- Don't just tweak weights (we've done 1500 experiments of that)
- Don't add noise signals with no economic intuition

## Target
val_sharpe > 4.0 AND aud_sharpe > 1.5
Combined score = 0.7 × val + 0.3 × aud > 3.25

## Acceptance rule (enforced in loop.js)
New combined score must beat 0.7×3.711 + 0.3×1.393 = 3.016
AND audit must be > -0.5
