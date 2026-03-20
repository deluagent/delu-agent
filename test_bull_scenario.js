/**
 * test_bull_scenario.js
 * Simulates a BULL market to force the agent to generate BUY signals.
 * Uses real agent logic but injected mock data.
 */

require('dotenv').config({ path: '/data/workspace/delu-agent/.env' });
const { fetchBinanceHourly } = require('./backtest/fetch.js'); // reuse real fetcher for shape
const signals = require('./agent/signals.js'); // we'll need to extract logic or mock it
// Actually, easier to just import the functions from index.js if exported, 
// or copy the core logic here for a standalone test.

// Let's replicate the core loop logic to test the signal generation
const bankr = require('./agent/bankr.js');

// Mock data: 200 days of bullish prices
function generateBullishBars(symbol, days=220) {
  const bars = [];
  let price = 100;
  for(let i=0; i<days*24; i++) {
    // Uptrend: +0.1% per hour random walk
    price = price * (1 + (Math.random() * 0.002)); 
    bars.push({
      time: new Date(Date.now() - (days*24 - i)*3600*1000),
      close: price,
      volume: 1000000 + Math.random() * 500000
    });
  }
  return bars;
}

// Mock regime detection
const MOCK_REGIME = {
  state: 'BULL_HOT',
  btcNow: 150,
  pctFrom200: 0.20, // +20% above MA
  volRatio: 0.8,    // Low vol (stable trend)
  breadthFraction: '17/17'
};

// Mock signal scoring
const MOCK_SCORES = [
  { sym: 'BRETT', sA: 0.8, sB: 0.2, sC: 0.9, sD: 0, sAR: 0.5, combined: 0.85, template: 'A' },
  { sym: 'DEGEN', sA: 0.7, sB: 0.3, sC: 0.8, sD: 0, sAR: 0.4, combined: 0.75, template: 'A' },
  { sym: 'ETH',   sA: 0.6, sB: 0.1, sC: 0.7, sD: 0, sAR: 0.3, combined: 0.65, template: 'C' }
];

async function runSimulation() {
  console.log('--- SIMULATION: BULL MARKET ---');
  console.log('Injected: BTC +20% above MA, Breadth 100%');
  
  // 1. Screen (Bankr LLM)
  console.log('\n[Layer 1] Bankr LLM Screen...');
  // We'll call the REAL Bankr LLM with our mock data to see if it approves
  const prompt = `Market regime: BULL_HOT
BTC 20.0% above 200d MA | breadth: 1.00 | volRatio: 0.80

Signal scores:
BRETT: combined=0.850 [A=0.80 B=0.20 C=0.90 D=0.00]
DEGEN: combined=0.750 [A=0.70 B=0.30 C=0.80 D=0.00]
ETH: combined=0.650 [A=0.60 B=0.10 C=0.70 D=0.00]

Are any tokens worth deeper analysis? JSON only.`;

  console.log('Prompting Bankr LLM (gemini-2.5-flash)...');
  const screenRes = await fetch('https://llm.bankr.bot/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.BANKR_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const screenData = await screenRes.json();
  console.log('Screen Response:', screenData.choices[0].message.content);

  // 2. Reason (Venice)
  console.log('\n[Layer 2] Venice Reason (mocking context)...');
  // We'll assume screen passed BRETT. 
  // Let's ask Venice what to do.
  const venicePrompt = `You are delu. Market is BULL_HOT. 
Top candidate: BRETT (Template A - Trend). Score 0.85.
Portfolio: $1000 USDC.
Decision? JSON.`;

  console.log('Prompting Venice (llama-3.3-70b)...');
  const veniceRes = await fetch('https://api.venice.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b',
      messages: [{ role: 'system', content: venicePrompt }],
      venice_parameters: { enable_e2ee: true }
    })
  });
  const veniceData = await veniceRes.json();
  console.log('Venice Response:', veniceData.choices[0].message.content);
}

runSimulation();
