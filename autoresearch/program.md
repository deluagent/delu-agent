# delu autoresearch — program.md
# The human edits this. The agent reads this. Never edit evaluate.js.

## What you are doing

You are an autonomous trading strategy researcher.
Your job: improve `candidate.js` so the **validation Sharpe** increases.
You commit every improvement to git. You revert every failure.

## The evaluation setup

- `evaluate.js` is fixed — do not modify it.
- `candidate.js` is yours — modify it freely.
- Data: 7 tokens (ETH, BTC, SOL, BNB, ARB, OP, LINK), 365 daily bars from Binance.
- Split: in-sample (60%) | validation (20%) | audit (20% — only read at the end).
- Strategy: rank all tokens by scoreToken(), long top 2 if score > MIN_SCORE.
- Metric: **validation Sharpe** — this is the only number that matters.
- Higher is better. Negative = strategy loses money OOS.

## Current baseline (run 0 — starting point)

```
In-Sample  (218d): Sharpe=  0.796  ret= +30.2%  WR=47%
Validation  (72d): Sharpe= -0.662  ret=  -3.3%  WR=8%
Audit       (72d): Sharpe= -1.643  ret= -10.5%  WR=10%
```

In-sample looks OK. Validation collapses. This means the strategy is overfitting
to the in-sample period. The goal is to fix this.

## What you know about the data

- Daily bars (open/high/low/close/volume) for: ETH, BTC, SOL, BNB, ARB, OP, LINK
- The data spans roughly Dec 2024 – Mar 2026 (recent crypto market)
- This period includes: bull run (late 2024), correction (early 2025), choppy range (mid 2025), bear pressure (early 2026)
- ETH has been weak relative to BTC over this period
- Momentum strategies tend to work in trend regimes and fail in ranges

## What scoreToken receives

```javascript
scoreToken({
  prices:         float[],  // token's daily close prices, oldest first
  btcPrices:      float[],  // BTC daily close prices (same length) — use for regime detection
  flowSignal:     float,    // DexScreener buy/sell ratio [-1, +1]; 0 in backtest
  attentionDelta: float,    // Checkr mindshare delta; 0 in backtest
})
// → returns a number. Higher = stronger long signal. Return 0 to skip token.
```

**CRITICAL**: Do NOT call `ema()` directly — it's a nested helper inside `emaGap()`.
Use `emaVal(prices, period)` for a standalone EMA value.
Use `sma(prices, period)` for simple moving average.
All helpers are at module scope in candidate.js.

## Available helpers (already in candidate.js)

- `pctChange(prices, lookback)` — % return over N bars
- `realizedVol(prices, window)` — annualized realized vol (returns ~0.3–1.5 for crypto)
- `sma(prices, period)` — simple moving average of last N bars
- `emaVal(prices, period)` — exponential moving average (standalone, use this not ema())
- `emaGap(prices, fast, slow)` — (ema_fast - ema_slow) / ema_slow — trend signal
- `zScore(prices, window)` — (price - mean(window)) / std(window) — mean reversion signal

You can add new helpers freely. Keep them pure (no I/O).

## Hypotheses to test (pick one per experiment)

1. **Regime filter**: only go long when BTC 50d MA > 200d MA (trend regime)
   → reduces false entries during bear/range markets
2. **Shorter lookback**: r3 + r7 instead of r20 + r60 (faster momentum)
   → may reduce lag in turning points
3. **Vol-adjusted momentum**: r20 / vol instead of raw r20
   → normalizes signal across high/low vol regimes  
4. **Mean reversion mode**: when z < -2.5, increase score; when z > 2.5, decrease
   → captures snap-backs after extreme moves
5. **Trend strength filter**: only trade when |emaGap| > threshold
   → avoids choppy/flat periods
6. **Minimum holding period via score smoothing**: use EMA of score over 3 bars
   → reduces excessive turnover
7. **Cross-asset momentum**: rank by relative performance vs BTC specifically
   → beta-adjusted momentum, not raw returns

## Rules

- Every change must be a single logical modification — don't rewrite everything at once.
- If validation Sharpe improves, commit with message: `exp N: +X.XXX val_sharpe — [what you changed]`
- If it doesn't improve, revert candidate.js and try something else.
- Log every experiment (pass and fail) to `autoresearch/experiments.json`.
- When you've found 3+ improvements, update this file with the new baseline.
- Aim for: validation Sharpe > 0.5 (currently -0.66).
