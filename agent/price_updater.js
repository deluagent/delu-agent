'use strict';
/**
 * price_updater.js — Lightweight position price refresher
 * Runs every 5 minutes, updates open position prices in status.json
 * and pushes to delu-site. Keeps dashboard fresh between agent cycles.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const https = require('https');

const STATUS_FILE  = path.join(__dirname, '../../delu-site/public/data/status.json');
const SITE_DIR     = path.join(__dirname, '../../delu-site');
const INTERVAL_MS  = 5 * 60 * 1000; // 5 minutes

function get(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { Accept: 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function getGeckoPrice(contractAddress) {
  const j = await get(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${contractAddress}`);
  const price = parseFloat(j?.data?.attributes?.price_usd);
  return price > 0 ? price : null;
}

async function getAlchemyPrice(contractAddress) {
  const key = process.env.ALCHEMY_KEY;
  if (!key) return null;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      network: 'base-mainnet',
      address: contractAddress,
      startTime: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      endTime: new Date().toISOString(),
      interval: '1h',
    });
    const req = https.request({
      hostname: 'api.g.alchemy.com',
      path: `/prices/v1/${key}/tokens/historical`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const items = JSON.parse(d)?.data || [];
          const last = items[items.length - 1];
          const price = parseFloat(last?.value);
          resolve(price > 0 ? price : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function getLivePrice(sym, contractAddress) {
  if (!contractAddress) return null;
  // Alchemy first, GeckoTerminal fallback
  const alch = await getAlchemyPrice(contractAddress).catch(() => null);
  if (alch && alch > 0) return alch;
  const gecko = await getGeckoPrice(contractAddress).catch(() => null);
  return gecko || null;
}

async function updatePrices() {
  if (!fs.existsSync(STATUS_FILE)) {
    console.log('[price_updater] status.json not found — skipping');
    return;
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (e) {
    console.error('[price_updater] Failed to parse status.json:', e.message);
    return;
  }

  const positions = status?.positions || [];
  // positions in status.json are always open (closed ones removed by publish_status)
  const open = positions.filter(p => p.contractAddress);
  if (!open.length) {
    console.log('[price_updater] No open positions with contracts — nothing to update');
    return;
  }

  let updated = 0;
  for (const pos of open) {
    try {
      const price = await getLivePrice(pos.sym, pos.contractAddress);
      if (!price) {
        console.log(`[price_updater] ${pos.sym}: no price available`);
        continue;
      }
      const entry = pos.entryPrice;
      const pnlPct = entry ? ((price - entry) / entry * 100) : 0;
      const pnlUSD = pos.sizeUsd ? (pnlPct / 100 * pos.sizeUsd) : 0;

      // Update in status
      const idx = positions.findIndex(p => p.sym === pos.sym && p.contractAddress === pos.contractAddress);
      if (idx >= 0) {
        positions[idx].currentPrice = price;
        positions[idx].pnlPct       = parseFloat(pnlPct.toFixed(2));
        positions[idx].pnlUSD       = parseFloat(pnlUSD.toFixed(2));
        positions[idx].currentUSD   = parseFloat((pos.sizeUsd + pnlUSD).toFixed(2));
      }
      console.log(`[price_updater] ${pos.sym}: $${price.toPrecision(4)} | pnl=${pnlPct.toFixed(2)}%`);
      updated++;
    } catch (e) {
      console.warn(`[price_updater] ${pos.sym} error: ${e.message}`);
    }
  }

  if (!updated) return;

  status.positions  = positions;
  status.updatedAt  = new Date().toISOString();

  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));

  // Push to delu-site
  const { execSync } = require('child_process');
  try {
    execSync('git add public/data/status.json && git commit -m "data: live price update" && git push', {
      cwd: SITE_DIR, stdio: 'pipe',
    });
    console.log(`[price_updater] ✅ Pushed ${updated} price updates to delu-site`);
  } catch (e) {
    console.warn('[price_updater] git push failed:', e.message?.slice(0, 80));
  }
}

// Run immediately then every 5 min
updatePrices();
setInterval(updatePrices, INTERVAL_MS);
console.log('[price_updater] Started — refreshing position prices every 5 min');
