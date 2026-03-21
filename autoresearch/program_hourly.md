# Hourly Signal Research Program

## Context
- 50 tokens, 180 days of 1h bars (4320 bars)
- Rebalance every 4h, hold top 5
- Val period = BEAR (Q1 2026), Aud = BEAR continuation
- Target: val_sharpe > 4.0, combined > 3.5

## What makes hourly different from daily
1. Volume bursts are detectable (4h spike vs 24h avg)
2. Momentum acceleration is measurable (rate of change)
3. Range compression / coiling is visible before breakout
4. Mean reversion works at short horizons (1-4h oversold)
5. BTC correlation moves are fast (4h window matters)

## Hypotheses to test (in order of expected impact)

### H1: Volume burst + direction alignment
- volRatio > 2.0 AND ret4h > 0 → strong signal
- volRatio < 0.5 AND ret4h < 0 → capitulation → fade?

### H2: Momentum acceleration gate
- Only trade when 4h momentum is accelerating (vs 8h ago)
- Filters out decelerating moves about to reverse

### H3: Range compression breakout
- ATR(4h)/ATR(24h) < 0.3 → coiling
- Price in top 80% of 24h range → bullish setup
- Weight this signal heavily

### H4: Multi-horizon EMA alignment
- EMA12 > EMA48 > EMA168 all aligned up = strongest setup
- Score proportional to alignment count (0, 1, 2, 3 aligned)

### H5: OBV slope (rolling 12h vs 24h)
- OBV rising faster than price = accumulation
- Compare OBV 12h slope vs 24h slope

### H6: BTC beta adjustment
- High-beta tokens (DOGE, SHIB, PEPE) get reduced score in BEAR
- Low-beta (LINK, AAVE) get slight boost

### H7: Mean reversion at oversold hourly RSI
- RSI(14, 1h) < 30 → potential bounce
- Only in context of longer-term uptrend (EMA48 > EMA168)

### H8: Liquidity-weighted momentum
- Volume × price_change as "momentum intensity"
- Normalise cross-sectionally

### H9: Gap detection
- Large candle (body > 2× avg body) → momentum confirmation
- Price gap up from prior close → buy signal

### H10: Intraday volatility regime
- Low vol (ATR < median ATR) → trending conditions → momentum
- High vol → mean reversion works better → switch strategy

## Signals available
prices[], volumes[], highs[], lows[], opens[], btcPrices[]
flowSignal (0 in eval), attentionDelta (0 in eval)

## Constraints
- No lookahead (only use data up to current bar)
- No redefined helpers (ema, sma, realizedVol, zScore)
- Score must be in [0, 1] range
- Min bars needed: 48 (2 days hourly)
