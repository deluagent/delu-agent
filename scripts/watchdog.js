#!/usr/bin/env node
/**
 * watchdog.js — monitors all delu processes, restarts dead ones every 5 min
 * SAFE MODE: never kills a running process unless there are 3+ instances
 * Logs to /tmp/watchdog.log
 */
'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DIR      = path.join(__dirname, '..');
const INTERVAL = 5 * 60 * 1000; // 5 min (was 10)
const LOG      = '/tmp/watchdog.log';

const PROCESSES = [
  { name: 'Agent',   match: 'index.js --loop',             cmd: 'node agent/index.js --loop',                        log: '/tmp/agent.log'               },
  { name: 'Fusion',  match: 'loop_fusion.js',               cmd: 'node -r dotenv/config autoresearch/loop_fusion.js', log: '/tmp/autoresearch_fusion.log'  },
  { name: 'Hourly',  match: 'loop_hourly.js',              cmd: 'node -r dotenv/config autoresearch/loop_hourly.js', log: '/tmp/autoresearch_hourly.log'  },
  { name: '5m',      match: 'loop_5m.js',                  cmd: 'node -r dotenv/config autoresearch/loop_5m.js',     log: '/tmp/autoresearch_5m.log'      },
  { name: 'Onchain', match: 'loop_onchain.js',             cmd: 'node -r dotenv/config autoresearch/loop_onchain.js',log: '/tmp/autoresearch_onchain.log' },
  { name: 'Stops',   match: 'loop_stops.js',               cmd: 'node -r dotenv/config autoresearch/loop_stops.js',  log: '/tmp/autoresearch_stops.log'   },
  { name: 'Prices',  match: 'price_updater.js',            cmd: 'node -r dotenv/config agent/price_updater.js',      log: '/tmp/price_updater.log'        },
];

const EXP_FILES = [
  { name: 'Fusion',  file: 'autoresearch/experiments_fusion.json',   metric: 'score',     alertAt: 8   },
  { name: 'Hourly',  file: 'autoresearch/experiments_hourly.json',  metric: 'score',     alertAt: 12  },
  { name: '5m',      file: 'autoresearch/experiments_5m.json',      metric: 'score',     alertAt: 35  },
  { name: 'Onchain', file: 'autoresearch/experiments_onchain.json', metric: 'score',     alertAt: 25  },
  { name: 'Stops',   file: 'autoresearch/experiments_stops.json',  metric: 'score',     alertAt: 8   },
];

function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19).replace('T',' ')} UTC] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

function getPids(match) {
  try {
    return execSync(`pgrep -f "${match}"`, { encoding: 'utf8' })
      .trim().split('\n').map(Number).filter(Boolean).sort((a,b) => a-b);
  } catch { return []; }
}

function isRunning(match) {
  return getPids(match).length > 0;
}

// SAFE: only kill extras if there are 3+ instances (1-2 is fine, could be mid-restart)
function killExcessDuplicates(proc) {
  const pids = getPids(proc.match);
  if (pids.length >= 3) {
    // Keep the 2 newest, kill the rest
    const toKill = pids.slice(0, -2);
    log(`⚠️  ${proc.name} has ${pids.length} instances — killing oldest: ${toKill.join(',')}`);
    try { execSync(`kill ${toKill.join(' ')}`, { stdio: 'ignore' }); } catch {}
  }
}

function restart(proc) {
  log(`🔴 ${proc.name} is DOWN — restarting now`);
  try {
    const logStream = fs.openSync(proc.log, 'a');
    const env = { ...process.env };
    // Load .env vars
    try {
      const envFile = fs.readFileSync(path.join(DIR, '.env'), 'utf8');
      envFile.split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      });
    } catch {}

    const child = spawn('node', proc.cmd.replace(/^node\s+/, '').split(' '), {
      cwd: DIR,
      detached: true,
      stdio: ['ignore', logStream, logStream],
      env,
    });
    child.unref();

    // Verify after 5 seconds
    setTimeout(() => {
      if (isRunning(proc.match)) {
        log(`✅ ${proc.name} restarted OK (PID ${child.pid})`);
      } else {
        log(`❌ ${proc.name} FAILED to restart — will retry next check`);
      }
    }, 5000);
  } catch(e) {
    log(`❌ ${proc.name} restart error: ${e.message.slice(0,80)}`);
  }
}

function checkExperiments() {
  EXP_FILES.forEach(({ name, file, metric, alertAt }) => {
    try {
      const exps = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
      const acc  = exps.filter(e => e.accepted || e.improved);
      const best = acc.length ? Math.max(...acc.map(e => e[metric] || e.score || 0)) : 0;
      log(`📊 ${name.padEnd(8)} ${exps.length.toLocaleString()} exp | best: ${best.toFixed(2)}`);
      if (alertAt && best > alertAt) {
        log(`🚨 BREAKTHROUGH: ${name} best=${best.toFixed(2)} exceeded ${alertAt}!`);
      }
    } catch(e) {
      log(`⚠️  ${name} exp file error: ${e.message.slice(0,40)}`);
    }
  });
}

function run() {
  log('━━━ watchdog check ━━━');

  // Step 1: kill excess duplicates ONLY (3+ instances = something wrong)
  PROCESSES.forEach(killExcessDuplicates);

  // Step 2: restart anything that's dead (0 instances)
  PROCESSES.forEach(p => {
    if (!isRunning(p.match)) {
      restart(p);
    } else {
      const count = getPids(p.match).length;
      log(`✅ ${p.name.padEnd(8)} running${count > 1 ? ` (${count} instances)` : ''}`);
    }
  });

  // Step 3: log experiment progress
  checkExperiments();

  log('━━━ done ━━━');
}

// Run immediately, then every 5 min
log('Watchdog v2 starting — safe mode, 5min interval');
run();
setInterval(run, INTERVAL);

// Self-healing: if watchdog itself crashes, Node will exit and OS won't restart it
// So we catch unhandled rejections and keep going
process.on('uncaughtException', e => log(`⚠️  uncaughtException: ${e.message.slice(0,80)}`));
process.on('unhandledRejection', e => log(`⚠️  unhandledRejection: ${String(e).slice(0,80)}`));
