#!/usr/bin/env bash
pkill -9 -f "servers/history-service.js" 2>/dev/null || true
pkill -9 -f "servers/replay-service.js" 2>/dev/null || true
pkill -9 -f "servers/ingestion-service.js" 2>/dev/null || true
pkill -9 -f "servers/gateway-service.js" 2>/dev/null || true
sleep 0.5
echo "services stopped"
