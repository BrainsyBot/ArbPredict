/**
 * Enhanced Event Matching for ArbPredict
 * 
 * Multi-method approach with weighted scoring:
 * 1. Exact match (1.0)
 * 2. Semantic keywords (0.8-1.0)
 * 3. Token overlap with synonyms (0.6-0.9)
 * 4. Fuzzy string similarity (0.5-0.8)
 * 5. LLM validation (optional, expensive)
 */

import Anthropic from '@anthropic-ai/sdk';

// ============================================
// 1. SEMANTIC KEYWORD MATCHING
// ============================================

interface KeywordGroup {
  canonical: string;
  synonyms: string[];
  weight: number; // How important is this keyword to the event?
}

const POLITICAL_KEYWORDS: KeywordGroup[] = [
  {
    canonical: 'trump',
    synonyms: ['donald trump', 'trump', 'd trump', 'president trump', 'donald j trump', 'djt'],
    weight: 1.0, // Critical identifier
  },
  {
    canonical: 'biden',
    synonyms: ['joe biden', 'biden', 'president biden', 'joseph biden'],
    weight: 1.0,
  },
  {
    canonical: 'republican',
    synonyms: ['republican', 'gop', 'r candidate', 'republican nominee', 'republican candidate'],
    weight: 0.9,
  },
  {
    canonical: 'democrat',
    synonyms: ['democrat', 'democratic', 'd candidate', 'democratic nominee', 'democratic candidate'],
    weight: 0.9,
  },
  {
    canonical: 'presidential_election',
    synonyms: ['presidential election', 'president election', 'potus', 'presidency', 'presidential race'],
    weight: 0.95,
  },
  {
    canonical: 'win_election',
    synonyms: ['win', 'wins', 'victory', 'elected', 'becomes president'],
    weight: 0.85,
  },
  {
    canonical: '2024_election',
    synonyms: ['2024', '2024 election', 'november 2024', '11/2024'],
    weight: 0.9,
  },
];

const CRYPTO_KEYWORDS: KeywordGroup[] = [
  {
    canonical: 'bitcoin',
    synonyms: ['bitcoin', 'btc'],
    weight: 1.0,
  },
  {
    canonical: 'ethereum',
    synonyms: ['ethereum', 'eth', 'ether'],
    weight: 1.0,
  },
  {
    canonical: 'price_above',
    synonyms: ['above', 'over', 'exceed', 'surpass', 'reach', 'hit', 'trade above', 'close above'],
    weight: 0.9,
  },
  {
    canonical: 'price_below',
    synonyms: ['below', 'under', 'fall below', 'drop below', 'trade below'],
    weight: 0.9,
  },
  {
    canonical: 'end_of_year',
    synonyms: ['end of year', 'eoy', 'december', 'dec', 'year end', 'end of 2024', 'end of 2025'],
    weight: 0.85,
  },
];

/**
 * Extract semantic keywords from text with confidence scores
 */
function extractKeywords(text: string, keywordGroups: KeywordGroup[]): Map<string, number> {
  const normalized = text.toLowerCase();
  const found = new Map<string, number>();

  for (const group of keywordGroups) {
    for (const synonym of group.synonyms) {
      if (normalized.includes(synonym)) {
        // If we already found this canonical keyword, keep the highest weight
        const existing = found.get(group.canonical) || 0;
        found.set(group.canonical, Math.max(existing, group.weight));
        break; // Found one synonym in this group, move to next group
      }
    }
  }

  return found;
}

/**
 * Calculate keyword overlap score between two texts
 * Returns weighted Jaccard similarity (intersection over union)
 */
function keywordOverlapScore(
  text1: string,
  text2: string,
  keywordGroups: KeywordGroup[]
): number {
  const keywords1 = extractKeywords(text1, keywordGroups);
  const keywords2 = extractKeywords(text2, keywordGroups);

  if (keywords1.size === 0 && keywords2.size === 0) return 0;

  // Calculate weighted intersection
  let intersectionWeight = 0;
  let unionWeight = 0;

  const allKeys = new Set([...keywords1.keys(), ...keywords2.keys()]);

  for (const key of allKeys) {
    const weight1 = keywords1.get(key) || 0;
    const weight2 = keywords2.get(key) || 0;

    if (weight1 > 0 && weight2 > 0) {
      // In both - add to intersection (use minimum weight)
      intersectionWeight += Math.min(weight1, weight2);
    }

    // Add to union (use maximum weight)
    unionWeight += Math.max(weight1, weight2);
  }

  return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
}

// ============================================
// 2. TOKEN-BASED MATCHING WITH STOPWORDS
// ============================================

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'will', 'be', 'is', 'are', 'was', 'were',
  'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'would',
  'should', 'may', 'might', 'must',
]);

/**
 * Tokenize and normalize text, removing stopwords
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .split(/\s+/)
      .filter(token => token.length > 2 && !STOPWORDS.has(token))
  );
}

/**
 * Calculate token overlap (Jaccard similarity)
 */
function tokenOverlapScore(text1: string, text2: string): number {
  const tokens1 = tokenize(text1);
  const tokens2 = tokenize(text2);

  if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.size / union.size;
}

