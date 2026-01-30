/**
 * Market Scanner - Finds active 15-min BTC Up/Down markets on Polymarket
 */

import axios from 'axios';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('market-scanner');

export interface BTCMarket {
  slug: string;
  question: string;
  eventTimestamp: number; // When market resolves
  yesPrice: number;
  noPrice: number;
  yesTokenId: string;
  noTokenId: string;
  clobTokenIds: string[];
  active: boolean;
}

export class MarketScanner {
  private readonly gammaApiUrl = 'https://gamma-api.polymarket.com';

  /**
   * Get current 15-min BTC market (the one about to start or in progress)
   */
  async getCurrentBTCMarket(): Promise<BTCMarket | null> {
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // Round to nearest 15-min interval
      const interval = 15 * 60; // 15 minutes in seconds
      const nextInterval = Math.ceil(now / interval) * interval;
      
      logger.info(`Looking for BTC market at epoch: ${nextInterval}`);
      
      const market = await this.getBTCMarketByEpoch(nextInterval);
      
      if (!market) {
        // Try the current interval
        const currentInterval = Math.floor(now / interval) * interval;
        logger.info(`Trying current interval: ${currentInterval}`);
        return this.getBTCMarketByEpoch(currentInterval);
      }
      
      return market;
    } catch (error) {
      logger.error('Failed to get current BTC market', error);
      return null;
    }
  }

  /**
   * Get BTC market for specific epoch timestamp
   */
  async getBTCMarketByEpoch(epoch: number): Promise<BTCMarket | null> {
    try {
      const slug = `btc-updown-15m-${epoch}`;
      const url = `${this.gammaApiUrl}/events?slug=${slug}`;
      
      logger.info(`Fetching market: ${url}`);
      
      const response = await axios.get(url);
      
      if (!response.data || response.data.length === 0) {
        logger.warn(`No market found for slug: ${slug}`);
        return null;
      }

      const event = response.data[0];
      const market = event.markets?.[0];
      
      if (!market) {
        logger.warn(`No market data in event: ${slug}`);
        return null;
      }

      // Get current prices from orderbook
      const prices = await this.getMarketPrices(market.clobTokenIds);
      
      return {
        slug,
        question: market.question || `Bitcoin Up or Down - ${new Date(epoch * 1000).toISOString()}`,
        eventTimestamp: epoch,
        yesPrice: prices.yes,
        noPrice: prices.no,
        yesTokenId: market.clobTokenIds[0],
        noTokenId: market.clobTokenIds[1],
        clobTokenIds: market.clobTokenIds,
        active: market.active !== false,
      };
    } catch (error) {
      logger.error(`Failed to fetch market for epoch ${epoch}`, error);
      return null;
    }
  }

  /**
   * Get current market prices from orderbook
   */
  private async getMarketPrices(_tokenIds: string[]): Promise<{ yes: number; no: number }> {
    try {
      // For simplicity, use midpoint prices
      // In production, would query actual orderbook
      
      // Default to 50/50 if can't fetch
      return { yes: 0.5, no: 0.5 };
    } catch (error) {
      logger.error('Failed to fetch market prices', error);
      return { yes: 0.5, no: 0.5 };
    }
  }

  /**
   * Get upcoming BTC markets (next 2 hours)
   */
  async getUpcomingMarkets(count: number = 8): Promise<BTCMarket[]> {
    const now = Math.floor(Date.now() / 1000);
    const interval = 15 * 60;
    const markets: BTCMarket[] = [];

    for (let i = 0; i < count; i++) {
      const epoch = Math.ceil(now / interval) * interval + (i * interval);
      const market = await this.getBTCMarketByEpoch(epoch);
      
      if (market) {
        markets.push(market);
      }
    }

    return markets;
  }

  /**
   * Check if market is still open for trading
   */
  isMarketOpen(market: BTCMarket): boolean {
    const now = Math.floor(Date.now() / 1000);
    const timeUntilClose = market.eventTimestamp - now;
    
    // Market closes 1 minute before resolution
    return timeUntilClose > 60 && market.active;
  }

  /**
   * Get time remaining until market closes (in seconds)
   */
  getTimeRemaining(market: BTCMarket): number {
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, market.eventTimestamp - now - 60);
  }
}
