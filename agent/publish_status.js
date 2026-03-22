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

async function buildStatus(regimeData, balanceStr = null) {
  const positions   = readJSON(path.join(DATA_DIR, 'positions.json'), []);
  const arDaily     = readJSON(path.join(AUTORES_DIR, 'state.json'), {});
  const arHourly    = readJSON(path.join(AUTORES_DIR, 'state_hourly.json'), {});
  const arOnchain   = readJSON(path.join(AUTORES_DIR, 'state_onchain.json'), {});
  const ar5m        = readJSON(path.join(AUTORES_DIR, 'state_5m.json'), {});
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
      cycleHistory = lines.slice(-50).reverse().map(l => {
        try {
          const c = JSON.parse(l);
          const entries = c.trendingEntries || [];
          const flagged = entries.filter(t => (t.score || 0) >= 0.65).map(t => t.symbol);
          const traded  = (c.decision?.action === 'buy' || c.decision?.action === 'long') && c.decision?.asset
            ? [c.decision.asset] : [];
          return {
            ts:               c.ts,
            regime:           c.regime,
            regime_detail:    c.regime_detail || null,
            action:           c.decision?.action || 'hold',
            asset:            c.decision?.asset  || null,
            confidence:       c.decision?.confidence || null,
            reasoning:        c.decision?.reasoning || c.screen?.reason || null,
            seenCount:        entries.length,
            flagged,
            traded,
            trendingEntries:  entries.slice(0, 5),
            positionUpdates:  c.positionAssessments || [],
            topSignal:        entries.length > 0
              ? `${entries[0].symbol} score=${entries[0].score?.toFixed(2)} ret1h=${((entries[0].ret1h||0)*100).toFixed(1)}%`
              : null,
            layers:           c.decision?.layers_used || [],
            screenLayer:      c.screen?.layer || null,
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

  // Open positions — fetch live prices from Bankr balances string
  // Format: "SOL - 0.1591 $14.28\nETH - 0.0070 $15.15\n..."
  let liveBalanceMap = {}; // sym -> { qty, valueUSD }
  let rawBalanceStr = '';
  try {
    // Use pre-fetched balance if available (agent already called getBalances this cycle)
    // Fall back to fresh fetch only if not provided
    if (balanceStr) {
      rawBalanceStr = balanceStr;
    } else {
      const bankr = require('./bankr');
      rawBalanceStr = await bankr.getBalances();
    }
    if (typeof rawBalanceStr === 'string') {
      // Bankr returns either "TOKEN - qty $val" or "Full Name - qty SYMBOL $val"
      // e.g. "USD Coin - 34.94 USDC $34.94" or "Solana - 0.159 SOL $14.30"
      // Strategy: extract the last all-caps word before the $ as the symbol
      // Bankr balance format varies: lowercase short sym, or "Full Name - qty SYM $val"
      // e.g. "usdc - 34.94 $34.94" or "USD Coin - 34.94 USDC $34.94"
      const NAME_MAP = {
        'USD COIN': 'USDC', 'ETHEREUM': 'ETH', 'SOLANA': 'SOL',
        'COINBASE WRAPPED BTC': 'CBBTC', 'BITCOIN': 'BTC',
        'THE FORGE': 'FORGE', 'MINIDEV': 'MINI', 'BLUE AGENT': 'BLUEAGENT',
      };
      for (const line of rawBalanceStr.split('\n')) {
        const trimmed = line.trim().replace(/^[•·\-]\s*/, ''); // strip bullet
        if (!trimmed) continue;

        // Format 1: "ETH - 0.0250 ETH ($51.79)"  (new format with parens)
        // Format 2: "ETH - 0.025 ETH $51.79"      (old format no parens)
        // Format 3: "USD Coin - 34.94 USDC $34.94" (name + inline sym)
        // Also handles commas in qty: "8,875,129.0462"
        const m = trimmed.match(/^(.+?)\s*[-–]\s*([\d,]+\.?\d*)\s*(?:([A-Za-z][A-Za-z0-9]*)\s*)?\(?\$([0-9.]+)\)?/);
        if (!m) continue;
        const namePart  = m[1].trim().toUpperCase();
        const qty       = parseFloat(m[2].replace(/,/g, ''));
        const inlineSym = m[3]?.toUpperCase();
        const val       = parseFloat(m[4]);
        const sym = inlineSym || NAME_MAP[namePart] || namePart.replace(/\s+/g, '');
        if (sym && qty >= 0 && val >= 0) liveBalanceMap[sym] = { qty, valueUSD: val };
      }
    }
  } catch(e) { console.warn('[publish] Balance fetch failed:', e.message?.slice(0,60)); }

  // Pull latest positionAssessments from last cycle (has fresh Alchemy prices)
  const lastAssessments = {};
  if (lastCycle?.positionAssessments) {
    for (const a of lastCycle.positionAssessments) {
      if (a.sym) lastAssessments[a.sym.toUpperCase()] = a;
    }
  }

  const openPositions = positions
    .filter(p => p.status === 'open')
    .map(p => {
      const live       = liveBalanceMap[p.sym.toUpperCase()];
      const assessment = lastAssessments[p.sym.toUpperCase()];
      const entryUSD   = p.sizeUsd || p.sizeUSD || 0;

      // Price priority: Alchemy (via positionAssessment) > Bankr balance > null
      const currentPrice = assessment?.currentPrice
        || (live && entryUSD > 0 && p.entryPrice ? (live.valueUSD / entryUSD) * p.entryPrice : null);

      // USD value priority: Bankr balance > derive from Alchemy price > entry
      const qty = p.qty || (p.entryPrice > 0 ? entryUSD / p.entryPrice : 0);
      const currentUSD = live?.valueUSD
        || (currentPrice && qty > 0 ? currentPrice * qty : entryUSD);

      const pnlUSD = parseFloat((currentUSD - entryUSD).toFixed(2));
      const pnlPct = entryUSD > 0 ? parseFloat((pnlUSD / entryUSD * 100).toFixed(2)) : 0;

      return {
        sym:             p.sym,
        entryPrice:      p.entryPrice,
        currentPrice:    currentPrice ? parseFloat(Number(currentPrice).toFixed(8)) : null,
        sizeUSD:         entryUSD,
        currentUSD:      parseFloat(currentUSD.toFixed(2)),
        pnlUSD,
        pnlPct,
        peakPct:         parseFloat((p.peakPct || 0).toFixed(2)),
        trailStop:       p.trailPct || 5,
        hardSlPct:       p.hardSlPct || 3,
        trailActivated:  (p.peakPct || 0) >= (p.activateAt || 1),
        openedAt:        p.openedAt,
        entryTx:         p.entryTx || p.txHash || null,
        contractAddress: p.contractAddress || null,
        source:          p.source || 'universe',
        chain:           p.chain || 'base',
        // Position intelligence from last assessment
        volumeTrend:     assessment?.volumeTrend     || null,
        recommendation:  assessment?.recommendation  || null,
        quantScore:      assessment?.quantScore      != null ? parseFloat(assessment.quantScore.toFixed(4)) : null,
        ret1h:           assessment?.ret1h           != null ? parseFloat((assessment.ret1h * 100).toFixed(2)) : null,
        transferStats:   assessment?.transferStats   || null,
      };
    });

  // Liquid USDC from live Bankr balance
  const liquidUSDC = liveBalanceMap['USDC']?.valueUSD ?? 0;

  // Yield position — show actual liquid USDC (ready to deploy)
  const yieldPosition = {
    protocol:  'Bankr Wallet',
    vault:     'Liquid USDC',
    chain:     'Base',
    amountUSD: parseFloat(liquidUSDC.toFixed(2)),
    apy:       0,
    note:      'Liquid USDC available for next trade entry',
  };

  // Last cycle summary
    const decision = lastCycle?.decision || {};
  const scores   = (lastCycle?.scores || []).slice(0, 5);
  const trendingEntries = lastCycle?.trendingEntries || [];
  const posAssessments  = lastCycle?.positionAssessments || [];

  // "ago" label — how long since last cycle ran
  const lastTs   = lastCycle?.ts ? new Date(lastCycle.ts) : null;
  const agoMs    = lastTs ? Date.now() - lastTs.getTime() : null;
  const agoLabel = agoMs == null ? 'never'
    : agoMs < 60000 ? `${Math.round(agoMs/1000)}s ago`
    : agoMs < 3600000 ? `${Math.round(agoMs/60000)}m ago`
    : `${Math.round(agoMs/3600000)}h ago`;

  // Seen = trending tokens evaluated this cycle + position checks
  const seenCount = trendingEntries.length + (lastCycle?.screen?.interesting?.length || 0);

  // Flagged = tokens that cleared signal threshold (score >= 0.65)
  const flagged = trendingEntries.filter(t => (t.score || 0) >= 0.65).map(t => t.symbol);

  // Traded = assets actually executed this cycle
  const traded = (decision.action === 'buy' || decision.action === 'long') && decision.asset
    ? [decision.asset] : [];

  // Top signal — best trending entry or top score
  const topSignal = trendingEntries.length > 0
    ? `${trendingEntries[0].symbol} score=${trendingEntries[0].score?.toFixed(2)} ret1h=${((trendingEntries[0].ret1h||0)*100).toFixed(1)}%`
    : scores.length > 0
    ? `${scores[0].sym} score=${scores[0].combined?.toFixed(3)}`
    : null;

  const cycleOut = {
    ts:           lastCycle?.ts || new Date().toISOString(),
    ago:          agoLabel,
    regime,
    regime_detail: lastCycle?.regime_detail || null,
    seenCount,
    screened:     seenCount,
    flagged,
    traded,
    action:     decision.action || 'hold',
    asset:      decision.asset || null,
    confidence: decision.confidence || null,
    reasoning:  decision.reasoning
      ? decision.reasoning.slice(0, 400)
      : `${regime} regime — monitoring market`,
    topSignal,
    trendingEntries: trendingEntries.slice(0, 5),
    positionUpdates: posAssessments,
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

    // Wallet summary — total live portfolio value from Bankr balance
    wallet: (() => {
      const usdcVal  = liveBalanceMap['USDC']?.valueUSD || 0;
      const yieldVal = yieldPosition.amountUSD || 0;

      // Total from Bankr balance map (includes ETH, cbBTC, all tokens Bankr sees)
      const bankrTotal = Object.entries(liveBalanceMap)
        .filter(([sym]) => sym !== 'USDC')
        .reduce((s, [, v]) => s + (v.valueUSD || 0), 0);

      // For open micro-cap positions NOT in Bankr balance, use assessment prices
      const microCapVal = openPositions
        .filter(p => !liveBalanceMap[p.sym.toUpperCase()])
        .reduce((s, p) => s + (p.currentUSD || p.sizeUSD || 0), 0);

      const totalUSD = parseFloat((bankrTotal + microCapVal + usdcVal + yieldVal).toFixed(2));

      // Unrealised PnL for tracked open positions
      const unrealPnl  = openPositions.reduce((s, p) => s + ((p.currentUSD || p.sizeUSD || 0) - (p.sizeUSD || 0)), 0);
      const entryTotal = openPositions.reduce((s, p) => s + (p.sizeUSD || 0), 0);

      return {
        totalUSD,
        positionsUSD: parseFloat((bankrTotal + microCapVal).toFixed(2)),
        liquidUSDC:   parseFloat(usdcVal.toFixed(2)),
        yieldUSD:     parseFloat(yieldVal.toFixed(2)),
        unrealPnlUSD: parseFloat(unrealPnl.toFixed(2)),
        unrealPnlPct: entryTotal > 0 ? parseFloat((unrealPnl / entryTotal * 100).toFixed(2)) : 0,
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
      onchain: {
        expCount:      arOnchain.expCount || 0,
        bestValSharpe: parseFloat((arOnchain.bestValSharpe || 0).toFixed(3)),
        bestAudSharpe: parseFloat((arOnchain.bestAudSharpe || 0).toFixed(3)),
        bestScore:     parseFloat((arOnchain.bestScore || 0).toFixed(3)),
      },
      fiveMin: {
        expCount:      ar5m.expCount || 0,
        bestValSharpe: parseFloat((ar5m.bestValSharpe || 0).toFixed(3)),
        bestAudSharpe: parseFloat((ar5m.bestAudSharpe || 0).toFixed(3)),
        bestScore:     parseFloat((ar5m.bestScore || 0).toFixed(3)),
      },
    },

    stack: {
      execution:    'Bankr API (Base mainnet)',
      reasoning:    'Venice llama-3.3-70b (private inference)',
      socialData:   'Checkr (x402 micropayments)',
      onchainData:  'Alchemy — Base token prices, transfer stats, wallet signals',
      rugDetection: 'Alchemy transfers — liquidity, bot ratio, whale concentration, dev dumps',
      priceData:    'Alchemy Prices API (1h bars, 30d history)',
      research:     'Anthropic Haiku — 3 parallel self-improving loops (onchain/hourly/5m)',
      stopMgmt:     'ATR-based trailing stops (2.5× ATR14) + hard SL -3%',
      discovery:    'Bankr trending + Checkr social (1h/4h/8h/12h windows)',
    },
  };
}

async function publish(regimeData = null, balanceStr = null) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const status = await buildStatus(regimeData, balanceStr);
    fs.writeFileSync(OUT_FILE, JSON.stringify(status, null, 2));

    // 1. Commit cycle log to delu-agent repo (judges can read raw history)
    const agentGit = (cmd) => execSync(cmd, { cwd: AGENT_DIR, stdio: 'pipe' }).toString().trim();
    try {
      // Only commit the human-readable summary — not raw JSONL
      agentGit('git add data/cycle_summary.md data/positions.json data/trade_journal.jsonl');
      const agentDiff = agentGit('git diff --cached --stat');
      if (agentDiff) {
        agentGit(`git commit -m "data: cycle log ${new Date().toISOString().slice(0,16)}"`);
        agentGit('git push origin main');
        console.log('[publish] ✅ Cycle log committed to delu-agent');
      }
    } catch (agentErr) {
      console.warn('[publish] Agent log push skipped:', agentErr.message?.slice(0, 60));
    }

    // 2. Commit + push to delu-site repo
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
