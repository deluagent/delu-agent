# Hourly Signal Research — Long/Short Strategy

## Context
- 50 tokens, 180 days of 1h bars (4320 bars total)
- Rebalance every 4h
- ALL periods = BEAR (Sep 2025 → Mar 2026)
- Score range: [-1, +1] — positive = long, negative = short
- Top 3 long + bottom 2 short each cycle
- Metric: 0.5*val_sharpe + 0.5*aud_sharpe (equal weight — both bear periods)

## Current baseline
- val_sharpe=2.501 (Jan→Feb crash), aud_sharpe=-0.681 (Feb→Mar recovery)
- combined=0.910
- Signal: 7d rel strength vs BTC (50%) + 4h rel strength (30%) + volume direction (20%)

## Key insight
- AUD period (Feb→Mar) = partial BTC recovery ($67k→$71k)
- Best signal for this period: tokens with momentum + volume confirmation
- Short candidates: weakest relative performers with volume on the downside

## Hypotheses to try (in order of expected impact)

### H1: Shorter relative strength window for AUD
- 7d is too slow for Feb→Mar recovery (short, sharp moves)
- Try 24h and 48h relative strength as primary signal

### H2: OBV divergence from price
- OBV rising while price flat/down = accumulation = long signal
- OBV falling while price flat/up = distribution = short signal

### H3: Volume burst asymmetry
- Large vol + price up AND rel outperform BTC = strong long
- Large vol + price down AND rel underperform BTC = strong short

### H4: Mean reversion component
- After large 24h move in either direction, fade it slightly
- Works in bear: gap downs tend to recover partially

### H5: EMA acceleration
- Rate of change of EMA12 vs EMA48 gap
- Widening positively = bullish acceleration = long
- Narrowing from positive = losing steam = reduce position

### H6: Multi-window relative strength composite
- Average of rel strength at 4h, 24h, 7d windows
- Each normalised independently then combined

### H7: Regime-aware weighting
- IS period (deep bear): weight short signals more
- AUD period (partial recovery): weight long signals more
- Detect regime from BTC 48h return

### H8: Sector rotation
- Layer 1s (BTC, ETH) vs Layer 2s (ARB, OP, MATIC)
- During recovery, L2s tend to outperform L1s with lag

## Signals available
prices[], volumes[], highs[], lows[], opens[], btcPrices[]

## Hard constraints
- Score must be in [-1, +1]
- No redefined helpers (ema, sma, realizedVol, zScore)
- Min bars needed: 169 (7 days hourly)
- No lookahead bias

---

## Nunchi hypotheses (added March 21 — from 103-experiment Hyperliquid hourly study)
Source: github.com/Nunchi-trade/auto-researchtrading — Sharpe 2.7 → 20.6 on hourly perp data
**These are directly relevant — Nunchi's data is also hourly crypto**

### H-N1: RSI period 8 ⭐ HIGHEST PRIORITY — their single biggest gain (+5.0 Sharpe)
- "Standard 14-period RSI is too slow for hourly crypto"
- RSI 8 is much more responsive — catches intraday momentum shifts faster
- Test: replace any RSI 14 component with RSI 8
- Also test: RSI(8) > 55 as long signal, RSI(8) < 45 as short signal
- Combined: use (rsi8 - 50) / 50 as a continuous score component [-1, +1]

### H-N2: Bollinger Band width percentile as compression signal (+0.9 Sharpe)
- bbWidth = (upper20 - lower20) / middle20
- bbWidthPct = percentile of bbWidth over last 168 bars (1 week)
- BB compression (bbWidthPct < 20) = coiling before breakout
- Direction from price vs middle band: above = long, below = short
- Test: if bbWidthPct < 25 → signal = 0.4 × sign(close - middleBand)

### H-N3: Remove multi-timeframe confirmation penalty (+0.8 Sharpe from simplification)
- Our hourly scoring may penalise cross-timeframe divergence
- Test: pure single-timeframe signal — just 1h bars, no 4h cross-check
- Simpler is often better once you have enough experiments proving it

### H-N4: ATR trailing multiplier — use 5.5× for stop/hold logic
- Holds winners much longer (1.5× too tight, cuts too early)
- In scoring context: if close > ema20 - 5.5×atr, stay long (don't flip)
- Test: add persistence bonus — if scored > 0.3 last bar AND within 5.5×ATR of high → maintain signal

### H-N5: Ensemble voting (their key architecture breakthrough, +5.6 Sharpe at exp15)
- Instead of weighted sum, use majority vote across signals
- 5 signals vote: RSI8, OBV direction, rel strength vs BTC, BB position, vol burst
- If 3/5 agree → trade at that strength; if 2/5 or less → 0
- Vote strength: count agreements, normalize to [-1, +1]

### Priority: H-N1 (RSI-8) → H-N5 (ensemble vote) → H-N2 (BB width) → H-N3 (no MTF) → H-N4 (ATR hold)
### Key difference from daily: hourly data has more noise — RSI-8 and ensemble voting address this directly
