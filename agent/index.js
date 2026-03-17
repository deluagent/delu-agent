#!/usr/bin/env node
/**
 * delu agent loop
 * Runs every 4 hours: sense → reason → execute → log
 *
 * Usage:
 *   node agent/index.js          # single run
 *   node agent/index.js --loop   # continuous (every 4h)
 *   node agent/index.js --dry    # dry run (no execution)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const venice = require('./venice');
const bankr  = require('./bankr');
const signals = require('./signals');
const log    = require('./log');
const { STATES, transition, getState, checkCircuitBreaker } = require('./state');
const { kellySize, correlationAdjust, calibrateFromLog } = require('./kelly');

const DRY_RUN = process.argv.includes('--dry');
const LOOP    = process.argv.includes('--loop');
const CYCLE_MS = 4 * 60 * 60 * 1000; // 4 hours

const ACTIVE_TRANCHE_USD = 20; // USD available for active strategies

async function runCycle() {
  console.log('\n═══════════════════════════════════════');
  console.log(`[delu] Cycle start: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════\n');

  // 0. Circuit breaker check
  const breaker = checkCircuitBreaker(ACTIVE_TRANCHE_USD);
  if (breaker.halted) {
    console.error('[delu] CIRCUIT BREAKER ACTIVE:', breaker.reason);
    console.error('[delu] Skipping cycle. Fix the issue, then call resetCircuitBreaker()');
    return;
  }

  const agentState = getState();
  console.log(`[state] Current state: ${agentState.current} | Session P&L: $${agentState.session_pnl.toFixed(2)}`);

  // 1. Gather signals
  let market;
  try {
    market = await signals.gatherSignals(ACTIVE_TRANCHE_USD, log.getRecent().filter(e => !e.outcome).length);
    console.log(`[signals] ETH=$${market.eth_price} BTC=$${market.btc_price}`);
    console.log(`[signals] Attention signals: ${market.attention.length}`);
    console.log(`[signals] Polymarket markets: ${market.polymarket.length}`);
  } catch (e) {
    console.error('[signals] Failed to gather:', e.message);
    return;
  }

  // 2. Reason with Venice (TEE)
  let decision;
  try {
    console.log('\n[venice] Reasoning...');
    decision = await venice.reason(market);
    console.log(`[venice] Decision: ${decision.action} ${decision.asset} @ ${decision.confidence}% confidence`);
    console.log(`[venice] Reasoning: ${decision.reasoning}`);
    console.log(`[venice] TEE proof: ${decision.tee_quote ? '✓' : '✗ (no TEE quote)'}`);
  } catch (e) {
    console.error('[venice] Reasoning failed:', e.message);
    // If Venice is down, default to yield
    decision = {
      action: 'yield',
      asset: 'USDC',
      size_pct: 100,
      confidence: 50,
      reasoning: 'Venice unavailable — defaulting to yield',
      tee_quote: null
    };
  }

  // 3. Skip if low confidence or hold
  if (decision.confidence < 65 || decision.action === 'hold') {
    console.log(`[delu] Skipping — confidence ${decision.confidence}% < 65% or hold`);
    if (agentState.current === STATES.SCANNING) {
      // stay scanning
    } else {
      transition(agentState.current, STATES.SCANNING, 'low confidence, returning to scan');
    }
    log.record(market, decision, { skipped: true, reason: `confidence ${decision.confidence}%` });
    return;
  }

  // Kelly sizing
  const kellyResult = kellySize(decision.confidence, ACTIVE_TRANCHE_USD);
  const corrResult = correlationAdjust([], decision.asset, kellyResult.sizeUsd);
  const finalSizeUsd = corrResult.adjustedSize;

  console.log(`[kelly] Size: $${finalSizeUsd} (${kellyResult.sizePct}% Kelly, ${corrResult.adjustment}x corr)`);

  // State machine: SCANNING → SIGNAL_DETECTED → CONFIRMING → ENTERING
  if (agentState.current === STATES.SCANNING) {
    transition(STATES.SCANNING, STATES.SIGNAL_DETECTED, `${decision.asset} @ ${decision.confidence}%`);
    transition(STATES.SIGNAL_DETECTED, STATES.CONFIRMING, 'Venice confirms signal');
    transition(STATES.CONFIRMING, STATES.ENTERING, `size $${finalSizeUsd}`);
  }

  // 4. Execute via Bankr
  let execution;
  if (DRY_RUN) {
    console.log(`[delu] DRY RUN — would execute: "${decision.action} ${decision.asset}" for $${finalSizeUsd}`);
    execution = { dry_run: true, would_execute: decision.action, size_usd: finalSizeUsd };
  } else {
    try {
      console.log('\n[bankr] Executing...');
      execution = await bankr.execute(decision, ACTIVE_TRANCHE_USD);
      console.log(`[bankr] Done: ${execution.response || JSON.stringify(execution)}`);
    } catch (e) {
      console.error('[bankr] Execution failed:', e.message);
      execution = { error: e.message };
    }
  }

  // 5. Log
  const entry = log.record(market, decision, execution);
  const s = log.stats();
  console.log(`\n[delu] Allocation #${entry.id} recorded`);
  console.log(`[delu] Track record: ${s.correct}/${s.resolved} correct (${s.accuracy}%) | ${s.total} total decisions\n`);
}

async function main() {
  console.log('delu agent starting...');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | ${LOOP ? 'LOOP (4h)' : 'SINGLE RUN'}`);

  // Verify keys
  if (!process.env.BANKR_API_KEY) { console.error('Missing BANKR_API_KEY'); process.exit(1); }
  if (!process.env.VENICE_API_KEY) { console.error('Missing VENICE_API_KEY'); process.exit(1); }

  await runCycle();

  if (LOOP) {
    console.log(`[delu] Next cycle in 4 hours`);
    setInterval(runCycle, CYCLE_MS);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
