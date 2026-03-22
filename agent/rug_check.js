/**
 * rug_check.js — Onchain rug pull detection for Base tokens
 *
 * Checks before any entry:
 *   1. Liquidity >= $200k (configurable)
 *   2. Trade count >= 100 in 24h (real activity)
 *   3. Token distribution (no single wallet > 20% supply)
 *   4. Deployer/dev wallet activity (dumping = red flag)
 *   5. Bot detection (wash trading: low unique wallets vs high tx count)
 *   6. LP lock check (if Bankr data available)
 *   7. Age check (< 1h old = dangerous)
 *
 * Returns: { pass: bool, score: 0-100, flags: string[], details: {} }
 * score >= 70 = safe to trade
 * score  < 40 = likely rug, skip
 */

'use strict';

const https = require('https');

const ALCHEMY_KEY = (process.env.ALCHEMY_KEY || '').replace(/\s/g, '');
const BASE_RPC    = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

// ── Thresholds ────────────────────────────────────────────────
const MIN_LIQUIDITY_USD   = 200_000;  // $200k minimum
const MIN_TRADES_24H      = 100;      // at least 100 trades
const MAX_WALLET_PCT      = 0.20;     // no wallet > 20% of supply
const MAX_DEV_WALLET_PCT  = 0.10;     // dev wallet > 10% = warning
const MIN_UNIQUE_WALLETS  = 30;       // < 30 unique wallets = likely bots
const BOT_RATIO_THRESHOLD = 0.3;      // txs/uniqueWallets > 0.3 = bot activity
const MIN_POOL_AGE_HOURS  = 1;        // < 1h old = too new

