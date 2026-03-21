/**
 * dashboard.js — HTTP status endpoint for delu agent
 *
 * Exposes GET /status — live state of the agent
 * Judges, Bankr team, or anyone can hit this to verify the agent is real and running.
 *
 * Usage: node agent/dashboard.js
 * Or: import and call startDashboard(port) from index.js
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const DATA_DIR      = path.join(__dirname, '../data');
const AUTORES_DIR   = path.join(__dirname, '../autoresearch');
const HEARTBEAT_MS  = 35 * 60 * 1000; // 35min — agent should cycle every 30min

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function getStatus() {
  const positions   = readJSON(path.join(DATA_DIR, 'positions.json'), []);
  const arState     = readJSON(path.join(AUTORES_DIR, 'state.json'), {});
  const feedback    = readJSON(path.join(AUTORES_DIR, 'live_feedback.json'), []);
  const costTrack   = readJSON(path.join(AUTORES_DIR, 'cost_track.json'), {});

  // Last cycle from agent log
  let lastCycle = null;
  let lastDecision = null;
  let lastRegime = null;
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, 'agent_log.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]);
      lastCycle    = last.ts;
      lastDecision = last.decision;
      lastRegime   = last.regime;
    }
  } catch {}

  const openPositions = positions.filter(p => p.status === 'open');
  const closedTrades  = feedback.filter(f => f.pnlPct != null);
  const wins          = closedTrades.filter(f => f.won).length;
  const avgPnl        = closedTrades.length
    ? (closedTrades.reduce((s, f) => s + f.pnlPct, 0) / closedTrades.length).toFixed(2)
    : null;

  // Cycle freshness check
  const cycleAge = lastCycle
    ? Math.round((Date.now() - new Date(lastCycle).getTime()) / 60000)
    : null;
  const isHealthy = cycleAge !== null && cycleAge < 35;

  return {
    agent: 'delu',
    version: '1.0.0',
    description: 'Autonomous onchain trading agent — self-improving via recursive autoresearch',
    status: isHealthy ? 'alive' : 'stale',
    wallet: process.env.DELU_WALLET || '0xed2ceca9de162c4f2337d7c1ab44ee9c427709da',
    chain: 'Base',
    timestamp: new Date().toISOString(),

    cycle: {
      lastRun:     lastCycle,
      ageMinutes:  cycleAge,
      healthy:     isHealthy,
      regime:      lastRegime,
      lastDecision: lastDecision ? {
        action:     lastDecision.action,
        asset:      lastDecision.asset,
        confidence: lastDecision.confidence,
        reasoning:  lastDecision.reasoning?.slice(0, 120),
      } : null,
    },

    positions: {
      open:  openPositions.length,
      list: openPositions.map(p => ({
        sym:        p.sym,
        entryPrice: p.entryPrice,
        sizeUsd:    p.sizeUsd,
        peakPct:    p.peakPct?.toFixed(2),
        openedAt:   p.openedAt,
        trailStop:  `${p.trailPct}% from peak`,
      })),
    },

    performance: {
      closedTrades: closedTrades.length,
      winRate:      closedTrades.length ? `${wins}/${closedTrades.length}` : 'N/A',
      avgPnlPct:    avgPnl,
    },

    autoresearch: {
      experiments:    arState.expCount || 0,
      bestValSharpe:  arState.bestValSharpe?.toFixed(3),
      bestAudSharpe:  arState.bestAudSharpe?.toFixed(3),
      bestCombined:   arState.bestScore?.toFixed(3),
      estimatedSpend: `$${costTrack.estimatedSpend?.toFixed(3) || 0}`,
    },

    stack: {
      tradeReasoning:   'Venice llama-3.3-70b (E2EE private inference)',
      screening:        'Bankr LLM gemini-2.5-flash (fast pre-filter)',
      research:         'Bankr LLM claude-sonnet-4-5 (self-improving autoresearch)',
      signals:          ['momentum', 'OBV', 'funding_rate', 'social_attention (Checkr)', 'volume_confirmation', '52w_high_proximity'],
      execution:        'Bankr API (onchain, Base)',
      stopManagement:   'Bankr native trailing stops (5% trail)',
      yieldManagement:  'Morpho / Moonwell USDC auto-rebalance',
    },
  };
}

function startDashboard(port = 3000) {
  const server = http.createServer((req, res) => {
    if (req.url === '/status' || req.url === '/') {
      const status = getStatus();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(status, null, 2));
    } else if (req.url === '/summary') {
      try {
        const md = fs.readFileSync(path.join(DATA_DIR, 'cycle_summary.md'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/markdown', 'Access-Control-Allow-Origin': '*' });
        res.end(md);
      } catch {
        res.writeHead(404); res.end('No summary yet');
      }
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });

  server.listen(port, () => {
    console.log(`[dashboard] delu status at http://localhost:${port}/status`);
  });

  return server;
}

// Run standalone
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  startDashboard(process.env.DASHBOARD_PORT || 3000);
}

module.exports = { startDashboard, getStatus };
