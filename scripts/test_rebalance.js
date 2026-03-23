require('dotenv').config({ path: '/data/workspace/delu-agent/.env' });
const bankr = require('/data/workspace/delu-agent/agent/bankr.js');

async function main() {
  console.log('Testing Smart Yield Rebalance command...');
  const prompt = "Compare my current Aave position yield vs Morpho on Base. If Morpho is > 1% higher, move my funds. If not, do nothing. Report the decision.";
  
  try {
    const job = await bankr.prompt(prompt);
    console.log(`Job ID: ${job.jobId}`);
    const result = await bankr.waitForJob(job.jobId);
    console.log('\nResponse:\n', result.response);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
