/**
 * Crypto Trade Executor - Executes trades based on signals
 */

import { CryptoSignalStrategy, type Signal } from './crypto-signals.js';
import { MarketScanner, type BTCMarket } from '../data/market-scanner.js';
import { PolymarketConnector } from '../connectors/polymarket/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('crypto-executor');

export interface Trade {
  signal: Signal;
  market: BTCMarket;
  side: 'YES' | 'NO';
  amount: number;
  entryPrice: number;
  timestamp: Date;
  orderId?: string;
}

export interface Position {
  trade: Trade;
  currentPrice: number;
  pnl: number;
  status: 'OPEN' | 'CLOSED';
  exitPrice?: number;
  exitTimestamp?: Date;
}

export interface ExecutorConfig {
  startingCapital: number;
  maxPositionSize: number; // As percentage of capital (0.05 = 5%)
  maxConcurrentPositions: number;
  takeProfitThreshold: number; // 0.90 = exit at 90¢
  stopLossThreshold: number; // 0.20 = exit at 20¢
  minSignalConfidence: number; // 2 or 3
  paperTrading: boolean; // If true, don't execute real trades
}

export class CryptoExecutor {
  private strategy: CryptoSignalStrategy;
  private scanner: MarketScanner;
  private polymarket: PolymarketConnector;
  private config: ExecutorConfig;
  private positions: Map<string, Position> = new Map();
  private capital: number;
  private tradeHistory: Trade[] = [];

  constructor(config?: Partial<ExecutorConfig>) {
    this.strategy = new CryptoSignalStrategy();
    this.scanner = new MarketScanner();
    this.polymarket = new PolymarketConnector();
    
    this.config = {
      startingCapital: 1000,
      maxPositionSize: 0.05, // 5%
      maxConcurrentPositions: 10,
      takeProfitThreshold: 0.90,
      stopLossThreshold: 0.20,
      minSignalConfidence: 2,
      paperTrading: true, // Start in paper trading mode
      ...config,
    };
    
    this.capital = this.config.startingCapital;
  }

  /**
   * Initialize connections
   */
  async initialize(): Promise<void> {
    logger.info('Initializing crypto executor...', {
      capital: this.capital,
      paperTrading: this.config.paperTrading,
    });
    
    if (!this.config.paperTrading) {
      await this.polymarket.connect();
    }
  }

  /**
   * Main trading loop - check signals and execute
   */
  async checkAndExecute(): Promise<void> {
    try {
      // 1. Monitor and close existing positions first
      await this.monitorPositions();

      // 2. Generate signal for new trades
      const signal = await this.strategy.generateSignal();
      
      if (signal.direction === 'NEUTRAL') {
        logger.info('No trade signal - neutral market');
        return;
      }

      if (signal.confidence < this.config.minSignalConfidence) {
        logger.info(`Signal confidence too low: ${signal.confidence}/${this.config.minSignalConfidence}`);
        return;
      }

      // 2. Find current market
      const market = await this.scanner.getCurrentBTCMarket();
      
      if (!market) {
        logger.warn('No active BTC market found');
        return;
      }

      if (!this.scanner.isMarketOpen(market)) {
        logger.info('Market is closed or about to close');
        return;
      }

      // 3. Check position limits
      if (this.positions.size >= this.config.maxConcurrentPositions) {
        logger.info(`Max concurrent positions reached: ${this.positions.size}`);
        return;
      }

      // 4. Calculate position size
      const positionSize = this.calculatePositionSize(signal.confidence);
      
      if (positionSize > this.capital) {
        logger.warn('Insufficient capital for trade');
        return;
      }

      // 5. Execute trade
      await this.executeTrade(signal, market, positionSize);
      
    } catch (error) {
      logger.error('Error in trading loop', error);
    }
  }

