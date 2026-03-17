/**
 * Agent State Machine
 * SCANNING → SIGNAL_DETECTED → CONFIRMING → ENTERING → MANAGING → EXITING
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/state.json');

const STATES = {
  SCANNING: 'SCANNING',
  SIGNAL_DETECTED: 'SIGNAL_DETECTED',
  CONFIRMING: 'CONFIRMING',
  ENTERING: 'ENTERING',
  MANAGING: 'MANAGING',
  EXITING: 'EXITING'
};

const ALLOWED_TRANSITIONS = {
  SCANNING:         ['SIGNAL_DETECTED'],
  SIGNAL_DETECTED:  ['CONFIRMING', 'SCANNING'],    // confirm or dismiss
  CONFIRMING:       ['ENTERING', 'SCANNING'],       // enter or abort
  ENTERING:         ['MANAGING'],
  MANAGING:         ['EXITING', 'MANAGING'],        // stay or exit
  EXITING:          ['SCANNING']
};

function loadState() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) return defaultState();
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function defaultState() {
  return {
    current: STATES.SCANNING,
    position: null,          // { token, entry_price, size_usd, entry_time, stop_loss, take_profit }
    session_pnl: 0,          // USD P&L this session
    session_start: Date.now(),
    daily_pnl: 0,            // USD P&L today
    halted: false,           // circuit breaker tripped
    halt_reason: null,
    history: []              // past state transitions
  };
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function transition(fromState, toState, reason = '') {
  if (!ALLOWED_TRANSITIONS[fromState]?.includes(toState)) {
    throw new Error(`Invalid transition: ${fromState} → ${toState}`);
  }
  const state = loadState();
  state.history.push({
    from: fromState,
    to: toState,
    reason,
    timestamp: new Date().toISOString()
  });
  state.current = toState;
  saveState(state);
  console.log(`[state] ${fromState} → ${toState}${reason ? ' (' + reason + ')' : ''}`);
  return state;
}

function getState() {
  return loadState();
}

function setPosition(position) {
  const state = loadState();
  state.position = position;
  saveState(state);
}

function clearPosition() {
  const state = loadState();
  state.position = null;
  saveState(state);
}

function recordPnL(pnlUsd) {
  const state = loadState();
  state.session_pnl += pnlUsd;
  state.daily_pnl += pnlUsd;
  saveState(state);
  return state;
}

// ─── Circuit Breaker ────────────────────────────────────────────

const MAX_DAILY_DRAWDOWN_PCT = 0.15;  // 15% max daily loss
const MAX_SESSION_LOSS_USD = 2.00;    // hard stop: $2 loss in one session

function checkCircuitBreaker(portfolioValue) {
  const state = loadState();
  if (state.halted) return { halted: true, reason: state.halt_reason };

  const drawdownPct = Math.abs(state.daily_pnl) / portfolioValue;

  if (state.daily_pnl < 0 && drawdownPct > MAX_DAILY_DRAWDOWN_PCT) {
    state.halted = true;
    state.halt_reason = `Daily drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds ${MAX_DAILY_DRAWDOWN_PCT * 100}% limit`;
    saveState(state);
    console.error('[circuit breaker] HALTED:', state.halt_reason);
    return { halted: true, reason: state.halt_reason };
  }

  if (state.session_pnl < -MAX_SESSION_LOSS_USD) {
    state.halted = true;
    state.halt_reason = `Session loss $${Math.abs(state.session_pnl).toFixed(2)} exceeds $${MAX_SESSION_LOSS_USD} limit`;
    saveState(state);
    console.error('[circuit breaker] HALTED:', state.halt_reason);
    return { halted: true, reason: state.halt_reason };
  }

  return { halted: false };
}

function resetCircuitBreaker() {
  const state = loadState();
  state.halted = false;
  state.halt_reason = null;
  state.daily_pnl = 0;
  state.session_pnl = 0;
  state.session_start = Date.now();
  saveState(state);
  console.log('[circuit breaker] Reset');
}

module.exports = {
  STATES,
  transition,
  getState,
  setPosition,
  clearPosition,
  recordPnL,
  checkCircuitBreaker,
  resetCircuitBreaker
};
