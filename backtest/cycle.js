#!/usr/bin/env node
/**
 * delu 15-min alpha cycle
 *
 * Every 15 min:
 *   1. Fetch fresh price data (Binance daily + hourly, GeckoTerminal for Base tokens)
 *   2. Detect market regime (vol ratio + BTC trend)
 *   3. Run all 5 strategies on all tokens
 *   4. Cross-sectional rank → portfolio construction
 *   5. Log alpha scores + any high-conviction signals
 *   6. Execute via Bankr when conviction ≥ threshold (regime-adjusted Kelly)
 *   7. Every ~1h: CoinGecko trending + Bankr market context
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');
const f     = require('./fetch');
const alpha = require('../agent/alpha');
const flows = require('../agent/flows');

const DATA_DIR       = path.join(__dirname, '../data');
const LEARNINGS_FILE = path.join(DATA_DIR, 'learnings.json');
const TRADES_FILE    = path.join(DATA_DIR, 'cycle_trades.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Token Universe ───────────────────────────────────────────

const MAJORS = [
  { symbol: 'ETH',  source: 'binance', pair: 'ETHUSDT' },
  { symbol: 'BTC',  source: 'binance', pair: 'BTCUSDT' },
  { symbol: 'SOL',  source: 'binance', pair: 'SOLUSDT' },
  { symbol: 'BNB',  source: 'binance', pair: 'BNBUSDT' },
  { symbol: 'LINK', source: 'binance', pair: 'LINKUSDT' },
  { symbol: 'AAVE', source: 'binance', pair: 'AAVEUSDT' },
  { symbol: 'ARB',  source: 'binance', pair: 'ARBUSDT' },
  { symbol: 'OP',   source: 'binance', pair: 'OPUSDT' },
];

const BASE_TOKENS = [
  { symbol: 'VIRTUAL', pool: '0x3f0296BF652e19bca772EC3dF08b32732F93014A' },
  { symbol: 'CLANKER', pool: '0xd23FE2DB317e1A96454a2D1c7e8fc0DbF19BB000' },
  { symbol: 'BRETT',   pool: '0x4e92ff5fb4fba11f60ede7dcd15d2ad42be3c373' },
  { symbol: 'DEGEN',   pool: '0x2c4499335b8dc5cfba08a1dde92c7e31f58d1cf6' },
  { symbol: 'AERO',    pool: '0x7902219e80510e2735a7d89e0b37a5d8a19c8ef6' },
  { symbol: 'JUNO',    pool: '0x1635213e2b19e459a4132df40011638b65ae7510a35d6a88c47ebf94912c7f2e' },
  { symbol: 'FELIX',   pool: '0x6e19027912db90892200a2b08c514921917bc55d7291ec878aa382c193b50084' },
  { symbol: 'CLAWD',   pool: '0xCD55381a53da35Ab1D7Bc5e3fE5F76cac976FAc3' },
  { symbol: 'CLAWNCH', pool: '0x07Da9c5d35028f578dFac5BE6e5Aaa8a835704F6' },
  { symbol: 'ODAI',    pool: '0xbf0f716999378af289863d0c7eb961793993a641a0a943ccc6bb45cb5713b3fb' },
];

const TRADEABLE = new Set(['ETH', 'SOL', 'LINK', 'AAVE', 'VIRTUAL', 'BRETT', 'DEGEN', 'AERO', 'ODAI', 'JUNO', 'CLAWD', 'FELIX']);

// Token contract addresses for Bankr swaps (Base mainnet)
const TOKEN_ADDR = {
  ODAI:    '0x0086cFF0c1E5D17b19F5bCd4c8840a5B4251D959',
  JUNO:    '0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07',
  CLAWD:   '0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07',
  FELIX:   '0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07',
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
  BRETT:   '0x532f27101965dd16442E59d40670FaF5eBb142E4',
  DEGEN:   '0x4ed4E862860bed51a9570b96d89af5e1B0Efefed',
  AERO:    '0x940181a94A35A4569E4529A3CDfb74e38FD98631',
};

// ─── Data Loading ─────────────────────────────────────────────

async function loadTokenData(symbol, source, pool) {
  let daily = [], hourly = [];

  if (source === 'binance') {
    try { daily  = await f.fetchBinanceHistory(symbol, 365); } catch(e) { }
    try { hourly = await f.fetchBinanceHourly(symbol, 168); } catch(e) { }
  } else {
    // GeckoTerminal for Base tokens
    try {
      daily = await f.fetchGeckoTerminal(symbol);
      daily = daily || [];
    } catch(e) { }
    // Hourly fallback via GeckoTerminal
    try {
      const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${pool}/ohlcv/hour?limit=168&token=base`;
      const r = await fetch(url, { headers: { Accept: 'application/json;version=20230302' }, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const json = await r.json();
        const list = json?.data?.attributes?.ohlcv_list || [];
        hourly = list.reverse().map(([ts, o, h, l, c, v]) => ({
          ts: ts*1000, time: new Date(ts*1000), tf: '1h',
          open:+o, high:+h, low:+l, close:+c, volume:+v
        }));
      }
    } catch(e) { }
  }

  if (daily.length === 0 && hourly.length > 0) daily = hourly;  // fallback
  return { daily, hourly };
}

// ─── Attention Signals ────────────────────────────────────────

// Get attention delta from Checkr for a token (with fast timeout)
async function getAttentionDelta(symbol) {
  try {
    const checkr = require('../agent/checkr');
    const spikes = await Promise.race([
      checkr.getSpikes(1.0),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
    ]);
    const token = spikes?.spikes?.find(s => s.symbol?.toUpperCase() === symbol);
    if (token) {
      return {
        delta:    token.ATT_delta_pp || 0,
        velocity: token.velocity || 0,
        viral:    token.hawkes?.signal || 'UNKNOWN',
        accel:    token.ATT_accelerating ? 0.1 : -0.1,
      };
    }
  } catch(e) { /* silent */ }
  return { delta: 0, velocity: 0, viral: 'UNKNOWN', accel: 0 };
}

