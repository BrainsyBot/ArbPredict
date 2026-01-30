#!/bin/bash

# ArbPredict Crypto Trading Bot Launcher
# Starts in paper trading mode, can switch to live

cd ~/clawd/ArbPredict

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"

# Load environment
source .env 2>/dev/null || true

# Set trading mode (paper or live)
export TRADING_MODE="${TRADING_MODE:-paper}"

echo "🚀 Starting ArbPredict Crypto Trading Bot"
echo "   Mode: $TRADING_MODE"
echo "   Wallet: $(node -e "import { ethers } from 'ethers'; const w = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY); console.log(w.address);")"
echo "   Time: $(date)"
echo ""

# Run the bot
node dist/strategies/crypto-executor.js 2>&1 | tee -a logs/crypto-bot-$(date +%Y%m%d).log