// ============================================
// 3. COMBINED SCORING STRATEGY
// ============================================

interface MatchScore {
  overall: number;
  exact: number;
  keyword: number;
  token: number;
  fuzzy: number;
  date: number;
  category: number;
  method: 'exact' | 'keyword' | 'token' | 'fuzzy' | 'combined';
  confidence: 'high' | 'medium' | 'low';
  breakdown: string;
}

/**
 * Calculate comprehensive match score using multiple methods
 */
function calculateMatchScore(
  polymarket: { title: string; endDate: Date; category?: string },
  kalshi: { title: string; expirationTime: Date; category?: string }
): MatchScore {
  // Normalize titles
  const norm1 = polymarket.title.toLowerCase().trim();
  const norm2 = kalshi.title.toLowerCase().trim();

  // 1. Exact match check
  const exactMatch = norm1 === norm2;
  if (exactMatch) {
    return {
      overall: 1.0,
      exact: 1.0,
      keyword: 1.0,
      token: 1.0,
      fuzzy: 1.0,
      date: 1.0,
      category: 1.0,
      method: 'exact',
      confidence: 'high',
      breakdown: 'Exact title match',
    };
  }

  // 2. Keyword-based matching (high weight for critical keywords)
  const keywordGroups = [...POLITICAL_KEYWORDS, ...CRYPTO_KEYWORDS];
  const keywordScore = keywordOverlapScore(polymarket.title, kalshi.title, keywordGroups);

  // 3. Token overlap
  const tokenScore = tokenOverlapScore(polymarket.title, kalshi.title);

  // 4. Fuzzy string similarity (Levenshtein - keep for completeness)
  const fuzzyScore = levenshteinSimilarity(norm1, norm2);

  // 5. Date proximity (within 7 days = 1.0, 30 days = 0.7, >30 days = 0)
  const dateDiffMs = Math.abs(polymarket.endDate.getTime() - kalshi.expirationTime.getTime());
  const dateDiffDays = dateDiffMs / (1000 * 60 * 60 * 24);
  let dateScore = 1.0;
  if (dateDiffDays > 30) dateScore = 0;
  else if (dateDiffDays > 7) dateScore = 0.7 + (0.3 * (30 - dateDiffDays) / 23);

  // 6. Category compatibility (simple check)
  let categoryScore = 0.5; // Neutral if unknown
  // (Category matching logic omitted for brevity - use your existing logic)

  // ============================================
  // WEIGHTED COMBINATION
  // ============================================

  // Adjust weights based on which methods work best
  const weights = {
    keyword: 0.40,  // Highest weight - semantic meaning
    token: 0.30,    // High weight - word overlap
    fuzzy: 0.15,    // Lower weight - too sensitive to phrasing
    date: 0.10,     // Moderate weight - should align
    category: 0.05, // Low weight - often unreliable
  };

  const overall =
    weights.keyword * keywordScore +
    weights.token * tokenScore +
    weights.fuzzy * fuzzyScore +
    weights.date * dateScore +
    weights.category * categoryScore;

  // Determine primary method and confidence
  let method: MatchScore['method'] = 'combined';
  let confidence: MatchScore['confidence'] = 'low';

  if (keywordScore >= 0.8) {
    method = 'keyword';
    confidence = overall >= 0.80 ? 'high' : 'medium';
  } else if (tokenScore >= 0.7) {
    method = 'token';
    confidence = overall >= 0.70 ? 'high' : 'medium';
  } else if (fuzzyScore >= 0.90) {
    method = 'fuzzy';
    confidence = 'medium';
  }

  const breakdown = `Keyword: ${(keywordScore * 100).toFixed(0)}%, Token: ${(tokenScore * 100).toFixed(0)}%, Fuzzy: ${(fuzzyScore * 100).toFixed(0)}%, Date: ${(dateScore * 100).toFixed(0)}%`;

  return {
    overall,
    exact: 0,
    keyword: keywordScore,
    token: tokenScore,
    fuzzy: fuzzyScore,
    date: dateScore,
    category: categoryScore,
    method,
    confidence,
    breakdown,
  };
}

// ============================================
// 4. LLM-BASED VALIDATION (OPTIONAL)
// ============================================

/**
 * Use Claude to validate if two markets are equivalent
 * Expensive but highly accurate for edge cases
 */
