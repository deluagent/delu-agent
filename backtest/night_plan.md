# Overnight Test Plan — March 18 2026

## Current: adaptive3 running
ALT_SEASON C hard-zeroed at score level. ETA ~25min.

## Queue (runs in sequence)

### Test 4: token_regime.js
Each token gets its OWN micro-regime (not just BTC global).
BTC/ETH global regime sets the base, but each token also checked:
- Token above/below its own 50d/200d MA
- Token's own vol ratio
- Token's correlation to BTC (low corr = more independent signal)
If token is in personal BEAR while global is BULL → skip that token.
If token is in personal BULL while global is RANGE → allow light entry.

### Test 5: bear_short.js  
In BEAR regime (BTC < 200d MA by >10%), take small SHORT positions.
Signal: BTC/ETH trend composite negative + vol spike (distribution, not accumulation)
Size: 5-8% (half normal), tight stop 1.2x ATR, TP 3x ATR
Expected: flip the 52% "flat" time into small positive returns.
Walk-forward validated same as adaptive.

### Test 6: multiframe.js
Add 4h and daily timeframe signals on top of 1h.
Daily trend confirms 1h entry → higher confidence → larger size.
1h entry but daily trend against → skip or halve size.
Should improve the 44% win rate and reduce stop-hit rate.

### Test 7: final_combine.js
Take best params from adaptive3 + token_regime + multiframe.
Single best config, run full 3-fold walk-forward.
This is the submission-ready backtest.

## Success criteria
- OOS Sharpe > 2.0 across all 3 folds
- Max DD < 8%
- All regimes profitable (no -6% ALT_SEASON bleed)
- IS Sharpe > 0 in all 3 folds
