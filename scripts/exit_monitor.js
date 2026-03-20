#!/usr/bin/env node
/**
 * exit_monitor.js — trailing stop exit manager
 *
 * Strategy:
 *   - No fixed take profit — let winners run
 *   - Trailing stop: once position is up X%, trail by Y% from peak
 *     e.g. peak = $100, trail = 5% → exit if price drops to $95
 *   - Hard stop loss: if never went positive, exit at -3%
 *   - Time stop: 72h — sell if still open (gives more time for bounce to develop)
 *
 * Default params:
 *   trailPct = 5%   (trail 5% from peak — generous for crypto)
 *   activateAt = 1% (start trailing once up 1% — locks in breakeven-ish)
 *   hardSlPct = 3%  (initial hard stop before trail activates)
 *   timeStopHours = 72
 *
 * Usage:
 *   node scripts/exit_monitor.js          # single check
 *   node scripts/exit_monitor.js --loop   # every 5min
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs    = require('fs');
const path  = require('path');
const bankr = require('../agent/bankr');
const { fetchBinanceHourly } = require('../backtest/fetch');

const POSITIONS_FILE = path.join(__dirname, '../data/positions.json');
const LOOP           = process.argv.includes('--loop');
const CYCLE_MS       = 5 * 60 * 1000; // 5min

// ── Position store ────────────────────────────────────────────
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch { return []; }
}
function savePositions(p) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2));
}

// ── Price fetcher ─────────────────────────────────────────────
async function getCurrentPrice(sym) {
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

    const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;

    // Update peak price (trailing high-water mark)
    if (!pos.peakPrice || price > pos.peakPrice) {
      pos.peakPrice = price;
      pos.peakPct   = pnlPct;
      changed = true;
    }

    // Trail stop triggers once we've hit activateAt threshold
    const trailActive  = pos.peakPct >= (pos.activateAt || 1.0);
    const trailStop    = pos.peakPrice * (1 - (pos.trailPct || 5) / 100);
    const hardSl       = pos.entryPrice * (1 - (pos.hardSlPct || 3) / 100);
    const timeUp       = new Date() > new Date(pos.timeStopAt);

    // Exit conditions
    const trailHit = trailActive && price <= trailStop;
    const hardSlHit = !trailActive && price <= hardSl;
    const shouldExit = trailHit || hardSlHit || timeUp;

    // Status line
    const trailLabel = trailActive
      ? `trail=$${trailStop.toFixed(2)} (peak=$${pos.peakPrice.toFixed(2)} -${pos.trailPct || 5}%)`
      : `hard_sl=$${hardSl.toFixed(2)} (trail activates at +${pos.activateAt || 1}%)`;

    const marker = trailHit ? '📉 TRAIL' : hardSlHit ? '🛑 SL' : timeUp ? '⏰ TIME' : pnlPct >= 0 ? '📈' : '📉';
    console.log(`  ${marker} ${pos.sym}: entry=$${pos.entryPrice.toFixed(2)} now=$${price.toFixed(2)} P&L=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% peak=${pos.peakPct >= 0 ? '+' : ''}${(pos.peakPct || 0).toFixed(2)}%`);
    console.log(`       ${trailLabel}`);

    if (shouldExit) {
      const reason = trailHit ? `trail stop (peak +${pos.peakPct.toFixed(2)}% → now +${pnlPct.toFixed(2)}%)`
                   : hardSlHit ? `hard SL (${pnlPct.toFixed(2)}%)`
                   : `time stop (${pnlPct.toFixed(2)}%)`;
      console.log(`  → Exiting ${pos.sym}: ${reason}`);

      try {
        const job    = await bankr.prompt(`sell all my ${pos.sym} on Base`);
        const result = await bankr.waitForJob(job.jobId);
        console.log(`  ✅ ${result.response}`);
        pos.status      = 'closed';
        pos.closedAt    = new Date().toISOString();
        pos.closePrice  = price;
        pos.closeReason = reason;
        pos.finalPnlPct = pnlPct.toFixed(2);
        changed = true;
      } catch (e) {
        console.error(`  ❌ Exit failed: ${e.message}`);
      }
    }
  }

  if (changed) savePositions(positions);
}

// ── Seed today's positions ────────────────────────────────────
async function seedPositions() {
  const positions = loadPositions();
  if (positions.length > 0) return; // already seeded

  console.log('[exit_monitor] Seeding known positions from today\'s trades...');
  const seeds = [
    { sym: 'cbBTC', entryPrice: 69698, sizeUsd: 7.20,  trailPct: 5, activateAt: 1, hardSlPct: 3 },
    { sym: 'ETH',   entryPrice: 2124,  sizeUsd: 21.60, trailPct: 5, activateAt: 1, hardSlPct: 3 },
    { sym: 'SOL',   entryPrice: 88.38, sizeUsd: 14.20, trailPct: 5, activateAt: 1, hardSlPct: 3 },
  ];

  const seeded = seeds.map(s => ({
    ...s,
    peakPrice:  s.entryPrice,
    peakPct:    0,
    openedAt:   '2026-03-20T18:30:00.000Z',
    timeStopAt: '2026-03-23T18:30:00.000Z', // 72h
    status:     'open',
  }));

  savePositions(seeded);
  console.log(`[exit_monitor] Seeded ${seeded.length} positions.`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('=== delu exit monitor (trailing stop) ===');
  await seedPositions();
  await checkExits();

  if (LOOP) {
    console.log(`\nNext check: ${new Date(Date.now() + CYCLE_MS).toISOString()}`);
    setInterval(async () => {
      console.log(`\n[${new Date().toISOString()}]`);
      await checkExits();
    }, CYCLE_MS);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

module.exports = { loadPositions, savePositions };
