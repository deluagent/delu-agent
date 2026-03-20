# delu autoresearch — program.md
# The human edits this. The agent reads this. Never edit evaluate.js.

## What you are doing

You are an autonomous trading strategy researcher.
Your job: improve `candidate.js` so the **validation Sharpe** increases.
You commit every improvement to git. You revert every failure.

## The evaluation setup

- `evaluate.js` is fixed — do not modify it.
- `candidate.js` is yours — modify it freely.
- Data: 7 tokens (ETH, BTC, SOL, BNB, ARB, OP, LINK), 730 daily bars from Binance.
  - Mar 2024 → Mar 2026 (full 2-year history, bull + bear regimes)
- Split:
  - In-sample  (IS):  bars 0–437   (60%) — Mar 2024–Jul 2025 — early bull + correction
  - Validation (VAL): bars 438–583 (20%) — Jul 2025–Dec 2025 — bull continuation + peak
  - Audit      (AUD): bars 584–729 (20%) — Dec 2025–Mar 2026 — bear drawdown (NEVER used for decisions)
- Strategy: rank all tokens by scoreToken(), long top 2 if score > MIN_SCORE (0.02)
- Metric: **validation Sharpe** — this is the only number that matters.
- Higher is better. You accept experiments only if val_sharpe strictly improves.

## Current baseline (reset 2026-03-20 — 12 tokens: 7 majors + 5 Base)

```
In-Sample   (437d):  Sharpe= -0.505  ret= -35.4%  DD=38.0%  WR=16%
Validation  (180d):  Sharpe=  1.183  ret= +41.4%  DD=17.6%  WR=31%  [majors=1.55 base=-3.56]
Audit       (180d):  Sharpe=  0.364  ret=  +2.1%  DD= 5.6%  WR= 1%  [majors=1.87 base=-2.72]
```

Val Sharpe 1.183 is your starting point. Beat it.
Key insight: **Base tokens (BRETT, VIRTUAL, AERO, DEGEN, CLANKER) are dragging the combined score**.
The current signal works well for majors (1.55) but fails on Base alts (-3.56).
This means the regime filter + momentum signals need to be adapted for high-beta Base tokens.

**Priority: fix Base token scoring.** Ideas:
- Base tokens have shorter history (181 bars) — use shorter lookbacks (r3, r7 instead of r20, r60)
- Base tokens are higher beta — vol-adjust more aggressively
- Base tokens respond to BTC regime more violently — sharper regime penalty in BEAR
- In BEAR, return 0 for Base tokens entirely (they crash harder than majors)

## What scoreToken receives

```javascript
scoreToken({
  prices:         float[],  // token's daily close prices, oldest first
  btcPrices:      float[],  // BTC daily close prices (same length) — use for regime detection
  flowSignal:     float,    // Binance perp funding rate z-score, INVERTED, range [-1, +1]
                            // Positive = bullish (negative funding = shorts paying = buy signal)
                            // Negative = bearish (positive funding = longs paying = crowded)
  attentionDelta: float,    // 0 in backtest (future: social attention delta)
})
// → returns a number. Higher = stronger long signal. Return 0 or negative to skip token.
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

## The funding signal (flowSignal) — important alpha

The `flowSignal` is the daily Binance perpetual funding rate, normalized as a z-score and inverted:
- **Positive flowSignal** = funding was negative = shorts paying longs = crowded short = **bullish**
- **Negative flowSignal** = funding was positive = longs paying shorts = crowded long = **bearish**
- Range: [-1, +1] after clamping
- This signal is available for all 7 tokens (ETH, BTC, SOL, BNB, ARB, OP, LINK)

The current baseline uses it with weight 0.10. Try increasing/decreasing this weight.
Try using it as a gate (only trade when funding > threshold) rather than a linear weight.
Try using it to differentiate BULL vs BEAR regime treatment.

## Hypotheses to test (pick ONE per experiment)

### Funding signal (high priority — new signal, unexplored)
1. **Increase funding weight**: 0.10 → 0.20 or 0.30 — see if more funding weight helps
2. **Funding gate**: only enter when flowSignal > 0.05 (market not crowded long)
3. **Funding + regime**: in BEAR regime, require flowSignal > 0 to trade at all
4. **Funding divergence**: go long when price is falling BUT funding is negative (smart money positioning)

### Momentum tuning
5. **Shorter lookback**: r3 + r7 instead of r7 + r20 (faster momentum for crypto)
6. **Vol-adjusted momentum**: divide each momentum component by (1 + vol) — already partially done, try fully
7. **Asymmetric momentum**: larger weight on recent (r7) vs older (r60) in BULL; equal weight in RANGE
8. **Relative momentum vs BTC**: r20_token / r20_btc — captures alpha above market

### Regime handling
9. **Softer BEAR penalty**: try 0.5 instead of 0.3 — BEAR regime still has tradeable tokens
10. **Multi-regime momentum**: BULL → trend signals; BEAR → mean reversion signals only
11. **Vol regime**: when volRatio (7d/30d realized vol) > 1.5 → reduce all signals by 50%

### Risk
12. **Sharpe-weighted sizing**: scale score by inverse vol — higher vol tokens get lower score
13. **Drawdown protection**: if token is down >20% in 30d, score = 0 (skip falling knives)

## Rules

- Every change must be a SINGLE logical modification — don't rewrite everything at once.
- If validation Sharpe improves, commit with message: `exp N: +X.XXX val_sharpe — [what you changed]`
- If it doesn't improve, revert candidate.js and try something else.
- Log every experiment (pass and fail) to `autoresearch/experiments.json`.
- **Target**: validation Sharpe > 2.5 (current: 1.996)
- Secondary goal: audit Sharpe > 0.5 (current: 0.427) — but never sacrifice val for audit
