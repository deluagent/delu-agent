# delu — Autonomous Onchain Trading Agent

> Real capital. Real execution. Real consequences.

**delu** is an autonomous trading agent that manages a live treasury on Base. It runs every 30 minutes, discovers trending tokens, scores them with a self-evolving quant brain, reasons privately via Venice AI, and executes trades via Bankr — with no human intervention.

**Live dashboard:** [deluagent.vercel.app](https://deluagent.vercel.app)  
**Wallet:** [0xed2ceca9de162c4f2337d7c1ab44ee9c427709da](https://basescan.org/address/0xed2ceca9de162c4f2337d7c1ab44ee9c427709da)  
**ERC-8004 agent identity:** [#30004 on Base](https://basescan.org/address/0xed2ceca9de162c4f2337d7c1ab44ee9c427709da)

---

## What makes delu different

Most "autonomous" agents are simulations — testnet deployments with monopoly money where mistakes don't matter. delu is different:

- **Real capital** — live wallet, real USDC, real execution on Base mainnet
- **Self-improving brain** — 5 parallel autoresearch loops run 24/7, evolving the scoring model through 9,000+ backtested experiments
- **Self-funding** — agent tops up its own AI compute credits from its trading wallet autonomously
- **Auditable** — every decision, every trade, every stop-loss is logged and visible on the dashboard

---

## The Brain — Self-Evolving Quant Model

The core of delu is a scoring function in `agent/quant_score.js` that runs on every candidate token. It's **not hand-written** — it was evolved by 9,000+ LLM-driven experiments across 5 parallel autoresearch loops.

Signals used (see `quant_score.js` for full implementation):
- **EMA/SMA trend filter** — 20-period SMA, price must be above for trend confirmation
- **Relative strength vs BTC** — 7d and 4h token return minus BTC return (alpha signal)
- **Realized volatility** — log-return vol over last N bars
- **OBV z-score** — on-balance volume momentum normalized across history
- **ATR** — Average True Range for stop placement and volatility context
- **Multi-timeframe fusion** — 5m + 1h + 4h + onchain signals blended by evolved weights per regime (BULL/BEAR/NEUTRAL)

The scoring function is auto-promoted from autoresearch when a new candidate beats the current best on holdout data. **The evolved variants and experiment logs are kept private** (proprietary IP) — but the live scoring logic is here in `quant_score.js`.

### Self-Improving Loops (autoresearch/)

5 parallel loops run 24/7:

| Loop | Data source | Experiments | Best score |
|------|-------------|-------------|------------|
| Onchain | 20 Base tokens × 720 1h bars (Alchemy) | 6,000+ | combined=20.4 |
| Hourly | 50 tokens × 4,320 1h bars (Binance) | 650+ | combined=11.0 |
| 5m | 26 tokens × 8,640 5m bars | 1,900+ | combined=28.0 |
| Fusion | Evolves signal blend weights per regime | 1,800+ | score=0.77 |
| Stops | Optimises ATR/trail parameters | 1,300+ | score=6.38, 57% WR |

Each experiment: Bankr LLM proposes a code mutation → backtest on holdout data → accept if `0.7 × val_Sharpe + 0.3 × audit_Sharpe` improves → auto-promote to live agent.

---

## How it works

Every 30 minutes:

```
Bankr LLM → market regime (BTC/ETH trend + breadth) + Base trending tokens
      ↓
Parallel enrichment:
  Checkr (x402)   → 4-window social attention (1h/4h/8h/12h) + spikes + rotation graph
  Alchemy         → hourly prices, transfer stats, whale/bot detection
  GeckoTerminal   → DEX liquidity, buy/sell flows
      ↓
Rug filter        → drop low-liquidity, bot-washed, dev-dumped tokens (rugScore < 60 = blocked)
      ↓
Bankr LLM         → pre-screen shortlist (regime-aware, with social/onchain context)
      ↓
Quant brain       → evolved scoring (quant_score.js) + multi-TF fusion
      ↓
Venice AI         → private E2EE reasoning over full signal stack (llama-3.3-70b)
      ↓
Bankr             → execute swap + set ATR trailing stop
```

---

## Key components

### Rug detection (`rug_check.js`)
Before every entry:
- **Liquidity gate** — $200k minimum for tokens < 24h old
- **Bot ratio** — tx count / unique wallets > 10x = wash trading → blocked
- **Dev dump detection** — flags large outgoing transfers from deployer wallets via Alchemy
- **Whale concentration** — single wallet > 20% of buy volume → blocked
- **Hard gate** — rugScore < 60 → token never reaches Venice, blocked before LLM call

### Multi-window social attention (`checkr.js`, via x402)
Six parallel calls per cycle — no API key, paid per-call from agent wallet:
- **4 leaderboard windows** — 1h (40%), 4h (30%), 8h (20%), 12h (10%)
- **Spikes** — velocity ≥ 2.0 + min_mentions ≥ 3 in last hour
- **Rotation graph** — directed attention flow; identifies tokens gaining attention from others

`sustainedMomentum` = positive in 3+ windows = genuine trend.  
`rotationGain` = net attention inflow = social conviction building.

### ATR trailing stops (`position_monitor.js`)
- Trail = peak − 2.7 × ATR(14) from 1h bars
- Activates at +0.69% gain
- Hard floor = entry − 2.4 × ATR (min −10%, max −14.98%)
- 72h time stop — no bag holding

### Self-funding compute
Agent checks Bankr LLM credit balance every cycle. When < $5, tops up $5 from USDC wallet automatically. Research never stops for lack of funds.

---

## Stack

| Component | Tool |
|-----------|------|
| Execution | [Bankr API](https://bankr.bot) |
| AI reasoning | [Venice AI](https://venice.ai) — llama-3.3-70b, private/E2EE |
| LLM research + screening | [Bankr LLM Gateway](https://docs.bankr.bot/llm-gateway/openclaw) — claude-haiku-4-5 |
| Social signals | [Checkr](https://checkr.social) via x402 micropayments |
| Onchain data | [Alchemy](https://alchemy.com) Prices API + getAssetTransfers |
| DEX data | [GeckoTerminal](https://geckoterminal.com) |
| Agent identity | ERC-8004 (#30004 on Base) |
| Agent harness | [OpenClaw](https://openclaw.ai) |
| Dashboard | Next.js + Vercel — [deluagent.vercel.app](https://deluagent.vercel.app) |

---

## Project structure

```
agent/
  index.js            — main 30min loop
  quant_score.js      — live scoring brain (auto-promoted by autoresearch)
  multi_tf_score.js   — multi-timeframe signal fusion (5m + 1h + 4h + onchain)
  bankr.js            — Bankr API: execution, prices, balances
  bankr_market.js     — Bankr trending tokens + LLM gateway
  checkr.js           — Checkr social attention via x402
  flows.js            — GeckoTerminal DEX buy/sell flows
  onchain_ohlcv.js    — Alchemy price history + transfer stats
  rug_check.js        — rug detection (liquidity, bots, whales, dev dumps)
  position_monitor.js — ATR trailing stop management + exit execution
  trending_entry.js   — onchain momentum signal for Base trending tokens
  discover.js         — Bankr + GeckoTerminal token discovery
  discover_alchemy.js — Alchemy-based discovery (transfer velocity, holder growth)
  kelly.js            — Half-Kelly position sizing (calibrates to live win rate)
  journal.js          — position tracking + trade journal
  publish_status.js   — pushes live data to dashboard after each cycle
  publish_brain.js    — pushes autoresearch state to dashboard

autoresearch/
  loop_onchain.js     — self-improving loop (Base onchain data)
  loop_hourly.js      — self-improving loop (1h Alchemy price data)
  loop_5m.js          — self-improving loop (5m data)
  loop_fusion.js      — meta-loop: evolves signal blend weights per regime
  loop_stops.js       — optimises ATR stop parameters
  evaluate.js         — backtester (Binance OHLCV)
  evaluate_onchain.js — backtester (Base/Alchemy data)
  state_*.json        — current best params per loop
  # evolved scoring functions + experiment logs kept private (proprietary)

backtest/
  — historical backtesting scripts and results

scripts/
  watchdog.js         — monitors all loops, auto-restarts if dead

data/
  positions.json      — open positions + ATR stop levels (live)
  trade_journal.jsonl — full trade history (verifiable on Basescan)
  cycle_summary.md    — human-readable log of every 30min cycle
```

---

## Running it

```bash
npm install
cp .env.example .env
# Fill in: BANKR_API_KEY, ALCHEMY_KEY, VENICE_API_KEY, ANTHROPIC_API_KEY

# Agent (30min cycles)
node agent/index.js --loop

# Autoresearch loops (run all in parallel)
node autoresearch/loop_onchain.js
node autoresearch/loop_hourly.js
node autoresearch/loop_5m.js
node autoresearch/loop_fusion.js
node autoresearch/loop_stops.js

# Watchdog
node scripts/watchdog.js
```

---

## Safety

- **Mainnet only** — not a testnet demo
- **Rug gate** — rugScore < 60 blocks token before any LLM call
- **Kelly sizing** — position size calibrated to live win rate and edge
- **Reserve** — 25% of active tranche always kept liquid
- **Hard stop-loss** — ATR-based, min −10%, max −14.98%
- **Time stop** — 72h maximum hold per position
- **Re-entry block** — no re-entering an already-open position

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
