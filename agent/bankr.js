/**
 * Bankr execution layer
 * Translates Venice decisions into Bankr API calls.
 */

const BANKR_API = 'https://api.bankr.bot';

async function prompt(text, threadId = null) {
  const body = { prompt: text };
  if (threadId) body.threadId = threadId;

  const res = await fetch(`${BANKR_API}/agent/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.BANKR_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Bankr submit error: ${res.status}`);
  return res.json(); // { jobId, threadId, status }
}

async function waitForJob(jobId, maxWaitMs = 300000) {
  // Default 5min — DeFi multi-step jobs (yield rebalance, position checks) can take 60-90s
  // Simple queries (price checks) complete in ~10s
  const start = Date.now();
  let pollInterval = 3000;
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollInterval);
    const res = await fetch(`${BANKR_API}/agent/job/${jobId}`, {
      headers: { 'X-API-Key': process.env.BANKR_API_KEY }
    });
    const data = await res.json();
    if (data.status === 'completed') return data;
    if (data.status === 'failed') throw new Error(`Bankr job failed: ${data.response}`);
    // Back off polling after 30s to reduce API load
    if (Date.now() - start > 30000) pollInterval = 5000;
  }
  throw new Error(`Bankr job timed out after ${maxWaitMs/1000}s: ${jobId}`);
}

async function execute(decision, activeTrancheUsd) {
  // Keep 2 decimal places — Math.floor on small tranches gives $0
  const sizeUsd = Math.round((decision.size_pct / 100) * activeTrancheUsd * 100) / 100;

  let bankrPrompt;

  switch (decision.action) {
    case 'buy':
      bankrPrompt = `swap $${sizeUsd} USDC to ${decision.asset} on Base`;
      if (decision.stop_loss_pct) {
        bankrPrompt += ` with ${decision.stop_loss_pct}% stop loss`;
      }
      break;

    case 'sell':
      bankrPrompt = `sell all my ${decision.asset} on Base`;
      break;

    case 'yield':
      bankrPrompt = `deposit $${sizeUsd} USDC to Aave v3 on Base`;
      break;

    case 'polymarket_yes':
      bankrPrompt = `bet $${Math.min(sizeUsd, 20)} YES on "${decision.asset}" on Polymarket`;
      break;

    case 'polymarket_no':
      bankrPrompt = `bet $${Math.min(sizeUsd, 20)} NO on "${decision.asset}" on Polymarket`;
      break;

    case 'hold':
      return { skipped: true, reason: 'hold — no action needed' };

    default:
      return { skipped: true, reason: `unknown action: ${decision.action}` };
  }

  console.log(`[bankr] Executing: "${bankrPrompt}"`);
  const job = await prompt(bankrPrompt);
  const result = await waitForJob(job.jobId);

  return {
    jobId: job.jobId,
    prompt: bankrPrompt,
    response: result.response,
    completedAt: result.completedAt
  };
}

async function getPrice(token) {
  const job = await prompt(`what is the price of ${token}?`);
  const result = await waitForJob(job.jobId);
  // Parse price from response like "eth is currently $2,363.03"
  const match = result.response.match(/\$([0-9,]+\.?\d*)/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

async function getYieldPools() {
  const job = await prompt('what are the best USDC yield pools on Base right now? show APY and TVL');
  const result = await waitForJob(job.jobId);
  return result.response;
}

async function getBalances() {
  const job = await prompt('what are my token balances on Base?');
  const result = await waitForJob(job.jobId);
  return result.response;
}

async function smartYieldRebalance() {
  // Two-step: first read current state, then decide + execute if warranted
  // Step 1: check current position vs best available
  const checkJob = await prompt(
    `What are my current stablecoin yield positions on Base? ` +
    `Compare to the best available USDC rates on Aave v3, Morpho, and Moonwell. ` +
    `Report: current protocol, current APY, best available APY, and the difference.`
  );
  const checkResult = await waitForJob(checkJob.jobId);
  console.log(`[bankr] Yield check:\n${checkResult.response}`);

  // Parse APY delta from response — look for a move if >1% better exists
  const response = checkResult.response.toLowerCase();

  // Pattern 1: "difference: +1.84%" or "difference: 1.84%"
  const diffMatch = response.match(/difference[:\s*]+\+?(\d+\.?\d*)\s*%/);
  // Pattern 2: "X% higher/better/more"
  const relMatch = response.match(/\+?(\d+\.?\d*)\s*%\s*(higher|better|more|improvement|increase)/);
  // Pattern 3: "increase by X%" or "improve by X%"
  const increaseMatch = response.match(/(?:increase|improve).*?by.*?\+?(\d+\.?\d*)\s*%/);
  // Pattern 4: compute from best vs current APY values in text
  const apyValues = [...response.matchAll(/(\d+\.?\d*)\s*%/g)].map(m => parseFloat(m[1]));
  const computedDelta = apyValues.length >= 2 ? Math.max(...apyValues) - apyValues.find(v => v === Math.min(...apyValues.filter(x => x > 0)) || v > 0) : 0;

  const bestDelta = Math.max(
    diffMatch    ? parseFloat(diffMatch[1])    : 0,
    relMatch     ? parseFloat(relMatch[1])     : 0,
    increaseMatch? parseFloat(increaseMatch[1]): 0,
  );

  if (bestDelta < 1.0) {
    console.log(`[bankr] Yield delta ${bestDelta.toFixed(2)}% — below 1% threshold, staying put`);
    return `No rebalance needed. Best available is only ${bestDelta.toFixed(2)}% better than current position.\n\n${checkResult.response}`;
  }

  // Step 2: execute the rebalance
  console.log(`[bankr] ${bestDelta.toFixed(2)}% yield improvement found — rebalancing`);
  const moveJob = await prompt(
    `Move all my USDC from my current yield position to the highest APY vault available on Base ` +
    `(Aave v3, Morpho, or Moonwell). Execute the withdrawal and deposit now.`
  );
  const moveResult = await waitForJob(moveJob.jobId);
  return `Rebalanced (+${bestDelta.toFixed(2)}% APY).\n\n${moveResult.response}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { prompt, waitForJob, execute, getPrice, getYieldPools, getBalances, smartYieldRebalance };
