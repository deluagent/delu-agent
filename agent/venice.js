/**
 * Venice TEE reasoning layer
 * All allocation decisions flow through here.
 * Returns: { decision, confidence, reasoning, teeProof }
 */

const VENICE_API = 'https://api.venice.ai/api/v1/chat/completions';
const MODEL = 'llama-3.3-70b';

/**
 * Ask Venice to make an allocation decision.
 * @param {object} signals - { eth_price, btc_price, attention, rsi, polymarket }
 * @returns {object} { action, asset, size_pct, confidence, reasoning, tee_quote }
 */
async function reason(signals) {
  const prompt = buildPrompt(signals);

  const body = {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You are delu, an autonomous onchain allocator with skin in the game.
Your ETH is staked on every decision. Be disciplined. Be precise.
Respond ONLY with valid JSON in this exact format:
{
  "action": "buy" | "sell" | "yield" | "polymarket_yes" | "polymarket_no" | "hold",
  "asset": "string (token symbol or 'USDC')",
  "size_pct": number (0-30, percentage of active tranche),
  "confidence": number (0-100),
  "reasoning": "string (1-2 sentences max)",
  "stop_loss_pct": number (default 5),
  "take_profit_pct": number (default 15)
}`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    venice_parameters: {
      tee_mode: true
    },
    temperature: 0.3
  };

  const res = await fetch(VENICE_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Venice error: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const content = data.choices[0].message.content;
  const tee_quote = data.venice_extra_body?.tee_quote || null;

  let decision;
  try {
    decision = JSON.parse(content.trim());
  } catch {
    // If Venice returns markdown JSON, strip it
    const match = content.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    if (match) decision = JSON.parse(match[1]);
    else throw new Error(`Could not parse Venice response: ${content}`);
  }

  return {
    ...decision,
    tee_quote,
    model: MODEL,
    timestamp: Date.now()
  };
}

function buildPrompt(signals) {
  const lines = [
    '## Current Market Signals',
    '',
    `ETH price: $${signals.eth_price}`,
    `BTC price: $${signals.btc_price}`,
    `ETH RSI (14): ${signals.eth_rsi ?? 'unknown'}`,
    `ETH 24h change: ${signals.eth_change_24h ?? 'unknown'}%`,
    '',
    '## Social Attention (Checkr)',
  ];

  if (signals.attention?.length) {
    for (const a of signals.attention.slice(0, 5)) {
      lines.push(`  ${a.token}: velocity=${a.velocity}% weight=${a.weight} divergence=${a.divergence}`);
    }
  } else {
    lines.push('  No attention signals available');
  }

  lines.push('');
  lines.push('## Polymarket');
  if (signals.polymarket?.length) {
    for (const p of signals.polymarket.slice(0, 3)) {
      lines.push(`  "${p.question}": YES=${p.yes_price} NO=${p.no_price}`);
    }
  } else {
    lines.push('  No polymarket data available');
  }

  lines.push('');
  lines.push('## Current Portfolio');
  lines.push(`  Active tranche: $${signals.active_tranche_usd ?? 20} USDC available`);
  lines.push(`  Open positions: ${signals.open_positions ?? 0}`);
  lines.push('');
  lines.push('Based on these signals, what is your allocation decision?');
  lines.push('Remember: stake is at risk. Only act when confidence > 65%.');
  lines.push('When uncertain, choose action="yield" to keep funds in Aave.');

  return lines.join('\n');
}

module.exports = { reason };
