#!/usr/bin/env node
// Pre-warm 365d history cache for all tokens — run once, takes ~2min
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const f = require('./fetch');

const ALL = ['ETH','BTC','SOL','BNB','ARB','OP','LINK','AAVE','VIRTUAL','BRETT','DEGEN','AERO','CLANKER'];

async function warm() {
  console.log(`Warming cache for ${ALL.length} tokens (3s delay each)...\n`);
  for (const sym of ALL) {
    try {
      const bars = f.fetchDailyHistory(sym, true);
      if (bars) console.log(`✅ ${sym.padEnd(8)} ${bars.length} daily bars | ${bars[0].time.toISOString().slice(0,10)} → ${bars.at(-1).time.toISOString().slice(0,10)}`);
      else      console.log(`⚠️  ${sym.padEnd(8)} no CoinGecko ID`);
    } catch(e) {
      console.log(`❌ ${sym.padEnd(8)} ${e.message.slice(0,80)}`);
    }
    await new Promise(r => setTimeout(r, 12000));
  }
  console.log('\nDone. Cache stored in data/history/');
}

warm().catch(console.error);
