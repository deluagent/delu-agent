require('dotenv').config({ path: '/data/workspace/delu-agent/.env' });
const bankr = require('/data/workspace/delu-agent/agent/bankr.js');

async function main() {
  console.log('Checking balances...');
  try {
    const response = await bankr.getBalances();
    console.log('\nResponse:\n', response);
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
