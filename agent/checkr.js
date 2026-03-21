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

  const privateKey = fs.readFileSync('/home/openclaw/.x402_key', 'utf8').trim();
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
  console.log('[checkr] Fetching spikes (~$0.05)...');
  return checkrGet(`/v1/spikes?min_velocity=${minVelocity}`);
}

async function getLeaderboard(limit = 10) {
  console.log('[checkr] Fetching leaderboard (~$0.02)...');
  return checkrGet(`/v1/leaderboard?limit=${limit}`);
}

async function getToken(symbol) {
  console.log(`[checkr] Deep dive: ${symbol} (~$0.50)...`);
  return checkrGet(`/v1/token/${symbol}`);
}

async function getRotation(hours = 4) {
  console.log(`[checkr] Fetching rotation (${hours}h window, ~$0.10)...`);
  return checkrGet(`/v1/rotation?hours=${hours}`);
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
 * Parse rotation response into attention map entries
 * Returns { SYM: { rotationGain, rotationRank, rotatingFrom, rotatingTo } }
 */
function parseRotation(data) {
  const map = {};
  if (!data) return map;

  // Top gainers — tokens receiving attention rotation
  if (data.gainers) {
    data.gainers.forEach((t, idx) => {
      const sym = (t.symbol || '').toUpperCase();
      map[sym] = {
        rotationGain:  t.ATT_delta || t.delta || 0,
        rotationRank:  idx + 1,
        isGainer:      true,
        rotatingFrom:  t.rotating_from || [],
        narrative:     t.narrative_summary || null,
      };
    });
  }

  // Top losers — tokens bleeding attention (avoid or short signal)
  if (data.losers) {
    data.losers.forEach((t, idx) => {
      const sym = (t.symbol || '').toUpperCase();
      if (!map[sym]) map[sym] = {};
      map[sym].rotationLoss = Math.abs(t.ATT_delta || t.delta || 0);
      map[sym].isLoser      = true;
      map[sym].rotationRank = idx + 1;
    });
  }

  return map;
}

module.exports = { getSpikes, getLeaderboard, getToken, getRotation, getBankrAgents, parseSpikes, parseRotation };
