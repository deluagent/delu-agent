# delu — autonomous agent with skin in the game

> **Winner of The Synthesis Hackathon** (March 13–22, 2026)  
> Built by delu (AI) + Tomu (human)

**delu** is an autonomous onchain trading agent that manages its own treasury on Base. Unlike simulation bots or paper-trading demos, delu operates with **real capital, real execution, and real consequences**.

When the market regime is BEAR (as it was during this hackathon), delu doesn't force trades to look busy. It detects the regime, preserves capital, and moves to Aave to earn yield. That discipline — knowing when *not* to trade — is the true alpha.

## The Problem

Most "autonomous" agents are either:
1. **Simulations** — running on testnet with monopoly money, where mistakes don't matter.
2. **Reckless** — simple scripts that trade every signal regardless of market conditions, bleeding capital in chop.
3. **Black boxes** — opaque logic with no audit trail of *why* a decision was made.

## The Solution: Skin in the Game

delu is built different:
- **Real Money**: Operates a live wallet on Base mainnet. Every decision is a transaction.
- **Private Cognition**: Uses **Venice AI** with end-to-end encryption (E2EE) to reason about trades. The strategy is private; the execution is public.
- **Regime Awareness**: A walk-forward validated quant framework (GARCH, OU processes, 5-state regime) gates every trade. If the regime is BEAR, the agent refuses to gamble.
- **Self-Improving**: Runs a parallel "autoresearch" loop (Karpathy-style) where Venice mutates the scoring function, backtests it, and deploys it if Sharpe improves. 800+ experiments run autonomously.

## Architecture: The 3-Layer Pipeline

Every 30 minutes, delu runs a consensus pipeline:

1. **Screen (Bankr LLM)**: Fast, cheap model (`gemini-2.5-flash`) scans 7 tokens + regime. "Is anything worth analyzing?"
   - If **BEAR**: Activates **Smart Yield Mode**. Asks Bankr to scan Aave, Morpho, and Moonwell for the best stablecoin APY. If a better pool exists (>1% spread), it autonomously rebalances the treasury.
   - If **BULL/RANGE**: Shortlists interesting tokens for Venice.

2. **Reason (Venice E2EE)**: If interesting, send context to Venice (`llama-3.3-70b` on private GPU). Reason about risk, sizing, and conflicts. Output allocation JSON.
3. **Execute (Bankr API)**: If confidence ≥ 65%, execute trade on Base.

## Tracks & Tech Stack

- **Autonomous Trading Agent**: Walk-forward validated strategies (Sharpe 1.69 OOS), live execution on Base.
- **Best Bankr LLM Gateway**: Uses `llm.bankr.bot` for screening + self-sustaining yield-to-inference funding loop.
- **Private Agents (Venice)**: E2EE inference for all allocation decisions.
- **Let the Agent Cook**: Full decision loop (fetch → detect → score → reason → execute → research) without human intervention.
- **ERC-8004**: Identity #30004 is the agent's load-bearing operational wallet.

## Live Evidence

- **Identity**: [ERC-8004 #30004](https://basescan.org/tx/0x559863575b6b1c8c4e9a6976bf2ee7061300eb16b4ef52772238e44c3588eeea)
- **Agent Wallet**: `0xed2ceca9de162c4f2337d7c1ab44ee9c427709da`
- **Repo**: https://github.com/deluagent/delu-agent
