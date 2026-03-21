/**
 * publish_status.js — Push live agent state to delu-site repo
 *
 * Runs after every agent cycle.
 * Writes public/data/status.json to the delu-site repo and commits.
 * Vercel reads this file — no tunnel, no exposed keys.
 *
 * Data included:
 * - Regime, BTC price, breadth
 * - Open positions (sym, entry, peak P&L, trail stop, tx hash)
 * - Yield position (Morpho vault)
 * - Last cycle (screened, action, Venice reasoning snippet)
 * - Autoresearch (daily + hourly exp count, best Sharpe)
 * - Recent closed trades
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const AGENT_DIR   = path.join(__dirname, '..');
const SITE_DIR    = path.join('/data/workspace/delu-site');
const DATA_DIR    = path.join(AGENT_DIR, 'data');
const AUTORES_DIR = path.join(AGENT_DIR, 'autoresearch');
const OUT_DIR     = path.join(SITE_DIR, 'public', 'data');
const OUT_FILE    = path.join(OUT_DIR, 'status.json');

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

async function buildStatus(regimeData) {
  const positions   = readJSON(path.join(DATA_DIR, 'positions.json'), []);
  const arDaily     = readJSON(path.join(AUTORES_DIR, 'state.json'), {});
  const arHourly    = readJSON(path.join(AUTORES_DIR, 'state_hourly.json'), {});
  const feedback    = readJSON(path.join(AUTORES_DIR, 'live_feedback.json'), []);
  const costDaily   = readJSON(path.join(AUTORES_DIR, 'cost_track.json'), {});
  const costHourly  = readJSON(path.join(AUTORES_DIR, 'cost_track_hourly.json'), {});

  // Cycle history from log (last 20 cycles for site feed)
  let lastCycle = null;
  let cycleHistory = [];
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, 'agent_log.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    if (lines.length) {
      lastCycle = JSON.parse(lines[lines.length - 1]);
      // Last 20 cycles, newest first
      cycleHistory = lines.slice(-20).reverse().map(l => {
        try {
          const c = JSON.parse(l);
          return {
            ts:        c.ts,
            regime:    c.regime,
            action:    c.decision?.action || 'hold',
            asset:     c.decision?.asset  || null,
            reasoning: c.decision?.reasoning || c.screen?.reason || null,
            confidence:c.decision?.confidence || null,
            screened:  c.scores?.length || 0,
            topToken:  c.scores?.[0] ? { sym: c.scores[0].sym, score: c.scores[0].combined } : null,
            trendingEntries: c.trendingEntries || [],
            layers:    c.decision?.layers_used || [],
          };
        } catch { return null; }
      }).filter(Boolean);
    }
  } catch {}

  const regime    = regimeData?.state || lastCycle?.regime || 'BEAR';
  const btcPrice  = regimeData?.btcNow || lastCycle?.regime_detail?.btcNow || 70842;
  const pct200    = regimeData?.pctFrom200 != null
    ? (regimeData.pctFrom200 * 100).toFixed(1) + '%'
    : '-4.2%';
  const breadth   = regimeData?.breadthFraction || lastCycle?.regime_detail?.breadthFraction || '3/17';

  // Next cycle estimate
  const lastRunTs = lastCycle?.ts ? new Date(lastCycle.ts).getTime() : Date.now();
  const elapsed   = (Date.now() - lastRunTs) / 60000;
  const remaining = Math.max(0, 30 - elapsed);
  const nextCycle = remaining < 1 ? '< 1 min' : `in ${Math.round(remaining)} min`;

  // Open positions — strip internal fields, keep public ones
  const openPositions = positions
    .filter(p => p.status === 'open')
    .map(p => ({
      sym:             p.sym,
      entryPrice:      p.entryPrice,
      sizeUSD:         p.sizeUsd,
      peakPct:         parseFloat((p.peakPct || 0).toFixed(2)),
      trailStop:       p.trailPct || 5,
      openedAt:        p.openedAt,
      entryTx:         p.entryTx || p.txHash || null,
      contractAddress: p.contractAddress || null,
      source:          p.source || 'universe',
      chain:           p.chain || 'base',
    }));

  // Yield position (hardcoded Morpho — update when rebalanced)
  const yieldPosition = {
    protocol:  'Morpho',
    vault:     'Moonwell Flagship USDC',
    chain:     'Base',
    amountUSD: 5.35,
    apy:       3.91,
    note:      'Capital parked here while in BEAR regime — earning yield while waiting for signal',
  };

  // Last cycle summary
  const decision = lastCycle?.decision || {};
  const scores   = (lastCycle?.scores || []).slice(0, 5);
  const cycleOut = {
    ts:       lastCycle?.ts || new Date().toISOString(),
    regime,
    screened: lastCycle?.scores?.length || 37,
    action:   decision.action || 'smart_yield',
    asset:    decision.asset || null,
    confidence: decision.confidence || null,
    reasoning: decision.reasoning
      ? decision.reasoning.slice(0, 300)
      : `${regime} regime — monitoring market, capital in yield`,
    topScores: scores.map(s => ({
      sym:      s.sym,
      score:    parseFloat((s.combined || 0).toFixed(3)),
      template: s.template || '-',
    })),
  };

  // Closed trades from feedback
  const closedTrades = feedback
    .filter(f => f.pnlPct != null)
    .slice(-10)
    .map(t => ({
      sym:       t.sym,
      pnlPct:    parseFloat((t.pnlPct || 0).toFixed(2)),
      won:       t.won,
      regime:    t.regime,
      entryTx:   t.entryTx || null,
      exitTx:    t.exitTx || null,
      openedAt:  t.openedAt,
      closedAt:  t.closedAt,
    }));

  const winCount = closedTrades.filter(t => t.won).length;

  return {
    updatedAt:   new Date().toISOString(),
    regime,
    btcPrice:    Math.round(btcPrice),
    pctFrom200:  pct200,
    breadth,
    nextCycle,

    // Wallet summary — total portfolio value + unrealised PnL across all positions
    wallet: (() => {
      const posValue  = openPositions.reduce((s, p) => s + (p.sizeUSD || 0), 0);
      const yieldVal  = yieldPosition.amountUSD || 0;
      const totalUSD  = parseFloat((posValue + yieldVal).toFixed(2));
      // Unrealised PnL: sum of (peakPct × sizeUSD) for each position (approximation)
      const unrealPnl = openPositions.reduce((s, p) => s + ((p.peakPct || 0) / 100 * (p.sizeUSD || 0)), 0);
      return {
        totalUSD,
        positionsUSD: parseFloat(posValue.toFixed(2)),
        yieldUSD:     parseFloat(yieldVal.toFixed(2)),
        unrealPnlUSD: parseFloat(unrealPnl.toFixed(2)),
        unrealPnlPct: posValue > 0 ? parseFloat((unrealPnl / posValue * 100).toFixed(2)) : 0,
      };
    })(),

    positions: openPositions,
    yield:     yieldPosition,

    lastCycle: cycleOut,

    performance: {
      closedTrades: closedTrades.length,
      winRate:      closedTrades.length ? `${winCount}/${closedTrades.length}` : null,
      recentTrades: closedTrades,
    },

    cycleHistory,

    reasoningTraces: (() => {
      try {
        const tracesFile = path.join(__dirname, '../data/reasoning_traces.jsonl');
        if (!fs.existsSync(tracesFile)) return [];
        return fs.readFileSync(tracesFile, 'utf8')
          .split('\n').filter(Boolean)
          .map(l => JSON.parse(l))
          .slice(-5); // last 5 trades
      } catch { return []; }
    })(),

    autoresearch: {
      daily: {
        expCount:      arDaily.expCount || 0,
        bestValSharpe: parseFloat((arDaily.bestValSharpe || 0).toFixed(3)),
        bestAudSharpe: parseFloat((arDaily.bestAudSharpe || 0).toFixed(3)),
        bestScore:     parseFloat((arDaily.bestScore || 0).toFixed(3)),
        spend:         parseFloat((costDaily.estimatedSpend || 0).toFixed(3)),
      },
      hourly: {
        expCount:      arHourly.expCount || 0,
        bestValSharpe: parseFloat((arHourly.bestValSharpe || 0).toFixed(3)),
        bestAudSharpe: parseFloat((arHourly.bestAudSharpe || 0).toFixed(3)),
        bestScore:     parseFloat((arHourly.bestScore || 0).toFixed(3)),
        spend:         parseFloat((costHourly.estimatedSpend || 0).toFixed(3)),
      },
    },

    stack: {
      execution:    'Bankr API (Base)',
      reasoning:    'Venice llama-3.3-70b (E2EE private inference)',
      screening:    'Bankr LLM gemini-2.5-flash',
      research:     'Bankr LLM claude-sonnet-4-5',
      socialData:   'Checkr (x402 micropayments)',
      onchainData:  'GeckoTerminal DEX flows',
      priceData:    'Binance OHLCV + funding rates',
      stopMgmt:     'Bankr native trailing stops',
    },
  };
}

async function publish(regimeData = null) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const status = await buildStatus(regimeData);
    fs.writeFileSync(OUT_FILE, JSON.stringify(status, null, 2));

    // Commit + push to delu-site repo
    const gitCmd = (cmd) => execSync(cmd, { cwd: SITE_DIR, stdio: 'pipe' }).toString().trim();

    try {
      gitCmd('git add public/data/status.json');
      const diff = gitCmd('git diff --cached --stat');
      if (diff) {
        gitCmd(`git commit -m "data: live status update ${new Date().toISOString().slice(0,16)}"`);
        gitCmd('git push origin main');
        console.log('[publish] ✅ Status pushed to delu-site');
      } else {
        console.log('[publish] No changes to push');
      }
    } catch (gitErr) {
      console.warn('[publish] Git push failed (site may not be configured):', gitErr.message?.slice(0, 80));
    }

    return status;
  } catch (e) {
    console.error('[publish] Error:', e.message);
    return null;
  }
}

module.exports = { publish };

// Run standalone for testing
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  publish().then(s => {
    if (s) console.log('[publish] regime=%s positions=%d ar_daily_exp=%d ar_hourly_exp=%d',
      s.regime, s.positions.length, s.autoresearch.daily.expCount, s.autoresearch.hourly.expCount);
  });
}
