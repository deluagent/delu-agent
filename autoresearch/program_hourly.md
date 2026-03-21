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
