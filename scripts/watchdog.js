#!/usr/bin/env node
/**
 * watchdog.js — monitors all delu processes, restarts dead ones every 10 min
 * Logs to /tmp/watchdog.log
 */
'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DIR      = path.join(__dirname, '..');
const INTERVAL = 10 * 60 * 1000; // 10 min
const LOG      = '/tmp/watchdog.log';

const PROCESSES = [
  { name: 'Agent',   match: 'index.js --loop',        cmd: 'node agent/index.js --loop',                   log: '/tmp/agent.log'               },
  { name: 'Daily',   match: 'autoresearch/loop.js',   cmd: 'node -r dotenv/config autoresearch/loop.js',   log: '/tmp/autoresearch.log'         },
  { name: 'Hourly',  match: 'loop_hourly.js',         cmd: 'node -r dotenv/config autoresearch/loop_hourly.js', log: '/tmp/autoresearch_hourly.log' },
  { name: '5m',      match: 'loop_5m.js',             cmd: 'node -r dotenv/config autoresearch/loop_5m.js', log: '/tmp/autoresearch_5m.log'      },
  { name: 'Onchain', match: 'loop_onchain.js',        cmd: 'node -r dotenv/config autoresearch/loop_onchain.js', log: '/tmp/autoresearch_onchain.log'},
];

const EXP_FILES = [
  { name: 'Daily',   file: 'autoresearch/experiments.json',         metric: 'valSharpe', alertAt: null  },
  { name: 'Hourly',  file: 'autoresearch/experiments_hourly.json',  metric: 'score',     alertAt: 10    },
  { name: '5m',      file: 'autoresearch/experiments_5m.json',      metric: 'score',     alertAt: 35    },
  { name: 'Onchain', file: 'autoresearch/experiments_onchain.json', metric: 'score',     alertAt: 25    },
];

function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19).replace('T',' ')} UTC] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

function isRunning(match) {
  try {
    const out = execSync(`pgrep -f "${match}"`, { encoding: 'utf8' }).trim();
    return out.length > 0;
  } catch { return false; }
}

function killDuplicates(match) {
  try {
    const pids = execSync(`pgrep -f "${match}"`, { encoding: 'utf8' }).trim().split('\n').map(Number).filter(Boolean).sort((a,b)=>a-b);
    if (pids.length > 1) {
      const toKill = pids.slice(0, -1);
      log(`🔪 Duplicate ${match} — killing old PIDs: ${toKill.join(',')}`);
      execSync(`kill -9 ${toKill.join(' ')}`, { stdio: 'ignore' });
    }
  } catch {}
}

function restart(proc) {
  log(`⚠️  ${proc.name} DEAD — restarting`);
  try {
    const logStream = fs.openSync(proc.log, 'a');
    const child = spawn('bash', ['-c', proc.cmd], {
      cwd: DIR,
      detached: true,
      stdio: ['ignore', logStream, logStream],
      env: { ...process.env, ...require('dotenv').config({ path: path.join(DIR, '.env') }).parsed },
    });
    child.unref();
    setTimeout(() => {
      if (isRunning(proc.match)) log(`✅ ${proc.name} restarted OK (PID ${child.pid})`);
      else log(`❌ ${proc.name} failed to restart`);
    }, 3000);
  } catch(e) {
    log(`❌ ${proc.name} restart error: ${e.message.slice(0,60)}`);
  }
}

function checkExperiments() {
  EXP_FILES.forEach(({ name, file, metric, alertAt }) => {
    try {
      const exps = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
      const acc  = exps.filter(e => e.accepted);
      const best = acc.length ? Math.max(...acc.map(e => e[metric] || e.score || 0)) : 0;
      log(`📊 ${name.padEnd(8)} ${exps.length} exp | best: ${best.toFixed(2)}`);
      if (alertAt && best > alertAt) {
        log(`🚨 BREAKTHROUGH: ${name} best=${best.toFixed(2)} exceeded ${alertAt}!`);
      }
    } catch(e) {
      log(`⚠️  ${name} experiments read error: ${e.message.slice(0,40)}`);
    }
  });
}

function run() {
  log('═══ Watchdog check ═══');

  // Kill duplicates first
  PROCESSES.forEach(p => killDuplicates(p.match));

  // Check and restart dead processes
  PROCESSES.forEach(p => {
    if (!isRunning(p.match)) restart(p);
  });

  // Log experiment progress
  checkExperiments();

  log('✓ done');
}

// Run immediately then every 10 min
run();
setInterval(run, INTERVAL);

log('Watchdog started — checking every 10 min');
