#!/bin/bash
# Overnight test chain — runs in sequence, logs each
# Usage: bash backtest/run_night.sh

cd /data/workspace/delu-agent

echo "=== NIGHT RUN START: $(date) ==="

# Wait for adaptive3 if still running
while kill -0 2086279 2>/dev/null; do
  echo "  Waiting for adaptive3 (PID 2086279)..."
  sleep 30
done

echo ""
echo "=== [1/3] token_regime.js — per-token micro-regime filter ==="
echo "Start: $(date)"
node backtest/token_regime.js > /tmp/token_regime.log 2>&1
echo "Done: $(date) | exit $?"

echo ""
echo "=== [2/3] bear_short.js — short strategy in BEAR regime ==="
echo "Start: $(date)"
node backtest/bear_short.js > /tmp/bear_short.log 2>&1
echo "Done: $(date) | exit $?"

echo ""
echo "=== [3/3] adaptive.js — final re-run with all fixes ==="
echo "Start: $(date)"
node backtest/adaptive.js > /tmp/adaptive_final.log 2>&1
echo "Done: $(date) | exit $?"

echo ""
echo "=== NIGHT RUN COMPLETE: $(date) ==="
echo ""
echo "=== SUMMARY ==="
echo "--- token_regime ---"
grep "BEST:\|OOS:\|IS:" /tmp/token_regime.log | tail -5
echo "--- bear_short ---"
grep "BEST:\|OOS:\|IS:\|By strategy" /tmp/bear_short.log | tail -8
echo "--- adaptive_final ---"
grep "BEST CONFIG\|Single-pass OOS\|Walk-forward" /tmp/adaptive_final.log | tail -5
