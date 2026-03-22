#!/bin/bash
# watchdog.sh — checks all delu processes every run, restarts dead ones
# Run via cron: */10 * * * * /data/workspace/delu-agent/scripts/watchdog.sh >> /tmp/watchdog.log 2>&1

cd /data/workspace/delu-agent
source .env 2>/dev/null || true

AGENT_LOG=/tmp/agent.log
DAILY_LOG=/tmp/autoresearch.log
HOURLY_LOG=/tmp/autoresearch_hourly.log
FIVEM_LOG=/tmp/autoresearch_5m.log
ONCHAIN_LOG=/tmp/autoresearch_onchain.log
WATCHDOG_LOG=/tmp/watchdog.log

TS=$(date -u '+%Y-%m-%d %H:%M UTC')

is_running() {
  pgrep -f "$1" > /dev/null 2>&1
}

restart_if_dead() {
  local name="$1"
  local match="$2"
  local cmd="$3"
  local log="$4"

  if ! is_running "$match"; then
    echo "[$TS] ⚠️  $name DEAD — restarting"
    eval "$cmd"
    sleep 2
    if is_running "$match"; then
      echo "[$TS] ✅ $name restarted OK"
    else
      echo "[$TS] ❌ $name failed to restart"
    fi
  fi
}

# Kill duplicate instances (keep newest)
for script in loop.js loop_hourly.js loop_5m.js loop_onchain.js; do
  pids=$(pgrep -f "$script" | sort -n)
  count=$(echo "$pids" | wc -l)
  if [ "$count" -gt 1 ]; then
    # Kill all but the last (newest)
    to_kill=$(echo "$pids" | head -n -1)
    echo "[$TS] 🔪 Duplicate $script — killing old PIDs: $to_kill"
    kill -9 $to_kill 2>/dev/null
  fi
done

# Check and restart each loop
restart_if_dead "Agent"   "agent/index.js"       "nohup node agent/index.js --loop > $AGENT_LOG 2>&1 &"     "$AGENT_LOG"
restart_if_dead "Daily"   "autoresearch/loop.js"  "nohup node -r dotenv/config autoresearch/loop.js > $DAILY_LOG 2>&1 &"    "$DAILY_LOG"
restart_if_dead "Hourly"  "loop_hourly.js"        "nohup node -r dotenv/config autoresearch/loop_hourly.js > $HOURLY_LOG 2>&1 &" "$HOURLY_LOG"
restart_if_dead "5m"      "loop_5m.js"            "nohup node -r dotenv/config autoresearch/loop_5m.js > $FIVEM_LOG 2>&1 &"  "$FIVEM_LOG"
restart_if_dead "Onchain" "loop_onchain.js"       "nohup node -r dotenv/config autoresearch/loop_onchain.js > $ONCHAIN_LOG 2>&1 &" "$ONCHAIN_LOG"

# Check experiment progress (alert if stuck)
check_progress() {
  local name="$1"
  local file="$2"
  local metric="$3"
  local alert="$4"

  result=$(node -e "
    const fs=require('fs');
    try {
      const e=JSON.parse(fs.readFileSync('$file','utf8'));
      const acc=e.filter(x=>x.accepted);
      const best=acc.length?Math.max(...acc.map(x=>x.$metric||x.score||0)):0;
      console.log(e.length+'|'+best.toFixed(2));
    } catch(e) { console.log('err'); }
  " 2>/dev/null)

  count=$(echo $result | cut -d'|' -f1)
  best=$(echo $result | cut -d'|' -f2)

  echo "[$TS] 📊 $name: $count exp | best: $best"

  # Alert on breakthroughs
  if [ "$name" = "Onchain" ] && (( $(echo "$best > 25" | bc -l 2>/dev/null) )); then
    echo "[$TS] 🚨 ALERT: Onchain best=$best > 25 THRESHOLD"
  fi
  if [ "$name" = "5m" ] && (( $(echo "$best > 35" | bc -l 2>/dev/null) )); then
    echo "[$TS] 🚨 ALERT: 5m best=$best > 35 THRESHOLD"
  fi
  if [ "$name" = "Hourly" ] && (( $(echo "$best > 10" | bc -l 2>/dev/null) )); then
    echo "[$TS] 🚨 ALERT: Hourly best=$best > 10 THRESHOLD"
  fi
}

check_progress "Daily"   "autoresearch/experiments.json"         "valSharpe"
check_progress "Hourly"  "autoresearch/experiments_hourly.json"  "score"
check_progress "5m"      "autoresearch/experiments_5m.json"      "score"
check_progress "Onchain" "autoresearch/experiments_onchain.json" "score"

echo "[$TS] ✓ watchdog complete"
