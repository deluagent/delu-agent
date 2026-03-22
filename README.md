# delu — Autonomous Onchain Trading Agent

> Real capital. Real execution. Real consequences.

delu is an autonomous trading agent that manages a live treasury on Base mainnet. It runs every 30 minutes, discovers trending tokens, scores them with an evolving quant model, reasons privately via Venice, and executes trades via Bankr — all without human intervention.

**Live demo:** https://delu-site.vercel.app  
**Wallet:** [0xed2ceca9de162c4f2337d7c1ab44ee9c427709da](https://basescan.org/address/0xed2ceca9de162c4f2337d7c1ab44ee9c427709da)  
**ERC-8004 identity:** Agent #30004 on Base

---

## How It Works

Every 30 minutes:

```
Step 1: Bankr LLM     → regime (BTC/ETH/breadth) + trending token list (Base top 10)
                                 ↓
Step 2: [PARALLEL]
         Checkr x402  → 4-window attention (1h/4h/8h/12h) + spikes + rotation
         Alchemy       → per-token: hourly prices, transfer stats, rug check
         GeckoTerminal → DEX buy/sell flows
                                 ↓
Step 3: Rug filter    → drop tokens with: low liquidity, bot wallets, dev dumps, whale concentration
                                 ↓
Step 4: Quant scoring → evolved model (auto-improved by autoresearch loops)
                                 ↓
Step 5: Venice        → private E2EE reasoning over all signals (llama-3.3-70b)
                                 ↓
Step 6: Bankr         → execute swap + set ATR trailing stop
```

Checkr and Alchemy run in parallel (not sequentially) after Bankr provides the token universe.

---

## Key Features

### Rug Detection (before every trade)
- Liquidity gate: $200k minimum for tokens < 24h old
- Bot ratio check: tx count / unique wallets (> 10x = wash trading)
- Dev wallet dump detection via `alchemy_getAssetTransfers`
- Whale concentration scoring (single wallet > 20% of buys)
- Age penalty for pools < 1h old

### Multi-Window Social Attention (Checkr)
Using the [Checkr skill](https://clawhub.com) via x402 micropayments — no API key, no subscription. Called in parallel with 4 time windows:
- 1h leaderboard (fastest growers) — weight 40%
- 4h leaderboard (building momentum) — weight 30%
- 8h leaderboard (sustained) — weight 20%
- 12h leaderboard (trend confirmation) — weight 10%
- Plus: spike detection (min_mentions ≥ 3) and creator rotation graph

`sustainedMomentum` = token positive in 3+ windows = real trend, not flash pump.

### ATR Trailing Stops
- Stop = peak − 2.5 × ATR(14) from 1h bars
- Activates at +1% gain
- Hard floor at entry − 3%
- Falls back to 5% fixed trail if ATR unavailable

### Self-Improving Brain (Autoresearch)
3 parallel loops run 24/7:
- **Onchain loop**: 20 Base tokens × 720 1h bars (Alchemy)
- **Hourly loop**: 50 tokens × 4320 1h bars  
- **5m loop**: 26 tokens × 8640 5m bars

Each loop: LLM proposes a change to the scoring function → backtest on holdout data → accept only if val Sharpe improves → auto-promote to live agent brain.

LLM calls use **Bankr LLM Gateway** (claude-haiku-4-5) with Anthropic fallback.

---

## Stack

| Component | Tool |
|-----------|------|
| Execution | Bankr API |
| Reasoning | Venice llama-3.3-70b (private, E2EE) |
| Social signals | Checkr via x402 micropayments |
| Onchain data | Alchemy Prices API + getAssetTransfers |
| DEX data | GeckoTerminal |
| LLM research | Bankr LLM Gateway |
| Agent harness | OpenClaw |
| Dashboard | Next.js + Vercel |

---

## Project Structure

```
agent/
  index.js          — main 30min loop
  bankr.js          — Bankr API wrapper (execution + prices)
  bankr_market.js   — Bankr trending + LLM gateway
  checkr.js         — Checkr x402 social attention
  flows.js          — GeckoTerminal DEX flows
  onchain_ohlcv.js  — Alchemy price history + transfer stats
  rug_check.js      — rug pull detection (liquidity, bots, whales, dev dumps)
  quant_score.js    — evolved scoring function (updated by autoresearch)
  position_monitor.js — ATR trailing stop management
  publish_status.js — pushes status.json to delu-site after each cycle
  trending_entry.js — onchain entry signal for Base trending tokens
  journal.js        — position tracking + trade log
  kelly.js          — Kelly position sizing
  discover.js       — token auto-discovery

autoresearch/
  loop_onchain.js   — self-improving loop on real Base token data
  loop_hourly.js    — self-improving loop on 1h Binance data
  loop_5m.js        — self-improving loop on 5m data
  candidate_onchain.js — current best scoring function (Base tokens)
  evaluate_onchain.js  — backtester for Base token scoring

data/
  positions.json    — open positions + stop levels
  trade_journal.jsonl — full trade history
  cycle_summary.md  — human-readable cycle log
```

---

## Safety

- Testnet: not used — always mainnet
- Max position size: Kelly-sized, capped at tranche %
- Reserve: 25% of active tranche always kept liquid
- Hard stop-loss: −3% before trailing activates
- Time stop: 72h max hold
- Rug check: required before every new entry

---

## Built at The Synthesis Hackathon

March 13–22, 2026. Project #30004.

Tracks: Bankr LLM Gateway · Autonomous Trading Agent (Base) · Let the Agent Cook · ERC-8004 · Synthesis Open Track
