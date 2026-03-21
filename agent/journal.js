/**
 * journal.js — Trade journal + position reconciliation
 *
 * Three responsibilities:
 *  1. reconcilePositions() — sync positions.json with Bankr's actual state
 *  2. recordClose()        — log a closed trade with PnL
 *  3. writeSummary()       — write human-readable cycle summary
 *  4. feedbackToResearch() — append live trade outcomes to autoresearch signal
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const POSITIONS_FILE  = path.join(__dirname, '../data/positions.json');
const JOURNAL_FILE    = path.join(__dirname, '../data/trade_journal.jsonl');
const SUMMARY_FILE    = path.join(__dirname, '../data/cycle_summary.md');
const FEEDBACK_FILE   = path.join(__dirname, '../autoresearch/live_feedback.json');

// ── Load / save positions ────────────────────────────────────
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); }
  catch { return []; }
}

function savePositions(positions) {
  fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// ── 1. Reconcile positions with Bankr ────────────────────────
// Bankr native trailing stops can close positions without us knowing.
// This parses Bankr's balance response and marks closed positions.
async function reconcilePositions(bankrBalanceResponse, currentPrices = {}) {
  const positions = loadPositions();
  const openPositions = positions.filter(p => p.status === 'open');
  if (openPositions.length === 0) return positions;

  const closed = [];
  const stillOpen = [];

  for (const pos of openPositions) {
    const sym = pos.sym;
    const currentPrice = currentPrices[sym];

    // Check time stop
    if (pos.timeStopAt && new Date() > new Date(pos.timeStopAt)) {
      const pnlPct = currentPrice
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100)
        : null;
      pos.status      = 'closed';
      pos.closeReason = 'time_stop';
      pos.closedAt    = new Date().toISOString();
      pos.closePrice  = currentPrice || null;
      pos.pnlPct      = pnlPct;
      closed.push(pos);
      continue;
    }

    // Check if token has disappeared from Bankr balances (trailing stop or manual close)
    // Bankr balance string format: "ETH - 0.0070 $15.15\nSOL - 0.1591 $14.28\n..."
    if (bankrBalanceResponse) {
      // Parse all token symbols currently held (non-zero balance)
      // Bankr returns: "USD Coin - 34.94 USDC $34.94" or "Solana - 0.159 SOL $14.30"
      const NAME_MAP = {
        'USD COIN': 'USDC', 'ETHEREUM': 'ETH', 'SOLANA': 'SOL',
        'COINBASE WRAPPED BTC': 'CBBTC', 'BITCOIN': 'BTC',
      };
      const heldSymbols = new Set();
      const lines = bankrBalanceResponse.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const m = line.match(/^(.+?)\s*[-–]\s*([\d.]+)\s*(?:([A-Za-z]+)\s*)?\$([\d.]+)/);
        if (!m) continue;
        const namePart  = m[1].trim().toUpperCase();
        const qty       = parseFloat(m[2]);
        const inlineSym = m[3]?.toUpperCase();
        if (qty <= 0) continue;
        const sym = inlineSym || NAME_MAP[namePart] || namePart.replace(/\s+/g,'');
        if (sym) heldSymbols.add(sym);
      }

      // For non-contract tokens (majors): if sym not in held list, position is closed
      // For contract address tokens (MOLT etc): check if contract addr appears in balance,
      // or if qty explicitly 0; if neither, assume stopped by Bankr since we can't verify
      const isContractToken = !!pos.contractAddress;
      const isHeld = heldSymbols.has(sym.toUpperCase());

      if (!isContractToken && !isHeld && heldSymbols.size > 0) {
        // Bankr gave us a real balance list and this token isn't in it — stopped out
        const pnlPct = currentPrice
          ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100)
          : null;
        pos.status      = 'closed';
        pos.closeReason = 'bankr_stop';
        pos.closedAt    = new Date().toISOString();
        pos.closePrice  = currentPrice || null;
        pos.pnlPct      = pnlPct;
        closed.push(pos);
        console.log(`[journal] ${sym} not in Bankr balances → marked closed (bankr_stop)`);
        continue;
      }
    }

    // Update peak price for open positions
    if (currentPrice && currentPrice > (pos.peakPrice || 0)) {
      pos.peakPrice = currentPrice;
      pos.peakPct   = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100);
    }

    stillOpen.push(pos);
  }

  const closedHistorical = positions.filter(p => p.status === 'closed');
  const updated = [...closedHistorical, ...stillOpen, ...closed];
  savePositions(updated);

  // Log any newly closed positions to journal
  for (const pos of closed) {
    appendJournal({
      type:       'close',
      sym:        pos.sym,
      entryPrice: pos.entryPrice,
      closePrice: pos.closePrice,
      pnlPct:     pos.pnlPct,
      reason:     pos.closeReason,
      openedAt:   pos.openedAt,
      closedAt:   pos.closedAt,
      sizeUsd:    pos.sizeUsd,
    });
    console.log(`[journal] Closed ${pos.sym} | reason=${pos.closeReason} | PnL=${pos.pnlPct?.toFixed(2)}%`);
  }

  return updated;
}

// ── 2. Record a new entry ────────────────────────────────────
function recordEntry(sym, entryPrice, sizeUsd, meta = {}) {
  const pos = {
    sym,
    entryPrice,
    sizeUsd,
    trailPct:   5,
    activateAt: 1,
    hardSlPct:  3,
    peakPrice:  entryPrice,
    peakPct:    0,
    openedAt:   new Date().toISOString(),
    timeStopAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    status:     'open',
    ...meta,
  };

  const positions = loadPositions();
  // Remove any existing open position for same sym
  const filtered = positions.filter(p => !(p.sym === sym && p.status === 'open'));
  filtered.push(pos);
  savePositions(filtered);

  appendJournal({
    type:       'open',
    sym,
    entryPrice,
    sizeUsd,
    openedAt:   pos.openedAt,
    signals:    meta.signals || null,
    regime:     meta.regime || null,
    confidence: meta.confidence || null,
  });

  console.log(`[journal] Opened ${sym} @ $${entryPrice} | size=$${sizeUsd}`);
  return pos;
}

// ── 3. Write human-readable cycle summary ────────────────────
function writeSummary({ regime, scores, decision, positions, screen, cycleTs, trendingEntries }) {
  const openPos = positions.filter(p => p.status === 'open');
  const journalEntries = loadJournalRecent(20);

  // PnL stats
  const closedTrades = journalEntries.filter(e => e.type === 'close' && e.pnlPct != null);
  const wins   = closedTrades.filter(e => e.pnlPct > 0).length;
  const avgPnl = closedTrades.length
    ? (closedTrades.reduce((s, e) => s + e.pnlPct, 0) / closedTrades.length).toFixed(2)
    : null;

  const ts = cycleTs || new Date().toISOString();
  const timeStr = ts.slice(0, 16).replace('T', ' ');
  const action = `${(decision?.action || 'hold').toUpperCase()}${decision?.asset && decision.asset !== 'USDC' ? ' ' + decision.asset : ''}`;

  // One-line separator entry for this cycle
  const entry = [
    `## ${timeStr} UTC — ${action} (${decision?.confidence || 0}% conf)`,
    `**Regime:** ${regime?.state || 'RANGE'} | BTC $${Math.round(regime?.btcNow || 0)} | ${((regime?.pctFrom200||0)*100).toFixed(1)}% from 200d MA`,
    decision?.reasoning
      ? `**Venice:** "${decision.reasoning.slice(0, 200)}${decision.reasoning.length > 200 ? '…' : ''}"`
      : '',
    trendingEntries?.length
      ? `**Discovered:** ${trendingEntries.slice(0, 4).map(t => `${t.symbol}(score=${t.score?.toFixed(2)} ret1h=${((t.ret1h||0)*100).toFixed(1)}%)`).join(' · ')}`
      : '',
    openPos.length
      ? `**Positions:** ${openPos.map(p => `${p.sym} +${(p.peakPct||0).toFixed(1)}%`).join(', ')}`
      : '**Positions:** none',
    closedTrades.length
      ? `**P&L:** ${wins}/${closedTrades.length} wins · avg ${avgPnl}%`
      : '',
    '',
  ].filter(l => l !== null).join('\n');

  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });

  // Prepend new entry — newest at top, keep last 200 lines
  let existing = '';
  try { existing = fs.readFileSync(SUMMARY_FILE, 'utf8'); } catch {}

  // Strip old header if present
  existing = existing.replace(/^# delu — cycle log\n+/, '');

  const header = `# delu — cycle log\n*Autonomous onchain trading agent · updated every 30 min*\n\n`;
  const body   = (entry + existing).split('\n').slice(0, 400).join('\n');

  fs.writeFileSync(SUMMARY_FILE, header + body);
  console.log(`[journal] Cycle summary written → ${SUMMARY_FILE}`);
}

// ── 4. Feed live outcomes back to autoresearch ───────────────
// After positions close, record whether the regime+signals predicted correctly.
// The autoresearch loop reads this to know which signal combinations work in practice.
function feedbackToResearch(closedPositions) {
  if (!closedPositions || closedPositions.length === 0) return;

  let feedback = [];
  try { feedback = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')); }
  catch { feedback = []; }

  for (const pos of closedPositions) {
    if (!pos.pnlPct) continue;
    feedback.push({
      sym:        pos.sym,
      pnlPct:     pos.pnlPct,
      won:        pos.pnlPct > 0,
      regime:     pos.regime || 'unknown',
      signals:    pos.signals || {},
      openedAt:   pos.openedAt,
      closedAt:   pos.closedAt,
      reason:     pos.closeReason,
    });
  }

  // Keep last 100
  feedback = feedback.slice(-100);
  fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2));

  // Summary stats for logging
  const wins   = feedback.filter(f => f.won).length;
  const avgPnl = feedback.length
    ? (feedback.reduce((s, f) => s + f.pnlPct, 0) / feedback.length).toFixed(2)
    : 0;
  console.log(`[journal] Feedback updated: ${feedback.length} trades | WR=${wins}/${feedback.length} | avgPnL=${avgPnl}%`);
}

// ── Helpers ──────────────────────────────────────────────────
function appendJournal(entry) {
  fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
}

function loadJournalRecent(n = 50) {
  try {
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => JSON.parse(l));
  } catch { return []; }
}

function getStats() {
  const journal = loadJournalRecent(200);
  const closes  = journal.filter(e => e.type === 'close' && e.pnlPct != null);
  return {
    totalTrades: closes.length,
    wins:        closes.filter(e => e.pnlPct > 0).length,
    losses:      closes.filter(e => e.pnlPct <= 0).length,
    avgPnl:      closes.length ? closes.reduce((s, e) => s + e.pnlPct, 0) / closes.length : 0,
    bestTrade:   closes.reduce((best, e) => e.pnlPct > (best?.pnlPct || -Infinity) ? e : best, null),
    worstTrade:  closes.reduce((worst, e) => e.pnlPct < (worst?.pnlPct || Infinity) ? e : worst, null),
  };
}

module.exports = {
  reconcilePositions,
  recordEntry,
  writeSummary,
  feedbackToResearch,
  loadPositions,
  getStats,
  loadJournalRecent,
};
