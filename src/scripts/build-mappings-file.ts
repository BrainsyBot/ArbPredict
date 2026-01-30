#!/usr/bin/env ts-node
/**
 * Build event mappings and save to JSON file
 * Workaround for database connection issues
 */

import { getPolymarketConnector } from '../connectors/polymarket/index.js';
import { getKalshiConnector } from '../connectors/kalshi/index.js';
import { getEventMatcher } from '../core/event-matcher.js';
import { createChildLogger } from '../utils/logger.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import axios from 'axios';
import type { PolymarketMarket } from '../types/index.js';

const logger = createChildLogger('build-mappings');

async function buildMappingsFile() {
  logger.info('Starting mapping build process...');

  try {
    // Connect to both platforms
    logger.info('Connecting to Polymarket...');
    const polymarketConnector = getPolymarketConnector();
    const polyConnected = await polymarketConnector.connect();
    if (!polyConnected) {
      throw new Error('Failed to connect to Polymarket');
    }

    logger.info('Connecting to Kalshi...');
    const kalshiConnector = getKalshiConnector();
    const kalshiConnected = await kalshiConnector.connect();
    if (!kalshiConnected) {
      throw new Error('Failed to connect to Kalshi');
    }

    // Fetch markets directly from Gamma API (limit to avoid rate limits)
    logger.info('Fetching Polymarket markets from Gamma API...');
    const response = await axios.get(
      'https://gamma-api.polymarket.com/markets',
      {
        params: {
          limit: 100,
          closed: false,  // Only get open markets (removing 'active: true' which returns old 2020 data)
        },
        timeout: 30000,
      }
    );

    let rawMarkets: any[];
    if (Array.isArray(response.data)) {
      rawMarkets = response.data;
    } else if (response.data && typeof response.data === 'object') {
      if ('data' in response.data && Array.isArray(response.data.data)) {
        rawMarkets = response.data.data;
      } else if ('markets' in response.data && Array.isArray(response.data.markets)) {
        rawMarkets = response.data.markets;
      } else {
        rawMarkets = [];
      }
    } else {
      rawMarkets = [];
    }

    // Convert to PolymarketMarket format
    const polymarketMarkets: PolymarketMarket[] = rawMarkets.map((m: any) => {
      const yesPrice = m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : 0;
      const noPrice = m.outcomePrices ? JSON.parse(m.outcomePrices)[1] : 0;
      return {
        id: m.condition_id,
        conditionId: m.condition_id,
        questionId: m.question_id || m.condition_id,
        title: m.question,
        description: m.description || '',
        outcomes: ['Yes', 'No'],
        outcomePrices: [yesPrice, noPrice],
        tokens: {
          yes: m.clobTokenIds?.[0] || '',
          no: m.clobTokenIds?.[1] || '',
        },
        yesPrice,
        noPrice,
        volume: 0,
        liquidity: 0,
        endDate: new Date(m.end_date_iso || m.game_start_time || Date.now()),
        category: 'unknown',
      };
    });

    logger.info(`Fetched ${polymarketMarkets.length} active Polymarket markets`);

    logger.info('Fetching Kalshi markets...');
    // Focus on political/financial markets (most likely to match Polymarket)
    const categories = ['Politics', 'Economics', 'Crypto', 'Financial', 'Presidential'];
    const kalshiMarkets = await kalshiConnector.getMarketsByCategories(categories, 200);
    logger.info(`Fetched ${kalshiMarkets.length} Kalshi markets`);

    // Build mappings using enhanced matching
    logger.info('Building mappings with enhanced matching...');
    const eventMatcher = getEventMatcher();
    const mappings = await eventMatcher.buildMappings(polymarketMarkets, kalshiMarkets);

    logger.info(`Found ${mappings.length} potential matches`);

    // Filter to high-confidence matches (≥ 0.60 threshold)
    const goodMappings = mappings.filter(m => m.matchConfidence >= 0.60);
    logger.info(`${goodMappings.length} matches above 60% confidence`);

    // Separate by confidence tier
    const tier1 = goodMappings.filter(m => m.matchConfidence >= 0.75); // Auto-approve
    const tier2 = goodMappings.filter(m => m.matchConfidence >= 0.60 && m.matchConfidence < 0.75); // Review

    logger.info(`Tier 1 (≥75%): ${tier1.length} matches`);
    logger.info(`Tier 2 (60-74%): ${tier2.length} matches`);

    // Save to JSON file
    const outputPath = resolve('./data/event_mappings.json');
    const output = {
      generated: new Date().toISOString(),
      polymarketMarkets: polymarketMarkets.length,
      kalshiMarkets: kalshiMarkets.length,
      totalMatches: goodMappings.length,
      tier1Count: tier1.length,
      tier2Count: tier2.length,
      mappings: goodMappings.map(m => ({
        id: m.id,
        polymarketConditionId: m.polymarketConditionId,
        kalshiTicker: m.kalshiTicker,
        eventDescription: m.eventDescription,
        matchConfidence: m.matchConfidence,
        matchMethod: m.matchMethod,
        resolutionDate: m.resolutionDate,
        outcomeMapping: m.outcomeMapping,
        isActive: true,
      })),
    };

    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    logger.info(`Saved ${goodMappings.length} mappings to ${outputPath}`);

    // Print sample matches
    console.log('\n=== TOP 10 MATCHES ===\n');
    const top10 = goodMappings.slice(0, 10);
    for (let i = 0; i < top10.length; i++) {
      const m = top10[i];
      console.log(`${i + 1}. [${(m.matchConfidence * 100).toFixed(0)}%] ${m.eventDescription.substring(0, 50)}...`);
      console.log(`   Poly: ${m.polymarketConditionId.substring(0, 16)}...`);
      console.log(`   Kalshi: ${m.kalshiTicker}`);
      console.log(`   Method: ${m.matchMethod}\n`);
    }

    // Disconnect
    await polymarketConnector.disconnect();
    await kalshiConnector.disconnect();

    logger.info('Build complete!');
    process.exit(0);
  } catch (error) {
    logger.error('Failed to build mappings', { error: (error as Error).message });
    process.exit(1);
  }
}

buildMappingsFile();
