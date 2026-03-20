#!/usr/bin/env node
/**
 * trade_now.js — force a live trade cycle regardless of regime
 * Uses Venice to reason on current signals, executes via Bankr
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bankr = require('../agent/bankr');
const { fetchBinanceHourly } = require('../backtest/fetch');

const VENICE_API   = 'https://api.venice.ai/api/v1/chat/completions';
const VENICE_MODEL = 'llama-3.3-70b';

async function getSignals() {
  const tokens = ['ETH', 'SOL', 'BTC', 'AAVE', 'ARB'];
  const results = [];

  for (const sym of tokens) {
    try {
      const bars = await fetchBinanceHourly(sym, 500);
      if (!bars || bars.length < 100) continue;

      const closes  = bars.map(b => b.close);
      const volumes = bars.map(b => b.volume);
      const n       = closes.length;
      const last    = closes[n - 1];

      // RSI-14
      const rp = closes.slice(-15);
      let g = 0, l = 0;
      for (let i = 1; i < rp.length; i++) {
        const d = rp[i] - rp[i - 1];
        if (d > 0) g += d; else l += Math.abs(d);
      }
      const rsiVal = l === 0 ? 100 : Math.round(100 - 100 / (1 + g / 14 / (l / 14)));

      // Returns
      const r1h  = ((last - closes[n - 2])   / closes[n - 2]   * 100).toFixed(2);
      const r24h = ((last - closes[n - 25])  / closes[n - 25]  * 100).toFixed(2);
      const r7d  = ((last - closes[n - 169]) / closes[n - 169] * 100).toFixed(2);

      // ATR-14
      let atr = 0;
      for (let i = n - 14; i < n; i++) {
        const tr = Math.max(bars[i].high - bars[i].low,
          Math.abs(bars[i].high - closes[i - 1]),
          Math.abs(bars[i].low  - closes[i - 1]));
        atr = (atr * 13 + tr) / 14;
      }

      // Volume trend (last 4h vs 24h avg)
      const vol4h  = volumes.slice(-4).reduce((s, v) => s + v, 0) / 4;
      const vol24h = volumes.slice(-24).reduce((s, v) => s + v, 0) / 24;
      const volTrend = vol4h > vol24h ? 'rising' : 'falling';

      results.push({ sym, price: last, r1h, r24h, r7d, rsi: rsiVal, atrPct: (atr / last * 100).toFixed(2), volTrend });
    } catch (e) {
      console.warn(`  ${sym} fetch failed: ${e.message}`);
    }
  }
  return results;
}

async function askVenice(signals) {
  const lines = signals.map(s =>
    `  ${s.sym.padEnd(5)}: $${s.price.toFixed(2).padStart(9)} | 1h:${s.r1h.padStart(6)}% | 24h:${s.r24h.padStart(6)}% | 7d:${s.r7d.padStart(6)}% | RSI:${s.rsi} | ATR:${s.atrPct}% | vol:${s.volTrend}`
  ).join('\n');

  const prompt = `You are delu, an autonomous crypto trader on Base mainnet.
Current market: BEAR regime — BTC -3.1% below 200d MA, all tokens oversold (RSI 30-40).

Live signals:
${lines}

Portfolio: $48 USDC on Base. Max risk 15% per trade ($7.20 max).
Oversold RSI + stable volume = potential short-term bounce plays.
Only recommend a trade if confidence >= 65. Otherwise hold.

Return ONLY valid JSON (no markdown):
{"action":"buy","asset":"ETH","size_usd":7,"confidence":70,"reasoning":"one sentence","take_profit_pct":4,"stop_loss_pct":3}
or
{"action":"hold","asset":"USDC","size_usd":0,"confidence":0,"reasoning":"one sentence","take_profit_pct":0,"stop_loss_pct":0}`;

  const res = await fetch(VENICE_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:     VENICE_MODEL,
      messages:  [{ role: 'user', content: prompt }],
      venice_parameters: { enable_e2ee: true },
      temperature: 0.2,
      max_tokens:  200,
    }),
  });

  if (!res.ok) throw new Error(`Venice ${res.status}: ${await res.text()}`);
  const data    = await res.json();
  const content = data.choices[0].message.content.trim()
    .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(content);
}

async function main() {
  console.log('=== delu live trade cycle ===\n');

  console.log('[1] Fetching signals...');
  const signals = await getSignals();
  for (const s of signals) {
    console.log(`  ${s.sym.padEnd(5)}: $${s.price.toFixed(2).padStart(9)} | RSI:${s.rsi} | 24h:${s.r24h}% | 7d:${s.r7d}%`);
  }

  console.log('\n[2] Asking Venice (E2EE)...');
  const decision = await askVenice(signals);
  console.log(`\n[Venice] → ${decision.action.toUpperCase()} ${decision.asset}`);
  console.log(`  size: $${decision.size_usd} | confidence: ${decision.confidence}%`);
  console.log(`  reason: "${decision.reasoning}"`);
  console.log(`  TP: +${decision.take_profit_pct}% | SL: -${decision.stop_loss_pct}%`);

  if (decision.action === 'hold' || decision.confidence < 65) {
    console.log('\n[delu] HOLD — confidence below threshold or hold signal');
    return;
  }

  console.log(`\n[3] Executing: swap $${decision.size_usd} USDC → ${decision.asset} on Base...`);
  const job    = await bankr.prompt(`swap $${decision.size_usd} USDC for ${decision.asset} on Base`);
  console.log(`  Job: ${job.jobId}`);
  const result = await bankr.waitForJob(job.jobId);
  console.log(`\n[Bankr] ${result.response}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
