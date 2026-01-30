import type {
  EventMapping,
  PolymarketMarket,
  KalshiMarket,
  MatchMethod,
  OutcomeMapping,
} from '../types/index.js';
import { getConfig } from '../config/index.js';
import { query } from '../db/index.js';
import { createChildLogger } from '../utils/logger.js';
import {
  generateId,
} from '../utils/helpers.js';
import { calculateMatchScore } from '../utils/enhanced-matching.js';

const logger = createChildLogger('event-matcher');

/**
 * Event matching service
 * Maps equivalent events between Polymarket and Kalshi
 */
export class EventMatcher {
  private manualMappings: Map<string, string> = new Map();
  private cachedMappings: Map<string, EventMapping> = new Map();

  /**
   * Load manual mappings from database (or JSON file as fallback)
   */
  async loadMappings(): Promise<void> {
    try {
      const result = await query<{
        polymarket_condition_id: string;
        kalshi_ticker: string;
        id: string;
        description: string;
        match_confidence: string;
        match_method: string;
        resolution_date: Date;
        is_active: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        'SELECT * FROM event_mappings WHERE is_active = true'
      );

      for (const row of result.rows) {
        const mapping: EventMapping = {
          id: row.id,
          polymarketConditionId: row.polymarket_condition_id,
          kalshiTicker: row.kalshi_ticker,
          eventDescription: row.description,
          matchConfidence: parseFloat(row.match_confidence),
          resolutionDate: row.resolution_date,
          matchMethod: row.match_method as MatchMethod,
          outcomeMapping: [],
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

        this.cachedMappings.set(row.polymarket_condition_id, mapping);
        this.manualMappings.set(row.polymarket_condition_id, row.kalshi_ticker);
      }

      logger.info('Loaded event mappings from database', { count: result.rows.length });
    } catch (error) {
      logger.error('Failed to load mappings from database', { error: (error as Error).message });
      
      // Fallback: try loading from JSON file
      try {
        logger.info('Attempting to load mappings from JSON file...');
        const { readFileSync, existsSync } = await import('fs');
        const { resolve } = await import('path');
        
        const jsonPath = resolve('./data/event_mappings.json');
        if (!existsSync(jsonPath)) {
          logger.warn('No JSON mappings file found. Run "npm run build-mappings" to generate.');
          return;
        }

        const fileContent = readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(fileContent);
        
        for (const row of data.mappings) {
          const mapping: EventMapping = {
            id: row.id,
            polymarketConditionId: row.polymarketConditionId,
            kalshiTicker: row.kalshiTicker,
            eventDescription: row.eventDescription,
            matchConfidence: row.matchConfidence,
            resolutionDate: new Date(row.resolutionDate),
            matchMethod: row.matchMethod as MatchMethod,
            outcomeMapping: row.outcomeMapping || [],
            isActive: row.isActive !== false,
            createdAt: new Date(data.generated),
            updatedAt: new Date(data.generated),
          };

          this.cachedMappings.set(row.polymarketConditionId, mapping);
          this.manualMappings.set(row.polymarketConditionId, row.kalshiTicker);
        }

        logger.info('Loaded event mappings from JSON file', { 
          count: data.mappings.length,
          generated: data.generated 
        });
      } catch (jsonError) {
        logger.error('Failed to load mappings from JSON', { error: (jsonError as Error).message });
      }
    }
  }

  /**
   * Find Kalshi equivalent for a Polymarket event
   * Uses best-match algorithm: evaluates all candidates and returns the highest confidence match
   */
  async findKalshiEquivalent(
    polymarket: PolymarketMarket,
    kalshiMarkets: KalshiMarket[]
  ): Promise<EventMapping | null> {
    // Check cached/manual mappings first
    const cached = this.cachedMappings.get(polymarket.conditionId);
    if (cached && cached.isActive) {
      return cached;
    }

    const config = getConfig();

    // Track the best match using enhanced multi-method scoring
    let bestMatch: { kalshi: KalshiMarket; score: ReturnType<typeof calculateMatchScore> } | null = null;
    const topScores: Array<{ ticker: string; score: number }> = [];

    for (const kalshi of kalshiMarkets) {
      // Calculate comprehensive match score using multiple methods
      const score = calculateMatchScore(
        {
          title: polymarket.title,
          endDate: polymarket.endDate,
          category: polymarket.category,
        },
        {
          title: kalshi.title,
          expirationTime: kalshi.expirationTime,
          category: kalshi.category,
        }
      );

      // Track top scores for debugging (first event only)
      if (topScores.length < 100) {
        topScores.push({ ticker: kalshi.ticker, score: score.overall });
      }

      // Skip if below review threshold
      if (score.overall < config.matching.reviewConfidenceThreshold) {
        continue;
      }

      // Update best match if this score is higher
      if (!bestMatch || score.overall > bestMatch.score.overall) {
        bestMatch = { kalshi, score };

        logger.debug('Found better match candidate', {
          polymarket: polymarket.conditionId,
          kalshi: kalshi.ticker,
          overall: (score.overall * 100).toFixed(1) + '%',
          keyword: (score.keyword * 100).toFixed(1) + '%',
          token: (score.token * 100).toFixed(1) + '%',
          fuzzy: (score.fuzzy * 100).toFixed(1) + '%',
          method: score.method,
          confidence: score.confidence,
        });
      }
    }

    // No match above minimum threshold
    if (!bestMatch) {
      // Log top 3 scores for first few failures (debugging)
      if (topScores.length > 0) {
        const sorted = topScores.sort((a, b) => b.score - a.score).slice(0, 3);
        const topScoresStr = sorted.map(s => `${s.ticker}:${(s.score * 100).toFixed(1)}%`).join(', ');
        console.log(`✗ "${polymarket.title.substring(0, 60)}..." | Threshold: ${(config.matching.reviewConfidenceThreshold * 100).toFixed(0)}% | Top: ${topScoresStr}`);
      }
      return null;
    }

    // Create mapping with enhanced score
    const mapping = this.createMapping(
      polymarket,
      bestMatch.kalshi,
      bestMatch.score.overall,
      bestMatch.score.method
    );

    // Add score breakdown for debugging
    (mapping as any).scoreBreakdown = bestMatch.score.breakdown;
    (mapping as any).needsReview = bestMatch.score.overall < config.matching.minConfidenceThreshold;

    await this.saveMapping(mapping);
    return mapping;
  }

  // categoriesCompatible method removed - no longer used with enhanced matching

  /**
   * Create an event mapping
   */
  private createMapping(
    polymarket: PolymarketMarket,
    kalshi: KalshiMarket,
    confidence: number,
    method: MatchMethod
  ): EventMapping {
    // Default outcome mapping: YES maps to yes, NO maps to no
    const outcomeMapping: OutcomeMapping[] = [
      { polymarketOutcome: 'Yes', kalshiSide: 'yes' },
      { polymarketOutcome: 'No', kalshiSide: 'no' },
    ];

    return {
      id: generateId(),
      polymarketConditionId: polymarket.conditionId,
      kalshiTicker: kalshi.ticker,
      eventDescription: polymarket.title,
      matchConfidence: confidence,
      resolutionDate: polymarket.endDate,
      matchMethod: method,
      outcomeMapping,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Save mapping to database
   */
  private async saveMapping(mapping: EventMapping): Promise<void> {
    try {
      await query(
        `INSERT INTO event_mappings
         (id, polymarket_condition_id, kalshi_ticker, description, match_confidence, match_method, resolution_date, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (polymarket_condition_id, kalshi_ticker)
         DO UPDATE SET match_confidence = $5, updated_at = NOW()`,
        [
          mapping.id,
          mapping.polymarketConditionId,
          mapping.kalshiTicker,
          mapping.eventDescription,
          mapping.matchConfidence,
          mapping.matchMethod,
          mapping.resolutionDate,
          mapping.isActive,
        ]
      );

      // Update cache
      this.cachedMappings.set(mapping.polymarketConditionId, mapping);

      logger.info('Saved event mapping', {
        polymarket: mapping.polymarketConditionId,
        kalshi: mapping.kalshiTicker,
        confidence: mapping.matchConfidence,
        method: mapping.matchMethod,
      });
    } catch (error) {
      logger.error('Failed to save mapping', { error: (error as Error).message });
    }
  }

  /**
   * Add a manual mapping
   */
  async addManualMapping(
    polymarketConditionId: string,
    kalshiTicker: string,
    description?: string
  ): Promise<EventMapping> {
    const mapping: EventMapping = {
      id: generateId(),
      polymarketConditionId,
      kalshiTicker,
      eventDescription: description || '',
      matchConfidence: 1.0,
      resolutionDate: new Date(),
      matchMethod: 'manual',
      outcomeMapping: [
        { polymarketOutcome: 'Yes', kalshiSide: 'yes' },
        { polymarketOutcome: 'No', kalshiSide: 'no' },
      ],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.saveMapping(mapping);
    this.manualMappings.set(polymarketConditionId, kalshiTicker);

    return mapping;
  }

  /**
   * Remove a mapping
   */
  async removeMapping(polymarketConditionId: string): Promise<void> {
    try {
      await query(
        'UPDATE event_mappings SET is_active = false WHERE polymarket_condition_id = $1',
        [polymarketConditionId]
      );

      this.cachedMappings.delete(polymarketConditionId);
      this.manualMappings.delete(polymarketConditionId);

      logger.info('Removed event mapping', { polymarketConditionId });
    } catch (error) {
      logger.error('Failed to remove mapping', { error: (error as Error).message });
    }
  }

  /**
   * Get all active mappings
   */
  getActiveMappings(): EventMapping[] {
    return Array.from(this.cachedMappings.values()).filter(m => m.isActive);
  }

  /**
   * Get mapping by Polymarket condition ID
   */
  getMapping(polymarketConditionId: string): EventMapping | null {
    return this.cachedMappings.get(polymarketConditionId) || null;
  }

  /**
   * Get match confidence for a mapping
   */
  getMatchConfidence(mapping: EventMapping): number {
    return mapping.matchConfidence;
  }

  /**
   * Check if mapping meets minimum confidence threshold
   */
  canTradeOnMapping(mapping: EventMapping): boolean {
    const config = getConfig();

    if (mapping.matchConfidence < config.matching.minConfidenceThreshold) {
      logger.warn('Rejecting trade: confidence below threshold', {
        mapping: mapping.id,
        confidence: mapping.matchConfidence,
        threshold: config.matching.minConfidenceThreshold,
      });
      return false;
    }

    return true;
  }

  /**
   * Build mappings from current markets
   */
  async buildMappings(
    polymarketMarkets: PolymarketMarket[],
    kalshiMarkets: KalshiMarket[]
  ): Promise<EventMapping[]> {
    const mappings: EventMapping[] = [];
    let totalChecked = 0;
    let aboveThreshold = 0;

    for (const polymarket of polymarketMarkets) {
      totalChecked++;
      const mapping = await this.findKalshiEquivalent(polymarket, kalshiMarkets);
      if (mapping) {
        aboveThreshold++;
        mappings.push(mapping);
        console.log(`✓ Match #${aboveThreshold}: ${polymarket.title.substring(0, 60)}... → ${mapping.kalshiTicker} (${(mapping.matchConfidence * 100).toFixed(1)}%)`);
      } else if (totalChecked <= 5) {
        // Log first 5 failures for debugging
        console.log(`✗ No match for: ${polymarket.title.substring(0, 80)}...`);
      }
    }

    logger.info('Built event mappings', {
      polymarketCount: polymarketMarkets.length,
      kalshiCount: kalshiMarkets.length,
      mappingsFound: mappings.length,
      aboveThreshold,
    });

    return mappings;
  }
}

// Singleton instance
let eventMatcher: EventMatcher | null = null;

export function getEventMatcher(): EventMatcher {
  if (!eventMatcher) {
    eventMatcher = new EventMatcher();
  }
  return eventMatcher;
}
