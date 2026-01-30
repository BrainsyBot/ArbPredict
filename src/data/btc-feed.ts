/**
 * BTC Price Feed - Fetches real-time and historical Bitcoin prices
 * Data sources: Coinbase public API (current price) + CryptoCompare (historical candles)
 */

import axios from 'axios';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('btc-feed');

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BTCData {
  candles: Candle[];
  rsi?: number;
  macd?: { line: number; signal: number; histogram: number };
  momentum?: number;
}

export class BTCPriceFeed {
  private readonly baseUrl = 'https://api.coinbase.com';
  
  /**
   * Get current BTC price from public ticker endpoint
   */
  async getCurrentPrice(): Promise<number> {
    try {
      // Use public ticker endpoint (no auth required)
      const response = await axios.get(
        `${this.baseUrl}/v2/prices/BTC-USD/spot`
      );
      return parseFloat(response.data.data.amount);
    } catch (error) {
      logger.error('Failed to fetch current BTC price', error);
      throw error;
    }
  }

  /**
   * Get historical candles from CryptoCompare (free API)
   * @param limit - Number of 1-minute candles to fetch (max 2000)
   */
  async getHistoricalCandles(limit: number = 100): Promise<Candle[]> {
    try {
      // CryptoCompare free API
      const cryptoCompareUrl = 'https://min-api.cryptocompare.com/data/v2/histominute';
      
      logger.info(`Fetching ${limit} historical candles from CryptoCompare`);

      const response = await axios.get(cryptoCompareUrl, {
        params: {
          fsym: 'BTC',
          tsym: 'USD',
          limit: limit,
        },
      });

      if (response.data.Response !== 'Success') {
        throw new Error(`CryptoCompare API error: ${response.data.Message}`);
      }

      // CryptoCompare returns: { Data: { Data: [{ time, open, high, low, close, volumefrom, volumeto }] } }
      const candles: Candle[] = response.data.Data.Data.map((candle: any) => ({
        timestamp: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volumefrom, // BTC volume
      }));

      logger.info(`✅ Fetched ${candles.length} candles from CryptoCompare`);
      return candles;
    } catch (error) {
      logger.error('Failed to fetch historical candles from CryptoCompare', error);
      throw error;
    }
  }

  /**
   * Get recent candles for signal generation (last N periods)
   */
  async getRecentCandles(periods: number = 100): Promise<Candle[]> {
    return this.getHistoricalCandles(periods);
  }

  /**
   * Calculate RSI (Relative Strength Index)
   * @param candles - Price candles
   * @param period - RSI period (default 14)
   */
  calculateRSI(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) {
      throw new Error(`Need at least ${period + 1} candles for RSI`);
    }

    const closes = candles.map(c => c.close);
    const gains: number[] = [];
    const losses: number[] = [];

    // Calculate gains and losses
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? Math.abs(diff) : 0);
    }

    // Calculate average gain/loss for first period
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // Use smoothed average for subsequent periods
    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }

    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return rsi;
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   * @param candles - Price candles
   */
  calculateMACD(candles: Candle[]): { line: number; signal: number; histogram: number } {
    if (candles.length < 35) {
      throw new Error('Need at least 35 candles for MACD (26 + 9)');
    }

    const closes = candles.map(c => c.close);
    
    // Calculate MACD line for each period
    const macdValues: number[] = [];
    
    for (let i = 26; i < closes.length; i++) {
      const slice = closes.slice(0, i + 1);
      const ema12 = this.calculateEMA(slice, 12);
      const ema26 = this.calculateEMA(slice, 26);
      macdValues.push(ema12 - ema26);
    }

    // Calculate signal line (9-period EMA of MACD values)
    if (macdValues.length < 9) {
      throw new Error('Not enough MACD values for signal line');
    }

    const signalLine = this.calculateEMA(macdValues, 9);
    const macdLine = macdValues[macdValues.length - 1];
    const histogram = macdLine - signalLine;

    return {
      line: macdLine,
      signal: signalLine,
      histogram: histogram,
    };
  }

  /**
   * Calculate EMA (Exponential Moving Average)
   */
  private calculateEMA(values: number[], period: number): number {
    if (values.length < period) {
      throw new Error(`Need at least ${period} values for EMA`);
    }

    const multiplier = 2 / (period + 1);
    
    // Start with SMA for first period
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // Calculate EMA for remaining periods
    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Calculate momentum (rate of change)
   * @param candles - Price candles
   * @param period - Lookback period (default 5)
   */
  calculateMomentum(candles: Candle[], period: number = 5): number {
    if (candles.length < period + 1) {
      throw new Error(`Need at least ${period + 1} candles for momentum`);
    }

    const current = candles[candles.length - 1].close;
    const previous = candles[candles.length - 1 - period].close;
    
    return (current - previous) / previous;
  }

  /**
   * Get BTC data with all indicators calculated
   */
  async getBTCDataWithIndicators(): Promise<BTCData> {
    const candles = await this.getRecentCandles(100);
    
    const rsi = this.calculateRSI(candles, 14);
    const macd = this.calculateMACD(candles);
    const momentum = this.calculateMomentum(candles, 5);

    return {
      candles,
      rsi,
      macd,
      momentum,
    };
  }
}
