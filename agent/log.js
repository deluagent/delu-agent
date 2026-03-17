/**
 * Allocation logger
 * Writes decisions to local JSON log + (eventually) submits hash onchain
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_FILE = path.join(__dirname, '../data/allocations.json');

function ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadLog() {
  ensureDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
}

function saveLog(entries) {
  ensureDir();
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}

/**
 * Record a decision
 */
function record(signals, decision, execution) {
  const log = loadLog();

  const entry = {
    id: log.length,
    timestamp: new Date().toISOString(),
    signals_hash: hashObject(signals),
    decision: {
      action: decision.action,
      asset: decision.asset,
      size_pct: decision.size_pct,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      stop_loss_pct: decision.stop_loss_pct,
      take_profit_pct: decision.take_profit_pct
    },
    tee_proof: decision.tee_quote ? {
      quote: decision.tee_quote.slice(0, 64) + '...',  // truncate for readability
      full_hash: hashObject(decision.tee_quote)
    } : null,
    execution: execution || null,
    outcome: null,  // filled in later during REFLECT
    signals_snapshot: {
      eth_price: signals.eth_price,
      btc_price: signals.btc_price,
      attention_count: signals.attention?.length || 0,
      top_attention: signals.attention?.[0]?.token || null
    }
  };

  log.push(entry);
  saveLog(log);
  console.log(`[log] Recorded allocation #${entry.id}: ${entry.decision.action} ${entry.decision.asset} (${entry.decision.confidence}% confidence)`);
  return entry;
}

/**
 * Update outcome for a past entry
 */
function updateOutcome(id, outcome) {
  const log = loadLog();
  const entry = log.find(e => e.id === id);
  if (!entry) throw new Error(`Entry ${id} not found`);
  entry.outcome = outcome;
  saveLog(log);
  return entry;
}

function getAll() { return loadLog(); }
function getRecent(n = 20) { return loadLog().slice(-n); }

function stats() {
  const log = loadLog();
  const resolved = log.filter(e => e.outcome !== null);
  const correct = resolved.filter(e => e.outcome?.correct === true);
  return {
    total: log.length,
    resolved: resolved.length,
    correct: correct.length,
    accuracy: resolved.length ? Math.round((correct.length / resolved.length) * 100) : 0
  };
}

function hashObject(obj) {
  return crypto.createHash('sha256')
    .update(typeof obj === 'string' ? obj : JSON.stringify(obj))
    .digest('hex');
}

module.exports = { record, updateOutcome, getAll, getRecent, stats };
