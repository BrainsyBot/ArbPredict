#!/bin/bash
# ArbPredict Daemon Starter
# Keeps the bot running with auto-start

set -e

cd ~/clawd/ArbPredict
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"

echo "🚀 Starting ArbPredict in daemon mode..."
echo "Mode: ${TRADING_MODE:-dry_run}"
echo ""

# Create a named pipe to keep stdin open
PIPE="/tmp/arbpredict-$(date +%s).pipe"
mkfifo "$PIPE"

# Start the bot with the pipe as stdin, send "start" command, then keep pipe open
(echo "start"; cat) < "$PIPE" | TRADING_MODE=${TRADING_MODE:-dry_run} npm run start 2>&1 &
BOT_PID=$!

# Write PID file
echo $BOT_PID > /tmp/arbpredict.pid
echo "Bot started with PID: $BOT_PID"
echo "Logs: Follow with 'tail -f /tmp/arbpredict-*.log'"
echo ""
echo "To stop: kill $(cat /tmp/arbpredict.pid)"
echo "To check status: ps aux | grep $BOT_PID"

# Keep the pipe open indefinitely
exec 3>"$PIPE"
sleep infinity

# Cleanup on exit
trap "rm -f '$PIPE'" EXIT
