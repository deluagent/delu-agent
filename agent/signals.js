/**
 * Signal aggregator
 * Pulls: Chainlink prices, Checkr attention, Polymarket odds
 */

const { ethers } = require('ethers');

const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'
];

async function getChainlinkPrice(address) {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC);
  const feed = new ethers.Contract(address, CHAINLINK_ABI, provider);
  const [, answer, , updatedAt] = await feed.latestRoundData();
  return {
    price: Number(answer) / 1e8,
    updatedAt: Number(updatedAt)
  };
}

async function getEthPrice() {
  return getChainlinkPrice(process.env.CHAINLINK_ETH_USD);
}

async function getBtcPrice() {
  // Bankr for BTC — Chainlink BTC/USD not verified on Base
  try {
    const bankr = require('./bankr');
    const job = await bankr.prompt('what is the price of BTC?');
    const result = await bankr.waitForJob(job.jobId);
    const match = result.response.match(/\$([0-9,]+\.?\d*)/);
    const price = match ? parseFloat(match[1].replace(/,/g, '')) : null;
    return { price, updatedAt: Math.floor(Date.now() / 1000) };
  } catch (e) {
    return { price: null, updatedAt: null };
  }
}

/**
 * Calculate a simple RSI from price history
 * prices: array of closing prices, newest last
 */
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const recent = prices.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
}

/**
 * Fetch attention/trending signals
 * Primary: Checkr x402 (best signal quality)
 * Fallback: Bankr trending tokens (free, works now)
 */
async function getAttentionSignals() {
  // Try Checkr first
  try {
    const checkr = require('./checkr');
    const data = await checkr.getSpikes(2.0);
    const parsed = checkr.parseSpikes(data);
    if (parsed.length > 0) {
      console.log(`[signals] Checkr: ${parsed.length} spikes`);
      return parsed;
    }
  } catch (e) {
    console.warn('[signals] Checkr unavailable, using Bankr trending:', e.message);
  }

  // Fallback: Bankr trending
  try {
    const bankr = require('./bankr');
    const job = await bankr.prompt('what tokens are trending on base right now? top 5 with price change');
    const result = await bankr.waitForJob(job.jobId, 30000);
    return parseBankrTrending(result.response);
  } catch (e) {
    console.warn('[signals] Bankr trending unavailable:', e.message);
    return [];
  }
}

function parseBankrTrending(text) {
  const signals = [];
  // Match patterns like "TOKEN: +12.3%" or "TOKEN (sym): +5.4% ($0.001)"
  const lines = text.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const pctMatch = line.match(/\*?\*?([A-Z]{2,10})\*?\*?.*?([+-]?\d+\.?\d*)%/i);
    if (pctMatch) {
      const symbol = pctMatch[1].toUpperCase();
      const pct = parseFloat(pctMatch[2]);
      signals.push({
        token: symbol,
        velocity: Math.abs(pct) / 10,  // normalize: 10% change = 1x velocity
        divergence: false,
        viral_class: pct > 10 ? 'BUILDING' : 'UNKNOWN',
        narrative: `${pct > 0 ? '+' : ''}${pct}% in recent period`,
        source: 'bankr_trending'
      });
    }
  }
  return signals.slice(0, 10);
}

/**
 * Fetch relevant Polymarket markets
 */
async function getPolymarketSignals() {
  try {
    const res = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=20&tag=crypto',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data || [])
      .filter(m => m.liquidity > 5000) // only liquid markets
      .map(m => ({
        id: m.conditionId,
        question: m.question,
        yes_price: parseFloat(m.outcomePrices?.[0] || 0.5),
        no_price: parseFloat(m.outcomePrices?.[1] || 0.5),
        volume: m.volume,
        liquidity: m.liquidity
      }))
      .slice(0, 5);
  } catch (e) {
    console.warn('[signals] Polymarket unavailable:', e.message);
    return [];
  }
}

/**
 * Aggregate all signals into one object for Venice
 */
async function gatherSignals(activeTrancheUsd = 50, openPositions = 0) {
  console.log('[signals] Gathering...');
  const [eth, btc, attention, polymarket] = await Promise.all([
    getEthPrice(),
    getBtcPrice(),
    getAttentionSignals(),
    getPolymarketSignals()
  ]);

  return {
    eth_price: eth.price,
    eth_price_updated: eth.updatedAt,
    btc_price: btc.price,
    btc_price_updated: btc.updatedAt,
    attention,
    polymarket,
    active_tranche_usd: activeTrancheUsd,
    open_positions: openPositions,
    timestamp: Date.now()
  };
}

module.exports = { gatherSignals, getEthPrice, getBtcPrice, calculateRSI };