// Build attention map from CoinGecko trending
function buildTrendingAttention(trendingList) {
  const map = {};
  trendingList.forEach((t, i) => {
    // Trending rank: position 0 = highest, score decays by rank
    const score = (10 - i) / 10;
    map[t.symbol?.toUpperCase()] = score;
  });
  return map;
}

// ─── State / Learnings DB ─────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(LEARNINGS_FILE)) {
    return { cycles: 0, snapshots: [], patterns: {}, tokens: {}, bankr: [], alphaHistory: [] };
  }
  const db = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'));
  if (!db.snapshots)    db.snapshots    = [];
  if (!db.patterns)     db.patterns     = {};
  if (!db.tokens)       db.tokens       = {};
  if (!db.bankr)        db.bankr        = [];
  if (!db.alphaHistory) db.alphaHistory = [];
  return db;
}
function saveDB(db) { fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(db, null, 2)); }

function recordSnapshot(db, ts, symbol, alphaResult, prices) {
  const r20  = alpha.returns(prices, 20);
  const r7d  = alpha.returns(prices, 7);
  const vol  = alpha.realizedVol(prices);
  const snap = {
    ts, symbol,
    price:      prices.at(-1),
    r7d:        r7d !== null ? +r7d.toFixed(4) : null,
    r20:        r20 !== null ? +r20.toFixed(4) : null,
    vol:        vol !== null ? +vol.toFixed(4) : null,
    finalAlpha: alphaResult.finalAlpha,
    volAdj:     alphaResult.volAdjusted,
    regime:     alphaResult.regime,
    s1:         alphaResult.strategies.s1,
    s2score:    alphaResult.strategies.s2?.score,
    s4signal:   alphaResult.strategies.s4?.signal,
    s4z:        alphaResult.strategies.s4?.z,
  };
  db.snapshots.push(snap);
  if (db.snapshots.length > 10000) db.snapshots = db.snapshots.slice(-10000);

  // Token stats
  if (!db.tokens[symbol]) db.tokens[symbol] = { count: 0, sumAlpha: 0, avgAlpha: 0, posCount: 0 };
  const t = db.tokens[symbol];
  t.count++;
  t.sumAlpha += alphaResult.volAdjusted;
  t.avgAlpha = t.sumAlpha / t.count;
  if (alphaResult.volAdjusted > 0) t.posCount++;
}