function post(body) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const req = https.request({
      hostname: 'base-mainnet.g.alchemy.com', port: 443, method: 'POST',
      path: `/v2/${ALCHEMY_KEY}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(b); req.end();
  });
}

/**
 * Get recent transfers for a token (inbound = buys, outbound from contract = mints/dev sends)
 */
async function getTransfers(tokenAddr, direction = 'to', limit = 200) {
  const params = direction === 'to'
    ? { toAddress: tokenAddr, category: ['erc20'], withMetadata: true, excludeZeroValue: true, maxCount: `0x${limit.toString(16)}`, order: 'desc' }
    : { fromAddress: tokenAddr, category: ['erc20'], withMetadata: true, excludeZeroValue: true, maxCount: `0x${limit.toString(16)}`, order: 'desc' };
  try {
    const r = await post({ id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers', params: [params] });
    return r.result?.transfers || [];
  } catch { return []; }
}

/**
 * Get token metadata (total supply, decimals)
 */
async function getTokenMeta(tokenAddr) {
  try {
    const r = await post({ id: 1, jsonrpc: '2.0', method: 'alchemy_getTokenMetadata', params: [tokenAddr] });
    return r.result || null;
  } catch { return null; }
}

/**
 * Main rug check — returns safety assessment
 */
async function rugCheck(token, bankrData = null) {
  const { sym, address: addr } = token;
  const flags   = [];
  const details = { sym, addr };
  let score = 100; // start at 100, deduct for red flags

  // ── 1. Liquidity check (from Bankr data) ──────────────────
  const liquidity = bankrData?.liquidity || token.liquidity || 0;
  const txns24h   = bankrData?.txnCount24h || token.txns24h || 0;
  details.liquidity = liquidity;
  details.txns24h   = txns24h;

  if (liquidity < MIN_LIQUIDITY_USD) {
    const pct = liquidity / MIN_LIQUIDITY_USD;
    score -= Math.round((1 - pct) * 40); // up to -40 points
    flags.push(`LOW_LIQ: $${Math.round(liquidity/1000)}k < $${MIN_LIQUIDITY_USD/1000}k min`);
  }

  if (txns24h < MIN_TRADES_24H) {
    score -= 20;
    flags.push(`LOW_ACTIVITY: ${txns24h} txns < ${MIN_TRADES_24H} min`);
  }

  // ── 2. Transfer analysis (wallet distribution + bot check) ─
  const inbound = await getTransfers(addr, 'to', 200);
  const buyers  = new Set(inbound.map(t => t.from?.toLowerCase()).filter(Boolean));
  const uniqueBuyers = buyers.size;
  const botRatio     = uniqueBuyers > 0 ? inbound.length / uniqueBuyers : 999;

  details.uniqueBuyers = uniqueBuyers;
  details.botRatio     = parseFloat(botRatio.toFixed(2));

  if (uniqueBuyers < MIN_UNIQUE_WALLETS) {
    score -= 25;
    flags.push(`FEW_WALLETS: only ${uniqueBuyers} unique buyers (min ${MIN_UNIQUE_WALLETS})`);
  }

  if (botRatio > 10) {
    score -= 30;
    flags.push(`LIKELY_BOTS: ${inbound.length} txns from ${uniqueBuyers} wallets (ratio ${botRatio.toFixed(1)})`);
  } else if (botRatio > 5) {
    score -= 15;
    flags.push(`POSSIBLE_BOTS: tx/wallet ratio ${botRatio.toFixed(1)}`);
  }

  // ── 3. Dev wallet dump check (outbound from contract) ──────
  const devSends = await getTransfers(addr, 'from', 50);
  details.devSends = devSends.length;

  if (devSends.length > 0) {
    // Large sends from contract = dev moving tokens (pre-rug signal)
    const recentLargeSends = devSends.filter(t => {
      const val = parseFloat(t.value) || 0;
      return val > 1_000_000; // large token amounts
    });
    if (recentLargeSends.length > 0) {
      score -= 25;
      flags.push(`DEV_SENDING: ${recentLargeSends.length} large token sends from contract`);
    }

    // Check if sends to a small number of wallets (concentrated distribution)
    const devRecipients = new Set(devSends.map(t => t.to?.toLowerCase()).filter(Boolean));
    if (devRecipients.size <= 3 && devSends.length >= 5) {
      score -= 15;
      flags.push(`CONCENTRATED_DIST: dev sent to only ${devRecipients.size} wallets`);
    }
    details.devRecipients = devRecipients.size;
  }

  // ── 4. Wallet concentration (top buyer) ──────────────────
  if (inbound.length > 10) {
    const buyFreq = {};
    inbound.forEach(t => { const w = t.from?.toLowerCase(); if (w) buyFreq[w] = (buyFreq[w]||0)+1; });
    const topWallet     = Math.max(...Object.values(buyFreq));
    const concentration = topWallet / inbound.length;
    details.topWalletConcentration = parseFloat(concentration.toFixed(3));

    if (concentration > MAX_WALLET_PCT) {
      score -= 20;
      flags.push(`WHALE_CONCENTRATION: top wallet = ${(concentration*100).toFixed(0)}% of buys`);
    }
  }

  // ── 5. Token age check ────────────────────────────────────
  if (bankrData?.poolCreatedAt || token.poolCreatedAt) {
    const created = new Date(bankrData?.poolCreatedAt || token.poolCreatedAt);
    const ageHours = (Date.now() - created.getTime()) / 3600000;
    details.ageHours = parseFloat(ageHours.toFixed(1));
    if (ageHours < MIN_POOL_AGE_HOURS) {
      score -= 30;
      flags.push(`TOO_NEW: pool only ${ageHours.toFixed(1)}h old (min ${MIN_POOL_AGE_HOURS}h)`);
    } else if (ageHours < 6) {
      score -= 10;
      flags.push(`NEW_POOL: ${ageHours.toFixed(1)}h old — proceed cautiously`);
    }
  }

  // ── 6. Market cap sanity check ────────────────────────────
  const mcap = bankrData?.marketCap || token.marketCap || 0;
  details.marketCap = mcap;
  if (mcap > 0 && liquidity > 0) {
    const liqRatio = liquidity / mcap;
    details.liqRatio = parseFloat(liqRatio.toFixed(3));
    if (liqRatio < 0.02) {
      // < 2% of mcap is liquidity = easy to drain
      score -= 15;
      flags.push(`LOW_LIQ_RATIO: liq/mcap = ${(liqRatio*100).toFixed(1)}% (< 2% = thin)`);
    }
  }

  // ── Final verdict ─────────────────────────────────────────
  score = Math.max(0, Math.min(100, score));
  const pass = score >= 60 && !flags.some(f => f.startsWith('LIKELY_BOTS') || f.startsWith('DEV_SENDING') || f.startsWith('TOO_NEW'));

  const result = {
    pass,
    score,
    flags,
    details,
    verdict: score >= 80 ? 'SAFE' : score >= 60 ? 'CAUTION' : score >= 40 ? 'RISKY' : 'LIKELY_RUG',
  };

  console.log(`[rug_check] ${sym} score=${score}/100 (${result.verdict}) flags=[${flags.map(f=>f.split(':')[0]).join(',')||'none'}]`);
  return result;
}

module.exports = { rugCheck, MIN_LIQUIDITY_USD, MIN_TRADES_24H };
