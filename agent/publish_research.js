/**
 * publish_research.js — Publish autoresearch progress to delu-site
 *
 * Reads all three experiment logs and publishes a structured summary
 * that powers the "Autoresearch" section on the site.
 */

'use strict';

const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

const AGENT_DIR  = path.join(__dirname, '..');
const SITE_DIR   = '/data/workspace/delu-site';
const OUT_FILE   = path.join(SITE_DIR, 'public', 'data', 'research.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function buildLoopSummary(expsFile, stateFile, label) {
  const exps  = readJSON(expsFile, []);
  const state = readJSON(stateFile, {});

  if (!exps.length) return { label, total: 0, accepted: 0, bestVal: 0, bestCombined: 0, baseline: 0, progressSeries: [], acceptedExps: [] };

  const accepted = exps.filter(e => e.accepted);

  // Progress series — last 200 experiments for the chart (keep file small)
  const progressSeries = exps.slice(-200).map(e => ({
    n:        e.n,
    val:      parseFloat((e.valSharpe || e.val || 0).toFixed(3)),
    combined: parseFloat((e.score    || e.combined || e.valSharpe || 0).toFixed(3)),
    accepted: !!e.accepted,
  }));

  // Accepted breakthroughs
  const acceptedExps = accepted.map(e => ({
    n:           e.n,
    val:         parseFloat((e.valSharpe || 0).toFixed(3)),
    aud:         parseFloat((e.audSharpe || 0).toFixed(3)),
    combined:    parseFloat((e.score     || e.valSharpe || 0).toFixed(3)),
    description: e.description || `exp ${e.n}`,
    ts:          e.ts || null,
  })).sort((a, b) => a.n - b.n);

  const bestVal      = state.bestValSharpe  || Math.max(...exps.map(e => e.valSharpe || 0));
  const bestCombined = state.bestScore       || Math.max(...exps.map(e => e.score     || e.valSharpe || 0));
  const baseline     = acceptedExps.length > 2 ? acceptedExps[2]?.val || 0 : (acceptedExps[0]?.val || 0);
  const improvement  = baseline > 0 ? (bestVal / baseline).toFixed(1) + 'x' : '—';

  return {
    label,
    total:         exps.length,
    accepted:      accepted.length,
    bestVal:       parseFloat(bestVal.toFixed(3)),
    bestAud:       parseFloat((state.bestAudSharpe || 0).toFixed(3)),
    bestCombined:  parseFloat(bestCombined.toFixed(3)),
    baseline:      parseFloat(baseline.toFixed(3)),
    improvement,
    expCount:      state.expCount || exps.length,
    progressSeries,
    acceptedExps,
  };
}

async function publishResearch() {
  const AR = path.join(AGENT_DIR, 'autoresearch');

  const summary = {
    generatedAt: new Date().toISOString(),
    daily:  buildLoopSummary(path.join(AR, 'experiments.json'),         path.join(AR, 'state.json'),         'Daily (1d bars)'),
    hourly: buildLoopSummary(path.join(AR, 'experiments_hourly.json'),  path.join(AR, 'state_hourly.json'),  'Hourly (1h bars)'),
    fivem:  buildLoopSummary(path.join(AR, 'experiments_5m.json'),      path.join(AR, 'state_5m.json'),      '5-Minute (5m bars)'),
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));

  // Commit + push to delu-site
  const git = (cmd) => execSync(cmd, { cwd: SITE_DIR, stdio: 'pipe' }).toString().trim();
  try {
    git('git add public/data/research.json');
    const diff = git('git diff --cached --stat');
    if (diff) {
      git(`git commit -m "data: research update ${new Date().toISOString().slice(0,16)}"`);
      git('git push origin main');
      console.log('[research] ✅ Published to delu-site');
    }
  } catch(e) {
    console.warn('[research] Git push skipped:', e.message?.slice(0, 60));
  }

  return summary;
}

module.exports = { publishResearch };

// Direct run
if (require.main === module) {
  publishResearch().then(s => {
    console.log(`Daily: ${s.daily.total} exp, val ${s.daily.baseline}→${s.daily.bestVal} (${s.daily.improvement})`);
    console.log(`Hourly: ${s.hourly.total} exp, best combined=${s.hourly.bestCombined}`);
    console.log(`5m: ${s.fivem.total} exp, best combined=${s.fivem.bestCombined}`);
  }).catch(console.error);
}
