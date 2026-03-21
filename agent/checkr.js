/**
 * Checkr x402 client — using official @x402/axios + @x402/evm
 * Reads payment-required header correctly (official Coinbase implementation)
 */

const axios = require('axios');
const { wrapAxiosWithPayment } = require('@x402/axios');
const { x402Client } = require('@x402/core/client');
const { x402HTTPClient } = require('@x402/core/http');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { toClientEvmSigner } = require('@x402/evm');
const { privateKeyToAccount } = require('viem/accounts');
const fs = require('fs');

const CHECKR_BASE = 'https://api.checkr.social';

let _client = null;

function getClient() {
  if (_client) return _client;

  // Try file first, fall back to env var X402_PRIVATE_KEY
  let privateKey;
  try {
    privateKey = fs.readFileSync('/home/openclaw/.x402_key', 'utf8').trim();
  } catch {
    privateKey = process.env.X402_PRIVATE_KEY || '';
  }
  if (!privateKey) throw new Error('x402 key not found — set X402_PRIVATE_KEY in .env or restore /home/openclaw/.x402_key');
  const account = privateKeyToAccount(privateKey);
  const signer = toClientEvmSigner(account);

  const coreClient = new x402Client()
    .register('eip155:*', new ExactEvmScheme(signer));

  const httpClient = new x402HTTPClient(coreClient);
  const axiosInstance = wrapAxiosWithPayment(axios.create(), httpClient);

  _client = axiosInstance;
  return _client;
}

async function checkrGet(path) {
  const client = getClient();
  const { data } = await client.get(`${CHECKR_BASE}${path}`);
  return data;
}

// ─── Public API ───────────────────────────────────────────────

async function getSpikes(minVelocity = 2.0) {
  // Use 1h window + min_mentions for freshness — catches newest spikes only
  console.log('[checkr] Fetching spikes 1h (~$0.05)...');
  return checkrGet(`/v1/spikes?min_velocity=${minVelocity}&min_mentions=3`);
}

async function getLeaderboard(limit = 10) {
  // 1h window, sorted by ATT_delta (who's growing fastest right now)
  console.log('[checkr] Fetching leaderboard 1h sorted by growth (~$0.02)...');
  return checkrGet(`/v1/leaderboard?limit=${limit}&hours=1&sort_by=ATT_delta`);
}

async function getToken(symbol) {
  console.log(`[checkr] Deep dive: ${symbol} (~$0.50)...`);
  return checkrGet(`/v1/token/${symbol}`);
}

async function getRotation(hours = 1) {
  // 1h window — tightest signal, real-time creator transitions
  console.log(`[checkr] Fetching rotation ${hours}h (~$0.10)...`);
  return checkrGet(`/v1/rotation?window=${hours}h`);
}

async function getBankrAgents(hours = 4) {
  console.log(`[checkr] Fetching bankr agents attention (~$0.05)...`);
  return checkrGet(`/v1/bankr?hours=${hours}`);
}

function parseSpikes(data) {
  if (!data?.spikes) return [];
  return data.spikes
    .filter(t => t.velocity >= 2.0)
    .map(t => ({
      token: t.symbol,
      velocity: t.velocity,
      divergence: t.divergence || false,
      viral_class: t.hawkes?.viral_class || 'UNKNOWN',
      narrative: t.narrative_summary || null,
      signal_type: t.signal_type || null,
      rotating_from: t.rotating_from || [],
    }))
    .slice(0, 10);
}

/**
 * Parse rotation response (new schema: nodes + edges directed graph)
 * Returns { SYM: { rotationGain, rotationRank, isGainer, isLoser, rotatingFrom, topCreator, attGrowth, netFlow } }
 *
 * New schema fields:
 *   nodes[].net_flow      — inflow minus outflow (positive = net gaining creators)
 *   nodes[].ATT_growth    — relative attention growth % over window
 *   nodes[].inflow        — unique creators arriving from other tokens
 *   nodes[].outflow       — unique creators leaving to other tokens
 *   edges[].from / .to    — directed creator transition
 *   edges[].weight        — number of distinct creators who made this transition
 *   edges[].top_creator   — highest-signal creator for this edge
 */
function parseRotation(data) {
  const map = {};
  if (!data) return map;

  // New schema: nodes array with confirmed rotation
  if (data.nodes && Array.isArray(data.nodes)) {
    // Sort by net_flow descending — highest net inflow = strongest rotation target
    const sorted = [...data.nodes].sort((a, b) => (b.net_flow || 0) - (a.net_flow || 0));

    sorted.forEach((node, idx) => {
      const sym = (node.symbol || '').toUpperCase();
      if (!sym) return;

      const netFlow   = node.net_flow    || 0;
      const attGrowth = node.ATT_growth  || 0;
      const inflow    = node.inflow      || 0;
      const outflow   = node.outflow     || 0;

      if (netFlow > 0) {
        // Net gainer — creators rotating IN
        map[sym] = {
          rotationGain:  attGrowth,          // ATT_growth % (e.g. 34.2 = +34.2%)
          rotationRank:  idx + 1,
          isGainer:      true,
          netFlow,
          inflow,
          outflow,
          attGrowth,
          rotatingFrom:  [],                 // populated from edges below
          topCreator:    null,               // populated from edges below
          narrative:     null,
        };
      } else if (netFlow < 0) {
        // Net loser — creators rotating OUT
        map[sym] = {
          rotationLoss:  Math.abs(attGrowth),
          rotationRank:  idx + 1,
          isLoser:       true,
          netFlow,
          inflow,
          outflow,
          attGrowth,
        };
      }
    });
  }

  // Legacy schema fallback (gainers/losers)
  if (!data.nodes && data.gainers) {
    (data.gainers || []).forEach((t, idx) => {
      const sym = (t.symbol || '').toUpperCase();
      map[sym] = {
        rotationGain:  t.ATT_delta || t.delta || t.ATT_growth || 0,
        rotationRank:  idx + 1,
        isGainer:      true,
        rotatingFrom:  t.rotating_from || [],
        narrative:     t.narrative_summary || null,
      };
    });
    (data.losers || []).forEach((t, idx) => {
      const sym = (t.symbol || '').toUpperCase();
      if (!map[sym]) map[sym] = {};
      map[sym].rotationLoss = Math.abs(t.ATT_delta || t.delta || 0);
      map[sym].isLoser      = true;
      map[sym].rotationRank = idx + 1;
    });
  }

  // Enrich from edges — add rotatingFrom sources and topCreator for each gainer
  if (data.edges && Array.isArray(data.edges)) {
    data.edges.forEach(edge => {
      const toSym   = (edge.to   || '').toUpperCase();
      const fromSym = (edge.from || '').toUpperCase();
      if (map[toSym]?.isGainer) {
        // Track which tokens are feeding this one
        if (!map[toSym].rotatingFrom) map[toSym].rotatingFrom = [];
        if (fromSym && !map[toSym].rotatingFrom.includes(fromSym)) {
          map[toSym].rotatingFrom.push(fromSym);
        }
        // Keep highest-weight edge's top_creator
        const w = edge.weight || 0;
        if (!map[toSym].topCreator || w > (map[toSym]._topWeight || 0)) {
          map[toSym].topCreator   = edge.top_creator || null;
          map[toSym]._topWeight   = w;
          map[toSym].edgeWeight   = w;
        }
      }
    });
    // Clean up internal field
    Object.values(map).forEach(v => delete v._topWeight);
  }

  return map;
}

module.exports = { getSpikes, getLeaderboard, getToken, getRotation, getBankrAgents, parseSpikes, parseRotation };
