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

async function waitForJob(jobId, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(3000);
    const res = await fetch(`${BANKR_API}/agent/job/${jobId}`, {
      headers: { 'X-API-Key': process.env.BANKR_API_KEY }
    });
    const data = await res.json();
    if (data.status === 'completed') return data;
    if (data.status === 'failed') throw new Error(`Bankr job failed: ${data.response}`);
  }
  throw new Error(`Bankr job timed out: ${jobId}`);
}

async function execute(decision, activeTrancheUsd) {
  const sizeUsd = Math.floor((decision.size_pct / 100) * activeTrancheUsd);

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { prompt, waitForJob, execute, getPrice, getYieldPools, getBalances };
