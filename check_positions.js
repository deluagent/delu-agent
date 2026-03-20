require('dotenv').config({ path: '/data/workspace/delu-agent/.env' });
const bankr = require('/data/workspace/delu-agent/agent/bankr.js');

async function main() {
  console.log('Checking yield positions...');
  try {
    // Ask specifically for protocol positions
    const job = await bankr.prompt('What are my positions in Aave, Moonwell, and Morpho on Base? Show amounts.');
    const result = await bankr.waitForJob(job.jobId);
    console.log('\nResponse:\n', result.response);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