// ─── Bankr Execution ──────────────────────────────────────────

async function askBankr(prompt) {
  let key = process.env.BANKR_API_KEY;
  if (!key) {
    try { const cfg = JSON.parse(require('fs').readFileSync('/home/openclaw/.bankr/config.json','utf8')); key = cfg.apiKey; } catch {}
  }
  if (!key) return null;
  try {
    const r = await fetch('https://api.bankr.bot/agent/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(10000)
    });
    const { jobId } = await r.json();
    if (!jobId) return null;
    // Poll with retries — Bankr jobs take 30-90s
    for (let i = 0; i < 6; i++) {
      await new Promise(res => setTimeout(res, 15000));
      const poll = await fetch(`https://api.bankr.bot/agent/job/${jobId}`, {
        headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(10000)
      });
      const d = await poll.json();
      if (d.status === 'completed' || d.response) return d.response || null;
    }
    return null;
  } catch(e) { return null; }
}

async function executeTradeIfWarranted(portfolio, regime, db) {
  // Only execute in TREND or BREAKOUT regimes, when we have a clear top pick
  if (regime === 'BEAR' || portfolio.length === 0) return;

  const top = portfolio[0];
  if (!TRADEABLE.has(top.symbol)) return;

  // Check if we already have this position open
  let trades = [];
  try { trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch(e) {}
  const open = trades.find(t => t.symbol === top.symbol && !t.closed);
  if (open) return;

  // Only execute on very high vol-adjusted alpha
  if (top.alpha < 0.05) {
    console.log(`[exec] Top pick ${top.symbol} alpha too low (${top.alpha.toFixed(4)}) — skipping`);
    return;
  }

  const SIZE_USD = 2;
  console.log(`\n💸 [exec] Executing: BUY ${top.symbol} | alpha=${top.alpha.toFixed(4)} | weight=${(top.weight*100).toFixed(1)}% | regime=${regime}`);

  const tokenRef = TOKEN_ADDR[top.symbol] || top.symbol;
  const resp = await askBankr(`swap $${SIZE_USD} USDC to ${tokenRef} on base`);
  if (!resp) { console.log('   Bankr unavailable'); return; }
  console.log('   ' + resp.slice(0, 200));

  trades.push({
    id: Date.now(), symbol: top.symbol, sizeUsd: SIZE_USD, regime,
    alpha: top.alpha, weight: top.weight,
    entryTs: new Date().toISOString(), closed: false,
    bankrResp: resp.slice(0, 200)
  });
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

// ─── Main Cycle ───────────────────────────────────────────────

async function runCycle(cycleNum) {
  const ts = new Date().toISOString();
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`[cycle #${cycleNum}] ${ts}`);
  console.log(`${'═'.repeat(68)}`);

  const db = loadDB();
  db.cycles = cycleNum;

  // ── 1. Load BTC + ETH for regime detection ──────────────────
  let btcPrices = [], ethPrices = [];
  try {
    const btcBars = await f.fetchBinanceHistory('BTC', 90);
    const ethBars = await f.fetchBinanceHistory('ETH', 90);
    btcPrices = btcBars.map(b => b.close);
    ethPrices = ethBars.map(b => b.close);
  } catch(e) { console.warn('[regime] failed to load BTC/ETH:', e.message); }

  const regime = btcPrices.length > 30
    ? alpha.detectRegime(btcPrices, ethPrices)
    : { regime: 'NEUTRAL', volRatio: 1, trendStrength: 0 };

  console.log(`\n📊 REGIME: ${regime.regime} | vol_ratio=${regime.volRatio} | trend_strength=${regime.trendStrength}`);

  // ── 2. Get trending attention map ───────────────────────────
  let trendingMap = {};
  try {
    const trending = f.fetchTrending();
    trendingMap = buildTrendingAttention(trending);
    const trendNames = trending.slice(0, 5).map(t => t.symbol).join(', ');
    console.log(`🔥 Trending: ${trendNames}`);
  } catch(e) { }

  // ── 2b. DexScreener flow data ────────────────────────────────
  let flowData = {};
  try {
    flowData = await flows.getAllFlows();
    const accum = Object.entries(flowData).filter(([,f]) => f.accumulating).map(([s]) => s);
    const dist  = Object.entries(flowData).filter(([,f]) => f.distributing).map(([s]) => s);
    console.log(`💰 Flow — Accumulating: ${accum.join(', ') || 'none'} | Distributing: ${dist.join(', ') || 'none'}`);
  } catch(e) { console.warn('[flows]', e.message); }

  // ── 3. Fetch DexScreener flow signals (all Base tokens in parallel) ──
  console.log('[flow] Fetching buy/sell signals from DexScreener...');
  const allSymbols = [...BASE_TOKENS.map(t => t.symbol), 'VIRTUAL', 'BRETT', 'DEGEN', 'AERO'];
  const flowSignals = await f.fetchAllFlowSignals(allSymbols);
  const flowSummary = Object.entries(flowSignals)
    .map(([s, d]) => `${d.flowSignal > 0.1 ? '🟢' : d.flowSignal < -0.1 ? '🔴' : '⚪'}${s}(${d.flowSignal.toFixed(2)})`)
    .join(' ');
  console.log(`  ${flowSummary}`);

  // ── 4. Load all token data ──────────────────────────────────
  const allTokenData = [];

  // Majors — parallel Binance fetch
  console.log('\n[data] Loading majors (Binance)...');
  const majorBars = await Promise.allSettled(
    MAJORS.map(t => f.fetchBinanceHistory(t.symbol, 365))
  );

  for (let i = 0; i < MAJORS.length; i++) {
    const t = MAJORS[i];
    if (majorBars[i].status === 'rejected') { console.warn(`  ${t.symbol}: ${majorBars[i].reason.message}`); continue; }
    const bars = majorBars[i].value;
    if (!bars || bars.length < 30) continue;
    const flow = flowData[t.symbol];
    allTokenData.push({
      symbol:         t.symbol,
      prices:         bars.map(b => b.close),
      volume:         bars.at(-1).volume,
      avgVolume:      bars.slice(-20).reduce((s,b) => s+b.volume, 0) / 20,
      attentionDelta: trendingMap[t.symbol] || 0,
      attentionAccel: 0,
      walletInflow:   flow ? flows.walletInflowFactor(flow) : 0,
      engagementRate: flow ? flows.liquidityScore(flow) : 0,
      flow,
    });
  }

  // Base tokens — sequential (GeckoTerminal)
  console.log('[data] Loading Base tokens (GeckoTerminal)...');
  for (const t of BASE_TOKENS) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const bars = await f.fetchGeckoTerminal(t.symbol);
      if (!bars || bars.length < 15) { console.log(`  ${t.symbol}: insufficient bars`); continue; }
      const flow = flowData[t.symbol];
      allTokenData.push({
        symbol:         t.symbol,
        prices:         bars.map(b => b.close),
        volume:         bars.at(-1).volume,
        avgVolume:      bars.slice(-20).reduce((s,b) => s+b.volume, 0) / Math.min(bars.length, 20),
        attentionDelta: trendingMap[t.symbol] || 0,
        attentionAccel: 0,
        walletInflow:   flow ? flows.walletInflowFactor(flow) : 0,
        engagementRate: flow ? flows.liquidityScore(flow) : 0,
        flow,
      });
      console.log(`  ✅ ${t.symbol}: ${bars.length} bars`);
    } catch(e) { console.log(`  ⚠️  ${t.symbol}: ${e.message.slice(0,60)}`); }
  }

  // ── 4. Run alpha engine on all tokens ──────────────────────
  console.log(`\n[alpha] Scoring ${allTokenData.length} tokens...`);
  const alphaResults = allTokenData.map(t => {
    const result = alpha.strategy5_regimeMeta(t, regime);
    recordSnapshot(db, ts, t.symbol, result, t.prices);
    return { symbol: t.symbol, ...result, prices: t.prices };
  });

  // ── 5. Cross-sectional ranking (Strategy 3) ─────────────────
  const crossSection = alpha.strategy3_crossSectional(
    allTokenData.map(t => ({
      symbol:          t.symbol,
      prices:          t.prices,
      attentionDelta:  t.attentionDelta,
      engagementRate:  t.engagementRate,
    }))
  );

  // ── 6. Portfolio construction ────────────────────────────────
  const portfolio = alpha.constructPortfolio(alphaResults, 5, 0.20);

  // ── 7. Print alpha table ─────────────────────────────────────
  console.log('\n Symbol   │ Price        │  r7d%  │  r20%  │ Flow24h │ Strategy2 │ Alpha(vol) │ Signal');
  console.log(' ─────────┼──────────────┼────────┼────────┼─────────┼───────────┼────────────┼──────────');
  for (const r of alphaResults.sort((a, b) => b.volAdjusted - a.volAdjusted)) {
    const td    = allTokenData.find(t => t.symbol === r.symbol);
    const flow  = td?.flow;
    const p     = r.prices.at(-1);
    const r7d   = alpha.returns(r.prices, 7);
    const r20   = alpha.returns(r.prices, 20);
    const tag   = r.volAdjusted > 0.02 ? '🟢' : r.volAdjusted < -0.02 ? '🔴' : '⚪';
    const flowStr = flow
      ? (flow.netBuyPct >= 0 ? '+' : '') + (flow.netBuyPct * 100).toFixed(0) + '%'
      : '  --  ';
    const flowTag = flow?.accumulating ? '🟢' : flow?.distributing ? '🔴' : '⚪';
    const s2score = r.strategies.s2?.score || 0;
    const price   = p < 0.001 ? p.toExponential(2) : p < 1 ? p.toFixed(5) : p.toFixed(2);
    const s4note  = r.strategies.s4?.signal === 'LONG' ? ' ⚡REV' : '';
    console.log(
      ` ${tag}${r.symbol.padEnd(7)}│ ${('$'+price).padStart(12)} │`+
      `${(r7d!==null?(r7d*100>0?'+':'')+( r7d*100).toFixed(1)+'%':'  --  ').padStart(7)} │`+
      `${(r20!==null?(r20*100>0?'+':'')+( r20*100).toFixed(1)+'%':'  --  ').padStart(7)} │`+
      ` ${flowTag}${flowStr.padStart(6)}  │`+
      `${s2score.toFixed(4).padStart(10)} │`+
      `${r.volAdjusted.toFixed(4).padStart(11)} │${s4note}`
    );
  }

  // ── 8. Cross-sectional ranking ──────────────────────────────
  console.log('\n📈 CROSS-SECTIONAL RANK (Strategy 3 — relative strength):');
  crossSection.slice(0, 8).forEach(t =>
    console.log(`  #${t.rank} ${t.symbol.padEnd(8)} score=${t.score.toFixed(4)} weight=${(t.weight*100).toFixed(1)}%`)
  );

  // ── 9. Portfolio ─────────────────────────────────────────────
  if (portfolio.length > 0) {
    console.log('\n💼 PORTFOLIO (Strategy 5 meta — regime-weighted):');
    portfolio.forEach(p =>
      console.log(`  ${p.symbol.padEnd(8)} weight=${(p.weight*100).toFixed(1)}% alpha=${p.alpha.toFixed(4)}`)
    );
  } else {
    console.log('\n💼 PORTFOLIO: FLAT (no positive alpha in current regime)');
  }

  // ── 10. Panic reversion signals ─────────────────────────────
  const panicSignals = alphaResults.filter(r => r.strategies.s4?.signal === 'LONG');
  if (panicSignals.length > 0) {
    console.log('\n⚡ PANIC REVERSION SIGNALS (Strategy 4):');
    panicSignals.forEach(r =>
      console.log(`  ${r.symbol}: z=${r.strategies.s4.z} strength=${r.strategies.s4.strength}`)
    );
  }

  // ── 11. Execute if warranted ─────────────────────────────────
  await executeTradeIfWarranted(portfolio, regime.regime, db);

  // ── 12. Bankr market context (every 4 cycles) ────────────────
  if (cycleNum % 4 === 0) {
    console.log('\n🏦 Bankr market context...');
    const ctx = await askBankr('what is the current market sentiment and top trending on base? brief');
    if (ctx) {
      console.log('  ' + ctx.slice(0, 400).replace(/\n/g, '\n  '));
      db.bankr.push({ ts, context: ctx });
      if (db.bankr.length > 100) db.bankr = db.bankr.slice(-100);
    }
  }

  // ── 13. Alpha history for Sharpe tracking ───────────────────
  db.alphaHistory.push({
    ts, regime: regime.regime, volRatio: regime.volRatio,
    topAlpha: alphaResults.reduce((a, b) => b.volAdjusted > a ? b.volAdjusted : a, -Infinity),
    portfolioSize: portfolio.length,
    tokens: alphaResults.map(r => ({ s: r.symbol, a: +r.volAdjusted.toFixed(4) }))
  });
  if (db.alphaHistory.length > 500) db.alphaHistory = db.alphaHistory.slice(-500);

  // ── 14. Periodic deep insights (every 8 cycles ≈ 2h) ─────────
  if (cycleNum % 8 === 0 && cycleNum > 0) {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  TOKEN ALPHA LEARNING (cumulative)      ║');
    console.log('╚══════════════════════════════════════════╝');
    Object.entries(db.tokens)
      .sort((a, b) => b[1].avgAlpha - a[1].avgAlpha)
      .forEach(([sym, d]) => {
        const posPct = Math.round(d.posCount / d.count * 100);
        console.log(`  ${sym.padEnd(8)} n=${d.count} avgAlpha=${d.avgAlpha.toFixed(4)} positivePct=${posPct}%`);
      });
  }

  saveDB(db);
  console.log(`\n[cycle #${cycleNum}] done | ${allTokenData.length} tokens | regime=${regime.regime} | ${db.snapshots.length} total snapshots`);
}

// ─── Entry ────────────────────────────────────────────────────

const INTERVAL_MS = 15 * 60 * 1000;

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  delu alpha cycle — 15min                                       ║');
console.log(`║  ${MAJORS.length} majors (Binance) + ${BASE_TOKENS.length} Base tokens (GeckoTerminal)`.padEnd(68) + '║');
console.log('║  Strategies: trend·attention·flow·crosssection·panicrev·regime  ║');
console.log('║  + DexScreener buy/sell flow signals on all Base tokens         ║');;
console.log('╚══════════════════════════════════════════════════════════════════╝');

let cycleNum = 0;
runCycle(cycleNum).catch(console.error);
setInterval(() => { cycleNum++; runCycle(cycleNum).catch(console.error); }, INTERVAL_MS);
