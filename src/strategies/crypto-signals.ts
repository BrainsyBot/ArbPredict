/**
 * Crypto Signal Strategy - Technical analysis on 15-min BTC Up/Down markets
 * Based on 0x8dxd approach ($569k/month)
 */

import { BTCPriceFeed } from '../data/btc-feed.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('crypto-signals');

export type SignalDirection = 'UP' | 'DOWN' | 'NEUTRAL';

export interface Signal {
  direction: SignalDirection;
  confidence: number; // 2 or 3 (how many indicators agree)
  indicators: {
    rsi: { value: number; signal: SignalDirection };
    macd: { value: number; signal: SignalDirection };
    momentum: { value: number; signal: SignalDirection };
  };
  timestamp: Date;
}

export interface StrategyConfig {
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  momentumPeriod: number;
  momentumThreshold: number;
  minConfidence: number; // Minimum indicators that must agree (2 or 3)
}

export class CryptoSignalStrategy {
  private btcFeed: BTCPriceFeed;
  private config: StrategyConfig;

  constructor(config?: Partial<StrategyConfig>) {
    this.btcFeed = new BTCPriceFeed();
    this.config = {
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      momentumPeriod: 5,
      momentumThreshold: 0.002, // 0.2% move
      minConfidence: 2, // Require 2 out of 3 signals
      ...config,
    };
  }

  /**
   * Generate trading signal based on current BTC data
   */
  async generateSignal(): Promise<Signal> {
    try {
      const btcData = await this.btcFeed.getBTCDataWithIndicators();
      
      // Analyze each indicator
      const rsiSignal = this.analyzeRSI(btcData.rsi!);
      const macdSignal = this.analyzeMACD(btcData.macd!);
      const momentumSignal = this.analyzeMomentum(btcData.momentum!);

      // Count votes for UP
      const upVotes = [
        rsiSignal === 'UP',
        macdSignal === 'UP',
        momentumSignal === 'UP',
      ].filter(Boolean).length;

      // Count votes for DOWN
      const downVotes = [
        rsiSignal === 'DOWN',
        macdSignal === 'DOWN',
        momentumSignal === 'DOWN',
      ].filter(Boolean).length;

      let direction: SignalDirection = 'NEUTRAL';
      let confidence = 0;

      if (upVotes >= this.config.minConfidence) {
        direction = 'UP';
        confidence = upVotes;
      } else if (downVotes >= this.config.minConfidence) {
        direction = 'DOWN';
        confidence = downVotes;
      }

      const signal: Signal = {
        direction,
        confidence,
        indicators: {
          rsi: { value: btcData.rsi!, signal: rsiSignal },
          macd: { value: btcData.macd!.line, signal: macdSignal },
          momentum: { value: btcData.momentum!, signal: momentumSignal },
        },
        timestamp: new Date(),
      };

      logger.info(`Signal generated: ${direction} (confidence: ${confidence}/3)`, {
        rsi: `${btcData.rsi!.toFixed(2)} → ${rsiSignal}`,
        macd: `${btcData.macd!.line.toFixed(4)} → ${macdSignal}`,
        momentum: `${(btcData.momentum! * 100).toFixed(3)}% → ${momentumSignal}`,
      });

      return signal;
    } catch (error) {
      logger.error('Failed to generate signal', error);
      throw error;
    }
  }

  /**
   * Analyze RSI indicator
   */
  private analyzeRSI(rsi: number): SignalDirection {
    if (rsi < this.config.rsiOversold) {
      return 'UP'; // Oversold, likely to bounce
    } else if (rsi > this.config.rsiOverbought) {
      return 'DOWN'; // Overbought, likely to drop
    }
    return 'NEUTRAL';
  }

  /**
   * Analyze MACD indicator
   */
  private analyzeMACD(macd: { line: number; signal: number }): SignalDirection {
    if (macd.line > macd.signal) {
      return 'UP'; // Bullish crossover
    } else if (macd.line < macd.signal) {
      return 'DOWN'; // Bearish crossover
    }
    return 'NEUTRAL';
  }

  /**
   * Analyze momentum indicator
   */
  private analyzeMomentum(momentum: number): SignalDirection {
    if (momentum > this.config.momentumThreshold) {
      return 'UP'; // Strong upward momentum
    } else if (momentum < -this.config.momentumThreshold) {
      return 'DOWN'; // Strong downward momentum
    }
    return 'NEUTRAL';
  }

  /**
   * Get strategy configuration
   */
  getConfig(): StrategyConfig {
    return { ...this.config };
  }

  /**
   * Update strategy configuration
   */
  updateConfig(config: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Strategy config updated', this.config);
  }
}
