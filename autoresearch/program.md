# Autoresearch Program — Daily Signals

## Current state (as of exp 555)
- Best: val=3.888, aud=1.858, combined=3.280
- IS period:  Mar 2024 – Jun 2025 (BULL, BTC $40k→$111k)  
- VAL period: Jun 2025 – Oct 2025 (BULL, BTC $65k→$111k) ← primary metric
- AUD period: Oct 2025 – Mar 2026 (BEAR, BTC $111k→$70k) ← secondary metric

## Observation: we are at a local optimum on VAL
Val=3.888 is strong. The LLM has been tweaking signal weights for 100+ experiments with no improvement.

## New focus: IMPROVE AUD (currently 1.858)

The audit period is BEAR — BTC fell from $111k to $70k.
A signal that works in AUD must:
1. Identify tokens that hold up better than BTC in a downtrend (relative strength)
2. Reduce position sizing or go flat when market-wide momentum is negative
3. NOT require a hard zero in BEAR — that kills selectivity

## Top tokens driving VAL returns:
- RNDR: +79.5% (70 selections, core holding)
- ETH: +38.1% (50 selections)
- MKR: +34.2% (12 selections, high avg ret)
- IMX: +27.1% (6 selections, very high avg ret)
- HBAR: +22.3% (1 selection — lucky?)

## Hypotheses to improve AUD (BEAR robustness)

### H1: Add a drawdown dampener
- If token is down >15% from its 90d high → reduce score by 50%
- Avoids holding fallen knives in BEAR
- Should help AUD without hurting VAL

### H2: Relative strength vs BTC as primary AUD signal
- In BEAR, tokens outperforming BTC are the winners
- Add: `relBTC = (r20_token - r20_btc) * weight`
- Boost tokens beating BTC, penalise those losing to BTC

### H3: Sector rotation signal
- In BEAR: AI/DePIN sector (RNDR, FET, AGIX, OCEAN) tends to hold up better
- Already in universe — add sector momentum: avg of AI-token recent returns
- If AI sector momentum positive → boost all AI tokens

### H4: Volatility-adjusted momentum
- In BEAR, high-vol tokens bleed more
- Divide momentum by recent realised vol
- Sharpe-ratio-style signal: ret/vol as score component

### H5: Time-weighted momentum (recent > old)
- Standard equal-weight r7/r20/r60 doesn't decay
- Try: exponential decay so last 3 days matter 3x more than day 10-20
- Should help AUD where moves are sharper and shorter

### H6: Bear-specific mean reversion
- Oversold bounces exist in BEAR (RSI<30 → short-term rally)
- Add: if r7 < -20% → mean reversion score boost of 0.1
- Gate: only when BTC itself is not crashing (BTC r3 > -5%)

## Hard constraints
- NEVER zero out entire score based on BTC regime — causes phantom Sharpe
- MIN_SCORE=0.05 already filters weak tokens
- Keep scoreToken returning [0, 1] (not negative — no shorts in daily evaluator)
- Don't redefine existing helpers
- ONE change per experiment — isolate what works

## What has been tried and failed (do not repeat)
- Hard BEAR gate (regimeMult=0.05) — kills all VAL/AUD discriminating power
- Adding funding rate as primary signal — doesn't move the needle
- Changing momentum weights slightly (r7/r20/r60 ratios) — exhausted
- GARCH vol regime — too complex, overfits IS
- Trend gate |emaGap|<0.03 — zeros too many tokens

## Target
val > 4.0 AND aud > 2.5 (combined > 3.55)
