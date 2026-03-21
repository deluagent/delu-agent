# Autoresearch Program — Daily Signals

## Current state (exp 597)
Best: val=3.888, aud=1.858, combined=3.280 (metric: 0.7*val + 0.3*aud)

## Deep analysis findings (March 21)

### Why val=3.888 is hard to beat
- VAL period (Jun-Oct 2025): ALT BULL — RNDR +315%, ETH +52%, BNB +68%
- The signal correctly picks RNDR 70/146 days, ETH 50 days
- It fires selectively — 48% win rate means it DOESN'T trade on weak days
- Returns 0 for most tokens (strict filtering) = concentrated winners

### Why AUD=1.858 is acceptable, not broken
- AUD period (Oct-Mar 2026): BEAR — BTC -38%
- Signal goes almost FLAT (6% win rate = trades almost nothing)
- Returns +45.5% total in BEAR by avoiding losers
- The real AUD winners (OCEAN +47%) had no predictive signal visible at entry
- Going flat in BEAR IS the strategy — no forced trades

### What would actually improve AUD
NOT: changing signal weights (exhausted 100+ experiments)
NOT: adding relative strength (OCEAN's outperformance wasn't predictable)
NOT: hard regime gates (already essentially flat)

YES: **Add tokens that have visible momentum in BEAR**
- Need tokens that actually trend UP in BEAR (parabolic memes, new narratives)
- Current universe misses whatever was going up Oct25-Mar26
- This requires DATA, not signal tweaking

YES: **Improve VAL slightly** — val=3.888 has room to 4.5+
- RNDR: could hold longer (exits too early on corrections)
- Find other tokens with RNDR-like behavior in VAL period

### What to try next (concrete)
1. **Holding period extension**: current rebalance=1d (daily). Try scoring with
   5d or 7d lookahead — hold winners longer, fewer whipsaws
   → Change REBAL in evaluate.js? NO — evaluate.js is fixed
   → Instead: add momentum persistence signal — if scored >0.3 yesterday, boost today

2. **RNDR-pattern detection**: what made RNDR special?
   - 185% in IS, 315% in VAL — sustained multi-month trend
   - Low vol, high OBV z-score, outperforms BTC consistently
   - Signal: 90d return z-score vs universe (relative 3-month strength)

3. **Escape velocity signal**: tokens breaking out of 6-month consolidation
   - Price crosses above 180d SMA for first time in 60 days = strong buy
   - Works for RNDR in VAL: was flat Jun-Jul 2025, then launched

4. **Val sub-period analysis**: which 30d windows drove val=3.888?
   - If most Sharpe from Aug-Sep 2025, need signals that fire then
   - RNDR +200% Aug-Sep 2025 specifically

## Constraints
- score in [0, 1] (long only, daily evaluator has no shorts)
- Don't redefine existing helpers (sma, ema, pct, zScore, etc.)
- Return 0 for weak/no-signal (concentration > diversification)
- evaluate.js: FIXED, don't modify
- ONE change per experiment, targeted at val improvement

## Target
val > 4.2, aud > 2.0 (combined > 3.54)

---

## Nunchi hypotheses (added March 21, from 103-experiment Hyperliquid study)
Source: github.com/Nunchi-trade/auto-researchtrading — Sharpe 2.7 → 20.6 over 103 experiments

### H1: RSI period 8 instead of 14 ⭐ HIGH PRIORITY
- Their single biggest gain: +5.0 Sharpe
- "Standard 14-period RSI is too slow for hourly crypto"
- We use RSI in several candidate variants — try both `rsi(closes, 8)` and combined rsi8+rsi14 signal
- Test: replace RSI 14 with RSI 8 in momentum component; also try rsi(8) < 40 as entry gate

### H2: ATR trailing multiplier 5.5× not 1.5× 
- They found ATR 5.5× (up from 3.5×) gained +1.0 Sharpe — holds winners much longer
- Our stops.js uses 1.5× ATR which may be cutting winners early
- In the scoring context: use ATR as a hold-signal (if price > ema - 5.5×ATR, still valid)
- Test: if current price is within 5.5× ATR of recent high, keep bullish signal active

### H3: Remove multi-timeframe confirmation gate
- They found "+0.8 Sharpe from simplifying momentum — removing multi-timeframe confirmation"
- We apply a 40% score penalty when 1h and 4h trends diverge
- Test: remove the MTF penalty entirely from scoreToken — let the primary signal run

### H4: Bollinger Band width percentile as extra signal
- BB width compression before breakout: added +0.9 Sharpe as 6th ensemble signal
- BB width = (upper - lower) / middle band
- Test: add bb_width_pct = percentile of bb_width over last 60 days
  - If bb_width_pct < 20 (compression): boost score by 0.05-0.10 (coiling before move)
  - If bb_width_pct > 80 (expansion already in progress): slight boost too

### H5: Uniform position sizing (remove score-weighting)
- "+1.7 Sharpe from uniform sizing vs momentum-weighted sizing"
- Our signal feeds into Kelly sizing — conviction-weighted
- In the evaluator context: try equal-weight the top 5 picks (ignore score magnitude for sizing)
- Note: this is evaluate.js territory — CAN'T change evaluate.js
- Instead: test if a flatter score distribution (scores compressed toward 0.5) performs better

### Priority order: H1 (RSI-8) → H3 (remove MTF gate) → H4 (BB width) → H2 (ATR) → H5
### Context: their universe = BTC/ETH/SOL perps. Ours = 55 tokens, daily, long-only
### Don't blindly copy — run on our data, trust the evaluator