async function validateWithLLM(
  polymarket: { title: string; endDate: Date },
  kalshi: { title: string; expirationTime: Date }
): Promise<{ equivalent: boolean; confidence: number; reasoning: string }> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const prompt = `You are comparing two prediction market questions to determine if they represent the SAME underlying event.

Polymarket Question: "${polymarket.title}"
Polymarket End Date: ${polymarket.endDate.toISOString().split('T')[0]}

Kalshi Question: "${kalshi.title}"
Kalshi End Date: ${kalshi.expirationTime.toISOString().split('T')[0]}

Are these questions asking about the SAME event or outcome? Consider:
1. Do they reference the same people/entities?
2. Do they reference the same timeframe?
3. Would the same real-world outcome resolve both markets the same way?

Respond in JSON format:
{
  "equivalent": true/false,
  "confidence": 0-100 (your confidence in this assessment),
  "reasoning": "brief explanation"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307', // Fast + cheap for validation
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type === 'text') {
      const parsed = JSON.parse(content.text);
      return {
        equivalent: parsed.equivalent,
        confidence: parsed.confidence / 100, // Convert to 0-1
        reasoning: parsed.reasoning,
      };
    }
  } catch (error) {
    console.error('LLM validation failed:', error);
  }

  // Fallback: uncertain
  return { equivalent: false, confidence: 0.5, reasoning: 'LLM validation failed' };
}

// ============================================
// 5. RECOMMENDED MATCHING WORKFLOW
// ============================================

/**
 * Three-tier matching strategy:
 * - Tier 1 (Automatic): Overall score >= 0.75 → Auto-approve
 * - Tier 2 (Review): Overall score 0.60-0.74 → Log for manual review
 * - Tier 3 (Reject): Overall score < 0.60 → Reject
 * - Optional: Use LLM for Tier 2 validation before trading
 */
interface MatchResult {
  matched: boolean;
  kalshiTicker: string;
  kalshiTitle: string;
  score: MatchScore;
  needsReview: boolean;
  shouldTrade: boolean;
}

function findBestMatch(
  polymarket: { title: string; endDate: Date; category?: string; conditionId: string },
  kalshiMarkets: Array<{ title: string; expirationTime: Date; category?: string; ticker: string }>
): MatchResult | null {
  let bestMatch: {
    kalshi: typeof kalshiMarkets[number];
    score: MatchScore;
  } | null = null;
  let bestOverall = 0;

  for (const kalshi of kalshiMarkets) {
    const score = calculateMatchScore(polymarket, kalshi);

    if (score.overall > bestOverall) {
      bestOverall = score.overall;
      bestMatch = { kalshi, score };
    }
  }

  if (!bestMatch) return null;

  const { kalshi, score } = bestMatch;

  // Three-tier decision making
  const shouldTrade = score.overall >= 0.75;
  const needsReview = score.overall >= 0.60 && score.overall < 0.75;
  const matched = score.overall >= 0.60; // Accept for review or trading

  if (!matched) return null;

  return {
    matched,
    kalshiTicker: kalshi.ticker,
    kalshiTitle: kalshi.title,
    score,
    needsReview,
    shouldTrade,
  };
}

// ============================================
// EXAMPLE USAGE
// ============================================

// Example 1: Political event
const poly1 = {
  conditionId: '0x123',
  title: 'Will Donald Trump win the 2024 Presidential Election?',
  endDate: new Date('2024-11-05'),
  category: 'politics',
};

const kalshi1 = [
  {
    ticker: 'PRES-2024-TRUMP',
    title: 'Will the Republican candidate win the 2024 presidential election?',
    expirationTime: new Date('2024-11-06'),
    category: 'Politics',
  },
  {
    ticker: 'PRES-2024-OTHER',
    title: 'Will Biden win the 2024 election?',
    expirationTime: new Date('2024-11-06'),
    category: 'Politics',
  },
];

const result1 = findBestMatch(poly1, kalshi1);
console.log('\n=== POLITICAL EVENT MATCHING ===');
console.log('Polymarket:', poly1.title);
console.log('Best Kalshi Match:', result1?.kalshiTitle);
console.log('Overall Score:', (result1?.score.overall ?? 0 * 100).toFixed(1) + '%');
console.log('Breakdown:', result1?.score.breakdown);
console.log('Should Trade:', result1?.shouldTrade);
console.log('Needs Review:', result1?.needsReview);

// Example 2: Crypto event
const poly2 = {
  conditionId: '0x456',
  title: 'Will Bitcoin trade above $100,000 in 2024?',
  endDate: new Date('2024-12-31'),
  category: 'crypto',
};

const kalshi2 = [
  {
    ticker: 'BTC-100K-DEC',
    title: 'Will Bitcoin close above $100k on December 31, 2024?',
    expirationTime: new Date('2024-12-31'),
    category: 'Crypto',
  },
  {
    ticker: 'ETH-10K-DEC',
    title: 'Will Ethereum trade above $10k in 2024?',
    expirationTime: new Date('2024-12-31'),
    category: 'Crypto',
  },
];

const result2 = findBestMatch(poly2, kalshi2);
console.log('\n=== CRYPTO EVENT MATCHING ===');
console.log('Polymarket:', poly2.title);
console.log('Best Kalshi Match:', result2?.kalshiTitle);
console.log('Overall Score:', (result2?.score.overall ?? 0 * 100).toFixed(1) + '%');
console.log('Breakdown:', result2?.score.breakdown);
console.log('Should Trade:', result2?.shouldTrade);
console.log('Needs Review:', result2?.needsReview);

// Helper function (reference your existing implementation)
function levenshteinSimilarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1.0;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(s1: string, s2: string): number {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

export {
  calculateMatchScore,
  findBestMatch,
  validateWithLLM,
  keywordOverlapScore,
  tokenOverlapScore,
};