  /**
   * Execute a trade based on signal
   */
  private async executeTrade(
    signal: Signal,
    market: BTCMarket,
    amount: number
  ): Promise<void> {
    const side: 'YES' | 'NO' = signal.direction === 'UP' ? 'YES' : 'NO';
    const entryPrice = side === 'YES' ? market.yesPrice : market.noPrice;

    const trade: Trade = {
      signal,
      market,
      side,
      amount,
      entryPrice,
      timestamp: new Date(),
    };

    logger.info(`Executing trade: ${side} on ${market.question}`, {
      amount: `$${amount}`,
      entryPrice: `${(entryPrice * 100).toFixed(1)}¢`,
      confidence: `${signal.confidence}/3`,
    });

    if (this.config.paperTrading) {
      logger.info('[PAPER TRADE] Would execute but in paper trading mode');
    } else {
      // Real execution (to be implemented)
      // const order = await this.polymarket.placeOrder({...});
      // trade.orderId = order.id;
    }

    // Track position
    const position: Position = {
      trade,
      currentPrice: entryPrice,
      pnl: 0,
      status: 'OPEN',
    };

    this.positions.set(market.slug, position);
    this.tradeHistory.push(trade);
    this.capital -= amount;

    logger.info(`Position opened. Remaining capital: $${this.capital.toFixed(2)}`);
  }

  /**
   * Calculate position size based on confidence
   */
  private calculatePositionSize(confidence: number): number {
    const baseSize = this.capital * this.config.maxPositionSize;
    
    // Scale up if all 3 signals agree
    if (confidence === 3) {
      return baseSize * 1.5;
    }
    
    return baseSize;
  }

  /**
   * Monitor open positions and check exit conditions
   */
  async monitorPositions(): Promise<void> {
    if (this.positions.size === 0) {
      return;
    }

    logger.info(`Monitoring ${this.positions.size} open position(s)`);

    for (const position of this.positions.values()) {
      if (position.status !== 'OPEN') continue;

      // Update current price
      if (this.config.paperTrading) {
        // Simulate price movement in paper trading
        const timeRemaining = this.scanner.getTimeRemaining(position.trade.market);
        if (timeRemaining < 60) {
          // Market about to close - simulate resolution
          position.currentPrice = Math.random() > 0.5 ? 0.95 : 0.05;
        } else {
          // Simulate small price movements
          const volatility = 0.05;
          const change = (Math.random() - 0.5) * volatility;
          position.currentPrice = Math.max(0.05, Math.min(0.95, position.currentPrice + change));
        }
      } else {
        // In live trading, fetch real price
        // position.currentPrice = await this.getMarketPrice(position.trade.market);
      }

      // Check take profit
      if (position.currentPrice >= this.config.takeProfitThreshold) {
        await this.closePosition(position, 'TAKE_PROFIT');
      }
      
      // Check stop loss
      else if (position.currentPrice <= this.config.stopLossThreshold) {
        await this.closePosition(position, 'STOP_LOSS');
      }
      
      // Check time-based exit (1 min before close)
      else if (this.scanner.getTimeRemaining(position.trade.market) < 60) {
        await this.closePosition(position, 'TIME_EXIT');
      }
    }
  }

  /**
   * Close a position
   */
  private async closePosition(
    position: Position,
    reason: string
  ): Promise<void> {
    logger.info(`Closing position: ${reason}`, {
      market: position.trade.market.question,
      entryPrice: position.trade.entryPrice,
      exitPrice: position.currentPrice,
    });

    position.status = 'CLOSED';
    position.exitPrice = position.currentPrice;
    position.exitTimestamp = new Date();
    
    // Calculate P&L
    const invested = position.trade.amount;
    const shares = invested / position.trade.entryPrice;
    const exitValue = shares * position.currentPrice;
    position.pnl = exitValue - invested;
    
    // Return capital
    this.capital += exitValue;

    logger.info(`Position closed. P&L: $${position.pnl.toFixed(2)}, Capital: $${this.capital.toFixed(2)}`);
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    const closedPositions = Array.from(this.positions.values()).filter(p => p.status === 'CLOSED');
    const wins = closedPositions.filter(p => p.pnl > 0).length;
    const losses = closedPositions.filter(p => p.pnl <= 0).length;
    
    return {
      capital: this.capital,
      startingCapital: this.config.startingCapital,
      totalReturn: ((this.capital - this.config.startingCapital) / this.config.startingCapital) * 100,
      totalTrades: this.tradeHistory.length,
      openPositions: Array.from(this.positions.values()).filter(p => p.status === 'OPEN').length,
      closedPositions: closedPositions.length,
      wins,
      losses,
      winRate: closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0,
      totalPnL: closedPositions.reduce((sum, p) => sum + p.pnl, 0),
    };
  }
}
