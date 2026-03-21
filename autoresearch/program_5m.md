# 5-Minute Signal Research Program

## Context
- 26 tokens, 30 days of 5m bars (8640 bars)
- Rebalance every 12 bars (= 1 hour)
- Score range: [-1, +1] — positive = long, negative = short
- Top 3 long + bottom 2 short each cycle
- Metric: 0.5*val_sharpe + 0.5*aud_sharpe
- Data periods: Feb 19 → Mar 21, 2026 (slight bull → slight bear)
- Baseline: val=-18.2, aud=-40.3 — needs complete rethink

## Key insight about 5m vs hourly/daily
At 5m resolution:
- Transaction costs matter — wide spreads eat small moves
- Holding 1 hour = 12 bars, so signals must persist for at least 12 bars
- Mean reversion works better than momentum at very short horizons
- Volume is the most reliable intraday signal — price is noisy
- Relative strength at 1h-4h horizon is more reliable than 5m returns

## What went wrong with the baseline
- Used 5m and 15m returns as primary signals — too noisy, overfit to noise
- 1h rebalance but 5m momentum flips every few bars
- Need to look at 1h+ horizons for signal, execute at 5m precision

## Correct approach for 5m bars, 1h rebalance

### H1: Use 1h+ horizon signals only (no 5m noise)
- ret12 (1h return) and ret48 (4h return) as core signals
- Ignore ret1 and ret3 entirely — too noisy at 1h rebalance
- 1h OBV trend (sum of 12-bar signed volumes)

### H2: Volume-weighted price trend
- VWAP deviation: price vs volume-weighted avg of last 12 bars
- Above VWAP + rising volume = long signal
- Below VWAP + rising volume = short signal (capitulation)

### H3: Range position at rebalance
- Where is price within the last 48-bar (4h) high/low range?
- High range position + volume > avg = continuation long
- Low range position + volume > avg = oversold bounce long

### H4: Pure relative strength (1h)
- Rank all tokens by 12-bar return
- Long top 3, short bottom 2 — simple cross-sectional momentum
- No other signals — just ranking

### H5: OBV z-score at 1h
- OBV z-score over 48 bars
- Positive z-score = accumulation = long
- Negative z-score = distribution = short

### H6: Intraday trend alignment
- EMA12 > EMA48 (using 5m bars but at 1h resolution)
- Only long when price above both EMAs
- EMA divergence = avoid

### H7: Volume anomaly detection
- Last 12 bars volume vs 72-bar average (6h)
- Burst >2x average = significant event
- Direction: if price up = institutional buying = long
- Direction: if price down = panic selling = short (fade or follow?)

## Constraints
- Score must be in [-1, +1]
- No redefined helpers (ema, sma, realizedVol, zScore)
- Min bars needed: 288 (1 day of 5m)
- No lookahead bias
- Keep it simple — 5m noise is high, fewer signals is better
