# delu — Autonomous Onchain Trading Agent

> Real capital. Real execution. Real consequences.

**delu** is an autonomous trading agent that manages a live treasury on Base. It runs every 30 minutes, discovers trending tokens, scores them with an evolving quant model, reasons privately via Venice AI, and executes trades via Bankr — with no human intervention.

**Live dashboard:** [deluagent.vercel.app](https://deluagent.vercel.app)  
**Wallet:** [0xed2ceca9de162c4f2337d7c1ab44ee9c427709da](https://basescan.org/address/0xed2ceca9de162c4f2337d7c1ab44ee9c427709da)  
**ERC-8004 agent identity:** [#30004 on Base](https://basescan.org/address/0xed2ceca9de162c4f2337d7c1ab44ee9c427709da)

---

## What makes delu different

Most "autonomous" agents are simulations — testnet deployments with monopoly money where mistakes don't matter. delu is different:

- **Real capital** — live wallet, real USDC, real execution on Base mainnet
- **Self-improving** — 5 parallel autoresearch loops run 24/7, evolving the scoring model against real price data
- **Self-funding** — earns from its own trades to pay for AI compute via Bankr LLM Gateway
- **Auditable** — every decision, every trade, every stop-loss is logged and visible on the dashboard

---

## How it works

Every 30 minutes:

```
Bankr LLM → market regime (BTC/ETH trend + breadth) + Base trending tokens
      ↓
Parallel enrichment:
  Checkr (x402)   → 4-window social attention score (1h/4h/8h/12h)
  Alchemy         → hourly prices, transfer stats, whale/bot detection
  GeckoTerminal   → DEX liquidity, buy/sell flows
      ↓
Rug filter        → drop low-liquidity, bot-washed, dev-dumped tokens
      ↓
Quant scoring     → evolved model (9,000+ experiments, 33 breakthroughs)
      ↓
Venice AI         → private E2EE reasoning over all signals (llama-3.3-70b)
      ↓
Bankr             → execute swap + set ATR trailing stop
```

---

## Key components

### Rug detection
Before every entry, 4 checks run automatically:
- **Liquidity gate** — $200k minimum for tokens < 24h old
- **Bot ratio** — tx count / unique wallets > 10x = likely wash trading → skip
- **Dev dump detection** — flags large outgoing transfers from deployer wallets via Alchemy
- **Whale concentration** — single wallet > 20% of buy volume → skip

### Multi-window social attention (Checkr via x402)
Checkr is called via [x402 micropayments](https://x402.org) — no API key, no subscription, per-call payment from the agent wallet. Four time windows scored and weighted:
- 1h leaderboard (fastest growers) — 40%
- 4h leaderboard (building momentum) — 30%
- 8h leaderboard (sustained attention) — 20%
- 12h leaderboard (trend confirmation) — 10%

`sustainedMomentum` = positive in 3+ windows = genuine trend, not a flash pump.

### Private AI reasoning (Venice)
All final trade decisions go through [Venice AI](https://venice.ai) — private, E2EE inference. The model (llama-3.3-70b) reasons over the full signal stack and produces a buy/hold decision with written justification. This reasoning is shown on the dashboard but never leaves the E2EE context.

### ATR trailing stops
Stops are dynamic, not fixed:
- Stop = peak − 2.5 × ATR(14) from 1h bars
- Activates at +0.69% gain
- Hard floor at entry − 10% (min) to entry − 15% (max)
- Falls back to 5% fixed trail if ATR unavailable
- 72h time stop — no bag holding

### Self-improving brain (autoresearch)
5 parallel loops run 24/7, each proposing and testing mutations to the scoring function:

| Loop | Data | Experiments |
|------|------|-------------|
| Onchain | 20 Base tokens × 720 1h bars | 6,000+ |
| Hourly | 50 tokens × 4,320 1h bars | 650+ |
| 5m | 26 tokens × 8,640 5m bars | 1,900+ |
| Fusion | Blends all three loops | 1,800+ |
| Stops | ATR/trail parameter search | 1,300+ |

Each experiment: LLM proposes a code change → backtest on holdout data → accept if validation Sharpe improves → promote to live agent.  
All LLM calls use **Bankr LLM Gateway** (claude-haiku-4-5).

### Self-funding compute
The agent monitors its Bankr LLM credit balance every cycle. When credits fall below $5, it tops up $5 automatically from its USDC wallet. The trading profits fund the research compute. This is fully autonomous — no human needed to keep the loops running.

---

## Stack

| Component | Tool |
|-----------|------|
| Execution | [Bankr API](https://bankr.bot) |
| AI reasoning | [Venice AI](https://venice.ai) — llama-3.3-70b, private/E2EE |
| Social signals | [Checkr](https://checkr.social) via x402 micropayments |
| Onchain data | [Alchemy](https://alchemy.com) Prices API + getAssetTransfers |
| DEX data | [GeckoTerminal](https://geckoterminal.com) |
| LLM research | [Bankr LLM Gateway](https://docs.bankr.bot/llm-gateway/openclaw) |
| Agent identity | ERC-8004 (#30004 on Base) |
| Agent harness | [OpenClaw](https://openclaw.ai) |
| Dashboard | Next.js + Vercel |

---

## Project structure

```
agent/
  index.js            — main 30min loop
  bankr.js            — Bankr API: execution, prices, balances
  bankr_market.js     — Bankr trending tokens + LLM gateway
  checkr.js           — Checkr social attention via x402
  flows.js            — GeckoTerminal DEX buy/sell flows
  onchain_ohlcv.js    — Alchemy price history + transfer stats
  rug_check.js        — rug detection (liquidity, bots, whales, dev dumps)
  quant_score.js      — evolved scoring function (updated by autoresearch)
  multi_tf_score.js   — multi-timeframe signal fusion
  position_monitor.js — ATR trailing stop management + exit execution
  trending_entry.js   — onchain momentum signal for Base trending tokens
  discover.js         — token discovery pipeline
  kelly.js            — Kelly criterion position sizing
  journal.js          — position tracking + trade journal
  publish_status.js   — pushes live data to dashboard after each cycle
  publish_brain.js    — pushes autoresearch state to dashboard

autoresearch/
  loop_onchain.js     — self-improving loop on real Base onchain data
  loop_hourly.js      — self-improving loop on 1h Alchemy price data
  loop_5m.js          — self-improving loop on 5m data
  loop_fusion.js      — meta-loop: evolves weights across all signal types
  loop_stops.js       — optimises ATR stop parameters
  candidate_onchain.js   — current best onchain scoring function
  candidate_hourly.js    — current best hourly scoring function
  candidate_5m.js        — current best 5m scoring function
  evaluate.js            — backtester (Binance data)
  evaluate_onchain.js    — backtester (Base/Alchemy data)

scripts/
  watchdog.js         — monitors all loops, restarts if dead

data/
  positions.json      — open positions + ATR stop levels
  trade_journal.jsonl — full trade history with entry/exit details
  cycle_summary.md    — human-readable log of every cycle
```

---

## Running it

```bash
# Install
npm install

# Configure
cp .env.example .env
# Fill in: BANKR_API_KEY, ALCHEMY_KEY, VENICE_API_KEY, ANTHROPIC_API_KEY

# Run agent (30min cycles)
node agent/index.js --loop

# Run autoresearch loops
node autoresearch/loop_onchain.js
node autoresearch/loop_hourly.js
node autoresearch/loop_5m.js
node autoresearch/loop_fusion.js
node autoresearch/loop_stops.js

# Watchdog (keeps everything alive)
node scripts/watchdog.js
```

---

## Safety

- **Mainnet only** — not a testnet demo
- **Kelly sizing** — position size calibrated to win rate and edge
- **Reserve** — 25% of active tranche always kept liquid
- **Hard stop-loss** — ATR-based floor, min −10%, max −15%
- **Time stop** — 72h maximum hold per position
- **Rug check** — required before every new entry, no overrides
- **Re-entry block** — no re-entering a position already open

---

## Built at The Synthesis Hackathon

March 13–22, 2026.

**Tracks entered:**
- Bankr LLM Gateway
- Autonomous Trading Agent (Base)
- Venice Private Agents
- Let the Agent Cook
- ERC-8004 Agents With Receipts
- Synthesis Open Track
