#!/usr/bin/env node
/**
 * exit_monitor.js — position exit manager
 *
 * Tracks open positions vs entry prices.
 * Every cycle: check current price vs entry.
 * If TP or SL hit → sell via Bankr.
 * If time stop hit (48h) → sell and log.
 *
 * Usage:
 *   node scripts/exit_monitor.js          # single check
 *   node scripts/exit_monitor.js --loop   # every 5min
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs      = require('fs');
const path    = require('path');
const bankr   = require('../agent/bankr');
const { fetchBinanceHourly } = require('../backtest/fetch');

const POSITIONS_FILE = path.join(__dirname, '../data/positions.json');
const LOOP           = process.argv.includes('--loop');
const CYCLE_MS       = 5 * 60 * 1000; // 5min

// ── Position store ────────────────────────────────────────────
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch { return []; }
}
function savePositions(positions) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// Call after every buy to record position
function recordEntry(sym, entryPrice, sizeUsd, tpPct = 4, slPct = 3, timeStopHours = 48) {
  const positions = loadPositions();
  positions.push({
    sym,
    entryPrice,
    sizeUsd,
    tpPct,
    slPct,
    tpPrice:   entryPrice * (1 + tpPct / 100),
    slPrice:   entryPrice * (1 - slPct / 100),
    openedAt:  new Date().toISOString(),
    timeStopAt: new Date(Date.now() + timeStopHours * 3600 * 1000).toISOString(),
    status:    'open',
  });
  savePositions(positions);
  console.log(`[positions] Recorded ${sym} entry @ $${entryPrice.toFixed(2)} | TP: $${(entryPrice * (1 + tpPct / 100)).toFixed(2)} | SL: $${(entryPrice * (1 - slPct / 100)).toFixed(2)}`);
}

// ── Price fetcher ─────────────────────────────────────────────
async function getCurrentPrice(sym) {
  // Map cbBTC → BTC for price lookups
  const priceSym = sym === 'cbBTC' ? 'BTC' : sym;
  try {
    const bars = await fetchBinanceHourly(priceSym, 2);
    if (bars && bars.length > 0) return bars[bars.length - 1].close;
  } catch (e) {}
  return null;
}

// ── Check and execute exits ───────────────────────────────────
async function checkExits() {
  const positions = loadPositions();
  const open = positions.filter(p => p.status === 'open');

  if (open.length === 0) {
    console.log('[exit_monitor] No open positions.');
    return;
  }

  console.log(`[exit_monitor] Checking ${open.length} open position(s)...`);
  let changed = false;

  for (const pos of open) {
    const price = await getCurrentPrice(pos.sym);
    if (!price) { console.log(`  ${pos.sym}: could not fetch price`); continue; }

    const pnlPct  = ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2);
    const timeUp  = new Date() > new Date(pos.timeStopAt);
    const tpHit   = price >= pos.tpPrice;
    const slHit   = price <= pos.slPrice;

    const marker = tpHit ? '🎯 TP' : slHit ? '🛑 SL' : timeUp ? '⏰ TIME' : '  ';
    console.log(`  ${marker} ${pos.sym}: entry=$${pos.entryPrice.toFixed(2)} now=$${price.toFixed(2)} P&L=${pnlPct}% | TP=$${pos.tpPrice.toFixed(2)} SL=$${pos.slPrice.toFixed(2)}`);

    if (tpHit || slHit || timeUp) {
      const reason = tpHit ? `TP hit (+${pnlPct}%)` : slHit ? `SL hit (${pnlPct}%)` : `time stop (${pnlPct}%)`;
      console.log(`  → Exiting ${pos.sym}: ${reason}`);

      try {
        const job    = await bankr.prompt(`sell all my ${pos.sym} on Base`);
        const result = await bankr.waitForJob(job.jobId);
        console.log(`  ✅ ${result.response}`);
        pos.status    = 'closed';
        pos.closedAt  = new Date().toISOString();
        pos.closePrice = price;
        pos.closeReason = reason;
        pos.finalPnlPct = pnlPct;
        changed = true;
      } catch (e) {
        console.error(`  ❌ Exit failed: ${e.message}`);
      }
    }
  }

  if (changed) savePositions(positions);
}

// ── Seed current positions from known trades ──────────────────
async function seedPositions() {
  // Seed today's trades if positions.json is empty or missing
  const positions = loadPositions();
  if (positions.length > 0) return;

  console.log('[exit_monitor] Seeding known positions from today\'s trades...');
  const seeds = [
    { sym: 'cbBTC', entryPrice: 69698, sizeUsd: 7.20,  tpPct: 4.5, slPct: 3.2 },
    { sym: 'ETH',   entryPrice: 2124,  sizeUsd: 21.60, tpPct: 4.2, slPct: 3.0 }, // 3 ETH trades
    { sym: 'SOL',   entryPrice: 88.38, sizeUsd: 14.20, tpPct: 4.5, slPct: 3.2 }, // 2 SOL trades
  ];

  const seeded = seeds.map(s => ({
    ...s,
    tpPrice:    s.entryPrice * (1 + s.tpPct / 100),
    slPrice:    s.entryPrice * (1 - s.slPct / 100),
    openedAt:   '2026-03-20T18:30:00.000Z',
    timeStopAt: '2026-03-22T18:30:00.000Z', // 48h from entry
    status:     'open',
  }));

  savePositions(seeded);
  console.log(`[exit_monitor] Seeded ${seeded.length} positions.`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('=== delu exit monitor ===');
  await seedPositions();
  await checkExits();

  if (LOOP) {
    console.log(`\nNext check: ${new Date(Date.now() + CYCLE_MS).toISOString()}`);
    setInterval(async () => {
      console.log(`\n[${new Date().toISOString()}] Checking exits...`);
      await checkExits();
    }, CYCLE_MS);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

module.exports = { recordEntry, loadPositions, savePositions };
