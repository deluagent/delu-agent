// backtest/warm_cache_30.js
const { fetchDailyHistory, GECKO_TERMINAL_FALLBACK } = require('./fetch.js');

const TOKENS = [
  'BTC','ETH','SOL','BNB','DOGE','AAVE','ARB',
  'OP','MATIC','LINK','UNI','LTC','BCH','FIL',
  'ETC','XLM','NEAR','APT','INJ','RNDR',
  'PEPE','SHIB','WIF','FLOKI','BONK','FET',
  'AGIX','OCEAN','IMX','STX',
  // Base specific (from agent list)
  'BRETT','DEGEN','AERO','VIRTUAL','CLANKER','ODAI','JUNO','FELIX','CLAWD','CLAWNCH'
];

async function main() {
  console.log(`Warming cache for ${TOKENS.length} tokens...`);
  for (const sym of TOKENS) {
    process.stdout.write(`Fetching ${sym}... `);
    try {
      if (GECKO_TERMINAL_FALLBACK[sym]) {
        // Use GT fetcher directly (fetch.js handles this routing internally? No, we need to call fetchGeckoTerminal)
        // Actually fetch.js exports fetchGeckoTerminal, let's use it.
        const { fetchGeckoTerminal } = require('./fetch.js');
        await fetchGeckoTerminal(sym, 365);
      } else {
        await fetchDailyHistory(sym); 
      }
      console.log('✓');
    } catch (e) {
      console.log(`✗ (${e.message})`);
    }
    await new Promise(r => setTimeout(r, 1000)); // Rate limit
  }
}

main();
