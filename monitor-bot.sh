#!/bin/bash

# Quick bot monitoring script (called during heartbeats)

LOG_DIR="$HOME/clawd/ArbPredict/logs"
LATEST_LOG=$(ls -t $LOG_DIR/crypto-bot-*.log 2>/dev/null | head -1)

echo "🤖 Crypto Bot Status Check"
echo "=========================="
echo ""

# Check if bot is running
if pgrep -f "crypto-executor.js" > /dev/null; then
    echo "✅ Bot Status: RUNNING"
    PID=$(pgrep -f "crypto-executor.js")
    echo "   PID: $PID"
else
    echo "❌ Bot Status: STOPPED"
    echo "   ⚠️  Bot needs to be restarted!"
    exit 1
fi

echo ""

# Show recent activity
if [ -f "$LATEST_LOG" ]; then
    echo "📊 Recent Activity (last 20 lines):"
    echo "-----------------------------------"
    tail -20 "$LATEST_LOG" | grep -E "Signal|Trade|Position|OPEN|CLOSED|Profit" || echo "   No trades yet"
    echo ""
    
    # Count signals today
    TODAY=$(date +%Y%m%d)
    SIGNALS=$(grep -c "Signal generated" "$LOG_DIR/crypto-bot-$TODAY.log" 2>/dev/null || echo "0")
    TRADES=$(grep -c "Trade executed" "$LOG_DIR/crypto-bot-$TODAY.log" 2>/dev/null || echo "0")
    
    echo "📈 Today's Stats:"
    echo "   Signals: $SIGNALS"
    echo "   Trades: $TRADES"
fi

echo ""
echo "✅ Monitoring complete"
