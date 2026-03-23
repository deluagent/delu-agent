require('dotenv').config({ path: '/data/workspace/delu-agent/.env' });
const bankr = require('/data/workspace/delu-agent/agent/bankr.js');

async function main() {
  console.log('Asking Bankr for best yield on Base...');
  try {
    const response = await bankr.getYieldPools();
    console.log('\nResponse:\n', response);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
