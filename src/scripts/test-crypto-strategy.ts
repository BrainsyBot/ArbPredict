#!/usr/bin/env node
/**
 * Test script for crypto trading strategy
 * Tests signal generation and market scanning
 */

import { CryptoSignalStrategy } from '../strategies/crypto-signals.js';
import { MarketScanner } from '../data/market-scanner.js';
import { BTCPriceFeed } from '../data/btc-feed.js';
import { CryptoExecutor } from '../strategies/crypto-executor.js';

async function testBTCFeed() {
  console.log('\n=== Testing BTC Price Feed ===\n');
  
  const feed = new BTCPriceFeed();
  
  try {
    // Test current price
    const currentPrice = await feed.getCurrentPrice();
    console.log(`Current BTC price: $${currentPrice.toLocaleString()}`);
    
    // Test historical candles
    console.log('\nFetching historical candles...');
    const candles = await feed.getRecentCandles(50);
    console.log(`Fetched ${candles.length} candles`);
    console.log(`Latest: $${candles[candles.length - 1].close.toFixed(2)}`);
    
    // Test indicators
    console.log('\nCalculating indicators...');
    const rsi = feed.calculateRSI(candles, 14);
    console.log(`RSI(14): ${rsi.toFixed(2)}`);
    
    const macd = feed.calculateMACD(candles);
    console.log(`MACD: ${macd.line.toFixed(4)} / Signal: ${macd.signal.toFixed(4)}`);
    
    const momentum = feed.calculateMomentum(candles, 5);
    console.log(`Momentum (5-min): ${(momentum * 100).toFixed(3)}%`);
    
    console.log('\n✅ BTC Feed test passed!\n');
  } catch (error) {
    console.error('❌ BTC Feed test failed:', error);
  }
}

async function testSignalGeneration() {
  console.log('\n=== Testing Signal Generation ===\n');
  
  const strategy = new CryptoSignalStrategy();
  
  try {
    const signal = await strategy.generateSignal();
    
    console.log(`Signal: ${signal.direction} (confidence: ${signal.confidence}/3)`);
    console.log('\nIndicators:');
    console.log(`  RSI: ${signal.indicators.rsi.value.toFixed(2)} → ${signal.indicators.rsi.signal}`);
    console.log(`  MACD: ${signal.indicators.macd.value.toFixed(4)} → ${signal.indicators.macd.signal}`);
    console.log(`  Momentum: ${(signal.indicators.momentum.value * 100).toFixed(3)}% → ${signal.indicators.momentum.signal}`);
    
    console.log('\n✅ Signal generation test passed!\n');
  } catch (error) {
    console.error('❌ Signal generation test failed:', error);
  }
}

async function testMarketScanner() {
  console.log('\n=== Testing Market Scanner ===\n');
  
  const scanner = new MarketScanner();
  
  try {
    // Test current market
    console.log('Fetching current 15-min BTC market...');
    const market = await scanner.getCurrentBTCMarket();
    
    if (market) {
      console.log(`Found market: ${market.slug}`);
      console.log(`Question: ${market.question}`);
      console.log(`Resolution time: ${new Date(market.eventTimestamp * 1000).toISOString()}`);
      console.log(`YES price: ${(market.yesPrice * 100).toFixed(1)}¢`);
      console.log(`NO price: ${(market.noPrice * 100).toFixed(1)}¢`);
      console.log(`Active: ${market.active}`);
      console.log(`Time remaining: ${scanner.getTimeRemaining(market)} seconds`);
    } else {
      console.log('No active market found (this might be normal)');
    }
    
    console.log('\n✅ Market scanner test passed!\n');
  } catch (error) {
    console.error('❌ Market scanner test failed:', error);
  }
}

async function testFullLoop() {
  console.log('\n=== Testing Full Trading Loop (Paper Mode) ===\n');
  
  const executor = new CryptoExecutor({
    startingCapital: 1000,
    paperTrading: true,
    minSignalConfidence: 2,
  });
  
  try {
    await executor.initialize();
    
    console.log('Checking for trading opportunity...');
    await executor.checkAndExecute();
    
    console.log('\nCurrent metrics:');
    const metrics = executor.getMetrics();
    console.log(`Capital: $${metrics.capital.toFixed(2)}`);
    console.log(`Total trades: ${metrics.totalTrades}`);
    console.log(`Open positions: ${metrics.openPositions}`);
    console.log(`Win rate: ${metrics.winRate.toFixed(1)}%`);
    
    console.log('\n✅ Full loop test passed!\n');
  } catch (error) {
    console.error('❌ Full loop test failed:', error);
  }
}

async function main() {
  console.log('\n🚀 CRYPTO TRADING STRATEGY TEST SUITE\n');
  console.log('=' .repeat(50));
  
  await testBTCFeed();
  await testSignalGeneration();
  await testMarketScanner();
  await testFullLoop();
  
  console.log('\n' + '='.repeat(50));
  console.log('\n✅ All tests completed!\n');
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
