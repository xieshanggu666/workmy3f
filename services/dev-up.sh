#!/usr/bin/env bash
# 调试用：启动一组可自定义端口/数据目录的服务
set -u
BASE="${SERVICES_DATA_DIR:-/tmp/dbg-svc}"
P_GW="${PORT_GATEWAY:-8200}"
P_ING="${PORT_INGESTION:-8201}"
P_HIST="${PORT_HISTORY:-8202}"
P_REP="${PORT_REPLAY:-8203}"
TOKEN="${LIVE_WRITE_TOKEN:-tk}"
SLACK="${DISORDER_SLACK_MS:-80}"

mkdir -p "$BASE"
common=(SERVICES_DATA_DIR="$BASE" PORT_GATEWAY="$P_GW" PORT_INGESTION="$P_ING" PORT_HISTORY="$P_HIST" PORT_REPLAY="$P_REP" LIVE_WRITE_TOKEN="$TOKEN" CHECKPOINT_INTERVAL_MS=60000 DISORDER_SLACK_MS="$SLACK")

env "${common[@]}" node services/servers/history-service.js >/tmp/dbg-history.log 2>&1 &
env "${common[@]}" node services/servers/replay-service.js >/tmp/dbg-replay.log 2>&1 &
env "${common[@]}" node services/servers/ingestion-service.js >/tmp/dbg-ingestion.log 2>&1 &
env "${common[@]}" node services/servers/gateway-service.js >/tmp/dbg-gateway.log 2>&1 &
echo "started, gateway:$P_GW ingestion:$P_ING history:$P_HIST replay:$P_REP data:$BASE"
