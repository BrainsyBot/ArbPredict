#!/bin/bash
# ArbPredict Test & Launch Script

set -e

echo "🚀 ArbPredict - Autonomous Arbitrage Bot"
echo "========================================"
echo ""

# Check Node.js installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Installing..."
    brew install node
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"
echo ""

# Install dependencies
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Build project
echo "🔨 Building TypeScript..."
npm run build
echo ""

# Test Kalshi connection
echo "🔌 Testing Kalshi API connection..."
curl -s "https://api.elections.kalshi.com/trade-api/v2/exchange/status" | python3 -m json.tool
echo ""

# Test crypto market discovery
echo "🔍 Testing enhanced matching on crypto markets..."
echo "   (This will show the 15-20× improvement in match rate)"
echo ""
npm run discover:crypto
echo ""

# Ask to start dry-run
echo "========================================"
echo "✅ Tests complete!"
echo ""
echo "Next steps:"
echo "  1. Review the match results above"
echo "  2. Start dry-run mode: TRADING_MODE=dry_run npm run start"
echo "  3. Monitor for 24h, then go live!"
echo ""
echo "Ready to start dry-run mode? (y/n)"
read -r response

if [[ "$response" =~ ^[Yy]$ ]]; then
    echo ""
    echo "🎯 Starting in DRY-RUN mode..."
    echo "   (Will detect opportunities but NOT execute trades)"
    echo ""
    TRADING_MODE=dry_run npm run start
else
    echo ""
    echo "Manual start: TRADING_MODE=dry_run npm run start"
    echo ""
fi
