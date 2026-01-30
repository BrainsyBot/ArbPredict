/**
 * Crypto Trading Bot - Continuous Operation
 * Checks signals every 15 minutes and executes trades
 */

import { CryptoExecutor } from '../strategies/crypto-executor.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('crypto-bot');

async function main() {
  logger.info('🚀 Starting ArbPredict Crypto Trading Bot');
  logger.info('==========================================');
  
  const mode = process.env.TRADING_MODE || 'paper';
  logger.info(`Mode: ${mode.toUpperCase()}`);
  
  const executor = new CryptoExecutor({
    startingCapital: 1000,
    maxPositionSize: 0.05, // 5% per trade
    maxConcurrentPositions: 10,
    takeProfitThreshold: 0.90,
    stopLossThreshold: 0.20,
    minSignalConfidence: 2,
    paperTrading: mode === 'paper',
  });

  await executor.initialize();
  
  logger.info('✅ Bot initialized successfully');
  logger.info('Checking for signals every 15 minutes...');
  logger.info('');

  // Main loop - check every 15 minutes
  const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
  
  while (true) {
    try {
      logger.info('🔍 Checking for trading signals...');
      await executor.checkAndExecute();
      
      logger.info(`⏰ Next check in 15 minutes (${new Date(Date.now() + CHECK_INTERVAL).toLocaleTimeString()})`);
      logger.info('');
      
      // Wait 15 minutes before next check
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
      
    } catch (error) {
      logger.error('❌ Error in main loop', error);
      logger.info('Waiting 5 minutes before retry...');
      await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

main().catch((error) => {
  logger.error('Fatal error in crypto bot', error);
  process.exit(1);
});
