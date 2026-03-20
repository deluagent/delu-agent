# delu — autonomous onchain trading agent

> **Live at The Synthesis hackathon** (March 13–22, 2026)  
> Built by delu (AI) + Tomu (human) on OpenClaw

---

## What it does

delu is an autonomous agent that makes and executes trading decisions on Base mainnet without human intervention.

Every 30 minutes:

1. **Fetch** — pulls Binance/GeckoTerminal hourly bars for 30+ tokens (Majors + Base ecosystem: BRETT, DEGEN, AERO, etc.)
2. **Detect regime** — 5-state market regime (BULL_HOT / BULL_COOL / RANGE_TIGHT / RANGE_WIDE / BEAR) using BTC 200d MA, market breadth, vol regime, ETH/BTC ratio
3. **Score tokens** — 4 signal templates (A/B/C/D) from a walk-forward validated quant framework
4. **Reason privately** — sends context to Venice AI (E2EE, private GPU) to allocate capital
5. **Execute** — Bankr API executes trades, deposits to Aave in bear markets
6. **Learn** — autoresearch loop runs every 90s in parallel, Venice continuously improves the scoring strategy via Karpathy-style autonomous research

The agent is not a script. It reasons about conflicting signals, adapts its weights based on rolling performance, and has a self-improving research loop running continuously.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  30-minute cycle                     │
│                                                      │
│  Binance API ──► Signal scoring (A/B/C/D)           │
│                       │                             │
│                       ▼                             │
│            Venice AI (E2EE, private)                │
│            llama-3.3-70b / qwen3                    │
│            → allocation decision                    │
│                       │                             │
│                       ▼                             │
│            Bankr API → execute on Base              │
│            (swap / deposit Aave / hold)             │
│                       │                             │
│                       ▼                             │
│            JSONL log → feedback loop                │
└──────────────────────────────────────────────────────┘

Parallel: autoresearch/loop.js (every 90s)
Venice improves candidate.js → loaded fresh next cycle
```

**Privacy:** All allocation decisions go through Venice with `enable_e2ee: true` — Venice-owned GPUs, zero retention, contract-enforced. Trading strategy and position sizing stay private.

**Execution:** Bankr handles onchain execution on Base mainnet. USDC deposits to Aave in BEAR regime (yield while waiting).

**Identity:** ERC-8004 agent identity #30004 registered on Base mainnet.

---

## Signal framework

Built from scratch with walk-forward validation. Not a GPT wrapper.

### Market regime (5 states)

| State | Condition | Action |
|---|---|---|
| BULL_HOT | BTC > 200d MA, high breadth, low vol | Full momentum (A+B) |
| BULL_COOL | BTC > 200d MA, high vol | Cautious + mean reversion |
| RANGE_TIGHT | Low vol, range-bound | Accumulation signals (B) |
| RANGE_WIDE | High vol, range-bound | Panic bounce (D) |
| BEAR | BTC < 200d MA or breadth < 30% | Yield only (Aave) |

### Signal templates

- **Template A** — Trend × (1 + vol_attention): momentum amplified by volume surprise
- **Template B** — Vol_flow × price_lag: OBV accumulation → price lead-lag
- **Template C** — Cross-sectional rank + vol_attention: relative strength
- **Template D** — Mean reversion (OU process): panic bounce capture

### Indicators

- GARCH(1,1) volatility: σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
- OU process (mean reversion speed): dz_t = κ(μ - z_t)dt + σdW_t  
- Trend composite: 0.5·r20d + 0.3·r60d + 0.2·r120d
- Volume z-score, Δ²volume (virality proxy)
- Market breadth gate (% tokens above 200d MA)
- ETH/BTC ratio signal (alt season detection)

---

## Backtest results

Walk-forward validated on 730 days of OHLCV data (3 folds, IS/OOS split).

**Best config (production):**

| Metric | Value |
|---|---|
| OOS return | +8.9% |
| OOS Sharpe | 1.69 |
| OOS max drawdown | 7.9% |
| WF worst-fold Sharpe | 1.69 |
| WF mean Sharpe | 2.70 |
| All 3 folds positive | ✓ |

**Benchmark (same OOS period):**
- BTC: -39%
- ETH: -45.5%
- Aave: +3%

**full_v2.js single-split:**
- OOS return: +8.7%, Sharpe 4.24, max DD 1.8%

Regime as of March 20: **BEAR** (BTC $71k, -23.7% below 200d MA, 0/7 tokens above MA) → agent depositing to Aave.

---

## Autoresearch

`autoresearch/loop.js` runs every 90 seconds in parallel with the main agent:

1. Takes `candidate.js` (the scoring function)
2. Asks Venice to suggest a mutation (parameter tweak, signal reweight, new feature)
3. Evaluates it on historical data using `evaluate.js`
4. If validation Sharpe improves → overwrites `candidate.js`
5. Agent loads `candidate.js` fresh next cycle → improvement flows in live

After 800+ experiments: `bestValSharpe` improved from 0 → 2.837 overnight.

---

## Stack

- **Chain:** Base mainnet
- **Execution:** Bankr API (trading, Aave deposits)
- **Reasoning:** Venice AI (E2EE private inference, `llama-3.3-70b`)
- **Agent harness:** OpenClaw
- **Identity:** ERC-8004 #30004 on Base
- **Data:** Binance API (OHLCV), DexScreener (flow signals)
- **Runtime:** Node.js

---

## Repo structure

```
agent/
  index.js          — main agent loop (30min cycle)
  venice.js         — Venice E2EE reasoning layer
  bankr.js          — Bankr execution layer
  signals.js        — signal computation
  alpha.js          — cross-sectional ranking + portfolio construction
  kelly.js          — Kelly criterion position sizing
  state.js          — regime detection
  flows.js          — DexScreener flow signals (buy/sell pressure)
  checkr.js         — Checkr x402 attention data

autoresearch/
  loop.js           — autonomous research loop (every 90s)
  candidate.js      — current best scoring function (Venice-improved)
  evaluate.js       — backtest evaluator for candidate scoring
  program.md        — research directives (human-steerable)
  state.json        — experiment count + best val_sharpe

backtest/
  adaptive.js       — 6-state adaptive framework, 2048-combo walk-forward grid
  full_v2.js        — full TRADING_BRAIN.md framework (GARCH, OU, all 4 templates)
  deep.js / deep_v2-v4.js — earlier iterations
  tune.js / tune_full.js  — hyperparameter tuning
  results/          — JSON results from all backtest runs

data/
  agent_log.jsonl   — live trade/decision log (gitignored — real wallet data)
```

---

## Running locally

```bash
cp .env.example .env
# fill in VENICE_API_KEY, BANKR_API_KEY, BANKR_THREAD_ID

npm install

# single run (dry)
node agent/index.js --dry

# live loop (30min cycle)
node agent/index.js --loop

# autoresearch (separate terminal)
node autoresearch/loop.js

# run backtests
node backtest/adaptive.js
node backtest/full_v2.js
```

---

## Onchain

- **ERC-8004 identity:** [#30004 on Base](https://basescan.org/tx/0x559863575b6b1c8c4e9a6976bf2ee7061300eb16b4ef52772238e44c3588eeea)
- **Agent wallet:** `0xed2ceca9de162c4f2337d7c1ab44ee9c427709da`
- **Aave position:** $3.98 USDC earning yield on Base (live, BEAR regime)

---

## Built at The Synthesis

March 13–22, 2026. Human + AI building as equals.

delu (the agent) designed the quant framework, ran the backtests, built the research loop, wired the integrations.  
Tomu (the human) set direction, reviewed results, approved mainnet deploys.
