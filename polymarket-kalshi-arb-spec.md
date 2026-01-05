# Polymarket ↔ Kalshi Arbitrage Bot Specification

## ⚠️ IMPORTANT DISCLAIMER

**REGULATORY NOTICE:** This software is provided for educational and informational purposes. Users are solely responsible for ensuring compliance with all applicable laws and regulations in their jurisdiction.

- **Kalshi** is a CFTC-regulated exchange requiring US residency
- **Polymarket** may have geographic restrictions in certain jurisdictions
- Users must independently verify their eligibility to use both platforms
- This software does not constitute financial, legal, or investment advice
- Trading prediction markets involves substantial risk of loss

**By using this software, you acknowledge that you have reviewed and accept full legal responsibility for your trading activities.**

---

## Executive Summary

This document specifies an automated trading system that identifies and executes arbitrage opportunities between Polymarket (crypto-native prediction market on Polygon) and Kalshi (CFTC-regulated prediction market). The bot monitors equivalent prediction markets on both platforms and executes trades when price discrepancies exceed transaction costs.

**Operating Mode:** Live trading with real funds (conservative limits)

---

## 1. Market Overview

### 1.1 Polymarket
- **Chain:** Polygon (MATIC)
- **Settlement Currency:** USDC
- **Order Type:** CLOB (Central Limit Order Book) via their API
- **Fee Structure:** ~1-2% on winnings (varies)
- **API:** REST + WebSocket
- **Authentication:** Wallet signature (SIWE-style)
- **Settlement:** Automatic on-chain resolution

### 1.2 Kalshi
- **Type:** CFTC-regulated exchange
- **Settlement Currency:** USD
- **Order Type:** CLOB
- **Fee Structure:**
  - 7% on profits (capped at $0.07/contract)
  - No fees on losses
- **API:** REST + WebSocket
- **Authentication:** API keys (OAuth2)
- **Settlement:** T+1 USD withdrawal

### 1.3 API Rate Limits

#### Polymarket Rate Limits
| Endpoint Type | Rate Limit | Window | Notes |
|---------------|------------|--------|-------|
| Market Data (GET) | 100 req | Per minute | Free tier |
| Order Placement | 300 req | Per minute | 3000/10min |
| WebSocket | No limit | - | Preferred for real-time data |
| Batch Orders | 15 orders | Per request | Recently increased from 5 |

**Throttling Behavior:** Cloudflare-based throttling delays (not rejects) requests over limit.

#### Kalshi Rate Limits
| Tier | Read Requests | Write Requests | Notes |
|------|---------------|----------------|-------|
| Standard | 10 req/sec | 5 req/sec | Default tier |
| Prime | 20 req/sec | 10 req/sec | Requires activity |
| Premier | 50 req/sec | 25 req/sec | By request only |

**Throttling Behavior:** Requests exceeding limits are rejected (HTTP 429). Risk of temporary ban.

#### Bot Rate Limit Strategy
```typescript
const RATE_LIMITS = {
  polymarket: {
    marketDataPerMinute: 60,    // Stay well under 100
    ordersPerMinute: 30,        // Very conservative (limit is 300)
    minRequestIntervalMs: 1000, // 1 second between requests
  },
  kalshi: {
    readPerSecond: 5,           // Half of standard limit
    writePerSecond: 2,          // Conservative write rate
    minRequestIntervalMs: 500,  // 500ms between requests
  },
  backoff: {
    initialDelayMs: 1000,
    maxDelayMs: 32000,
    multiplier: 2,
  },
};
```

### 1.4 Latency Requirements

| Operation | Target | Maximum | Action if Exceeded |
|-----------|--------|---------|-------------------|
| Orderbook fetch | < 100ms | 500ms | Log warning |
| Order placement | < 200ms | 1000ms | Abort trade |
| Opportunity detection | < 50ms | 200ms | Skip opportunity |
| End-to-end execution | < 500ms | 2000ms | Pause and alert |
| WebSocket heartbeat | < 5s | 30s | Reconnect |

**Note:** Cross-platform arbitrage is latency-sensitive. If consistent latency exceeds targets, reduce position sizes.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ARBITRAGE BOT                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  Polymarket │    │   Kalshi    │    │   Event Matching    │ │
│  │  Connector  │    │  Connector  │    │      Service        │ │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘ │
│         │                  │                      │             │
│         ▼                  ▼                      ▼             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Unified Order Book Manager                     ││
│  │         (Normalized prices, quantities, events)             ││
│  └─────────────────────────┬───────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Arbitrage Opportunity Detector                 ││
│  │    (Spread calculation, fee adjustment, profit threshold)  ││
│  └─────────────────────────┬───────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Execution Engine                          ││
│  │         (Order placement, fill tracking, retries)           ││
│  └─────────────────────────┬───────────────────────────────────┘│
│                            │                                    │
│                            ▼                                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐│
│  │ Position Manager │  │  Risk Manager    │  │ P&L Tracker    ││
│  └──────────────────┘  └──────────────────┘  └────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     INFRASTRUCTURE                              │
├─────────────────────────────────────────────────────────────────┤
│  Database (PostgreSQL)  │  Redis (Cache)  │  Monitoring/Alerts │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Market Connectors

#### 3.1.1 Polymarket Connector

```typescript
interface PolymarketConnector {
  // WebSocket subscription for real-time orderbook
  subscribeToMarket(conditionId: string): Observable<OrderBookUpdate>;
  
  // REST endpoints
  getMarkets(): Promise<PolymarketMarket[]>;
  getOrderBook(tokenId: string): Promise<OrderBook>;
  
  // Trading
  placeLimitOrder(order: LimitOrder): Promise<OrderResult>;
  placeMarketOrder(order: MarketOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  
  // Account
  getBalances(): Promise<Balances>;
  getPositions(): Promise<Position[]>;
}

interface PolymarketMarket {
  conditionId: string;
  questionId: string;
  question: string;
  outcomes: string[];        // ["Yes", "No"]
  outcomePrices: number[];   // [0.65, 0.35]
  tokens: TokenPair;         // YES and NO token addresses
  volume: number;
  liquidity: number;
  endDate: Date;
}
```

#### 3.1.2 Kalshi Connector

```typescript
interface KalshiConnector {
  // WebSocket subscription
  subscribeToMarket(ticker: string): Observable<OrderBookUpdate>;
  
  // REST endpoints
  getMarkets(params?: MarketFilters): Promise<KalshiMarket[]>;
  getOrderBook(ticker: string): Promise<OrderBook>;
  
  // Trading
  placeOrder(order: KalshiOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  
  // Account
  getBalance(): Promise<number>;
  getPositions(): Promise<KalshiPosition[]>;
}

interface KalshiMarket {
  ticker: string;
  title: string;
  category: string;
  yesPrice: number;         // 0-100 cents
  noPrice: number;
  volume: number;
  openInterest: number;
  expirationTime: Date;
  settlementTime: Date;
}
```

### 3.1.3 WebSocket Reconnection Strategy

**CRITICAL:** WebSocket connections are essential for real-time data. Dropped connections trigger circuit breaker.

```typescript
interface WebSocketManager {
  // Connection state
  isConnected(platform: Platform): boolean;
  getConnectionUptime(platform: Platform): number;
  getLastHeartbeat(platform: Platform): Date;

  // Reconnection controls
  reconnect(platform: Platform): Promise<boolean>;
  setReconnectionPolicy(policy: ReconnectionPolicy): void;
}

interface ReconnectionPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

const WEBSOCKET_CONFIG: ReconnectionPolicy = {
  maxAttempts: 5,              // Max reconnection attempts before circuit breaker
  initialDelayMs: 1000,        // Start with 1 second delay
  maxDelayMs: 30000,           // Cap at 30 seconds
  backoffMultiplier: 2,        // Exponential backoff
  heartbeatIntervalMs: 5000,   // Send heartbeat every 5 seconds
  heartbeatTimeoutMs: 30000,   // Consider dead after 30 seconds no response
};

class WebSocketReconnector {
  private attempts: number = 0;
  private connected: boolean = false;
  private lastHeartbeat: Date | null = null;
  private heartbeatTimer: NodeJS.Timer | null = null;

  async connect(platform: Platform): Promise<boolean> {
    this.attempts = 0;

    while (this.attempts < WEBSOCKET_CONFIG.maxAttempts) {
      try {
        await this.establishConnection(platform);
        this.connected = true;
        this.attempts = 0;
        this.startHeartbeatMonitor();

        logger.info(`WebSocket connected to ${platform}`);
        return true;
      } catch (error) {
        this.attempts++;
        const delay = Math.min(
          WEBSOCKET_CONFIG.initialDelayMs * Math.pow(WEBSOCKET_CONFIG.backoffMultiplier, this.attempts - 1),
          WEBSOCKET_CONFIG.maxDelayMs
        );

        logger.warn(`WebSocket connection attempt ${this.attempts} failed for ${platform}. Retrying in ${delay}ms`);

        await sleep(delay);
      }
    }

    // Max attempts reached - trigger circuit breaker
    logger.error(`WebSocket reconnection failed after ${WEBSOCKET_CONFIG.maxAttempts} attempts`);
    circuitBreaker.recordFailure('CONNECTION_LOST');
    return false;
  }

  private startHeartbeatMonitor(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = new Date();
      if (this.lastHeartbeat) {
        const timeSinceHeartbeat = now.getTime() - this.lastHeartbeat.getTime();

        if (timeSinceHeartbeat > WEBSOCKET_CONFIG.heartbeatTimeoutMs) {
          logger.error('WebSocket heartbeat timeout - connection presumed dead');
          this.connected = false;
          this.handleDisconnect();
        }
      }
    }, WEBSOCKET_CONFIG.heartbeatIntervalMs);
  }

  private handleDisconnect(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Attempt reconnection
    logger.info('Attempting WebSocket reconnection...');
    this.connect(this.platform).catch(() => {
      // Circuit breaker already triggered in connect()
    });
  }

  onHeartbeat(): void {
    this.lastHeartbeat = new Date();
  }

  onMessage(handler: (msg: any) => void): void {
    // Handle incoming messages and update heartbeat
    this.socket.on('message', (msg) => {
      this.onHeartbeat();
      handler(msg);
    });
  }

  disconnect(): void {
    this.connected = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.socket?.close();
  }
}

// Connection health check
async function checkConnectionHealth(): Promise<HealthReport> {
  const polyConnected = wsManager.isConnected('polymarket');
  const kalshiConnected = wsManager.isConnected('kalshi');

  return {
    polymarket: {
      connected: polyConnected,
      uptime: wsManager.getConnectionUptime('polymarket'),
      lastHeartbeat: wsManager.getLastHeartbeat('polymarket'),
    },
    kalshi: {
      connected: kalshiConnected,
      uptime: wsManager.getConnectionUptime('kalshi'),
      lastHeartbeat: wsManager.getLastHeartbeat('kalshi'),
    },
    allHealthy: polyConnected && kalshiConnected,
  };
}
```

### 3.2 Event Matching Service

The most critical component - maps equivalent events across platforms.

```typescript
interface EventMatcher {
  // Build initial mapping from known event pairs
  buildMappings(): Promise<EventMapping[]>;
  
  // Find Kalshi equivalent for a Polymarket event
  findKalshiEquivalent(polymarketId: string): KalshiMarket | null;
  
  // Confidence score for match quality
  getMatchConfidence(mapping: EventMapping): number;
  
  // Manual override for edge cases
  addManualMapping(polyId: string, kalshiTicker: string): void;
}

interface EventMapping {
  polymarketConditionId: string;
  kalshiTicker: string;
  eventDescription: string;
  matchConfidence: number;      // 0-1 score
  resolutionDate: Date;
  matchMethod: 'exact' | 'fuzzy' | 'manual';
  
  // Outcome mapping (critical for multi-outcome markets)
  outcomeMapping: {
    polymarketOutcome: string;
    kalshiSide: 'yes' | 'no';
  }[];
}
```

#### Matching Strategies

1. **Exact Title Match:** Normalize and compare event titles (confidence: 1.0)
2. **Fuzzy Matching:** Levenshtein distance + keyword extraction (confidence: 0.95+ required)
3. **Category + Date Matching:** Same category + same resolution date (supplementary validation)
4. **Manual Curation:** Maintain a curated list of known pairs (confidence: 1.0)
5. **LLM-Assisted:** Use GPT/Claude to assess equivalence (supplementary validation only)

#### Confidence Threshold Policy

**CRITICAL:** The bot will ONLY trade on event mappings with confidence ≥ 0.95.

| Confidence Level | Action |
|-----------------|--------|
| 1.0 (exact/manual) | Trade automatically |
| 0.95 - 0.99 | Trade automatically with logging |
| 0.90 - 0.94 | **REJECT** - Do not trade |
| < 0.90 | **REJECT** - Do not trade |

```typescript
const MATCHING_CONFIG = {
  minConfidenceThreshold: 0.95,  // HARD FLOOR - never trade below this
  exactMatchConfidence: 1.0,
  fuzzyMatchMinSimilarity: 0.95, // Raised from 0.85
  requireDateValidation: true,   // Dates must align within 24 hours
  requireCategoryMatch: true,    // Categories must be compatible
};

// Example matching logic
function matchEvents(polyEvent: PolymarketMarket, kalshiEvents: KalshiMarket[]): EventMapping | null {
  // Normalize titles
  const polyTitle = normalize(polyEvent.question);

  for (const kalshi of kalshiEvents) {
    const kalshiTitle = normalize(kalshi.title);

    // Exact match
    if (polyTitle === kalshiTitle) {
      return createMapping(polyEvent, kalshi, 1.0, 'exact');
    }

    // Fuzzy match - STRICT threshold
    const similarity = levenshteinSimilarity(polyTitle, kalshiTitle);
    if (similarity >= MATCHING_CONFIG.fuzzyMatchMinSimilarity) {
      // REQUIRED: Additional validation - dates must align
      if (!datesMatch(polyEvent.endDate, kalshi.expirationTime, 24 * 60 * 60 * 1000)) {
        continue; // Skip if dates don't match within 24 hours
      }

      // REQUIRED: Category validation
      if (!categoriesCompatible(polyEvent, kalshi)) {
        continue; // Skip if categories don't align
      }

      return createMapping(polyEvent, kalshi, similarity, 'fuzzy');
    }
  }

  return null;
}

// Validation before any trade
function canTradeOnMapping(mapping: EventMapping): boolean {
  if (mapping.matchConfidence < MATCHING_CONFIG.minConfidenceThreshold) {
    logger.warn(`Rejecting trade: confidence ${mapping.matchConfidence} below threshold`);
    return false;
  }
  return true;
}
```

### 3.3 Arbitrage Opportunity Detector

```typescript
interface ArbitrageDetector {
  // Continuously scan for opportunities
  scanForOpportunities(): Observable<ArbitrageOpportunity>;
  
  // Calculate profit after all fees
  calculateNetProfit(opp: ArbitrageOpportunity): ProfitCalculation;
  
  // Check if opportunity is still valid
  validateOpportunity(opp: ArbitrageOpportunity): boolean;
}

interface ArbitrageOpportunity {
  id: string;
  timestamp: Date;
  eventMapping: EventMapping;
  
  // The trade
  buyPlatform: 'polymarket' | 'kalshi';
  buyPrice: number;           // Price to buy YES
  buyQuantity: number;        // Max available at this price
  
  sellPlatform: 'polymarket' | 'kalshi';
  sellPrice: number;          // Price to sell YES (or buy NO)
  sellQuantity: number;
  
  // Economics
  grossSpread: number;        // sellPrice - buyPrice
  estimatedFees: number;
  netProfit: number;          // Per contract/share
  maxQuantity: number;        // Limited by min liquidity
  
  // Risk metrics
  executionRisk: number;      // 0-1, based on liquidity depth
  expirationTime: Date;
}

// Core arbitrage detection logic
function detectArbitrage(
  polyBook: OrderBook,
  kalshiBook: OrderBook,
  mapping: EventMapping
): ArbitrageOpportunity | null {
  
  // Normalize prices to same scale (0-1)
  const polyYesBid = polyBook.bids[0]?.price || 0;
  const polyYesAsk = polyBook.asks[0]?.price || 1;
  const kalshiYesBid = kalshiBook.bids[0]?.price / 100;  // Kalshi uses cents
  const kalshiYesAsk = kalshiBook.asks[0]?.price / 100;
  
  // Case 1: Buy on Polymarket, Sell on Kalshi
  if (polyYesAsk < kalshiYesBid) {
    const spread = kalshiYesBid - polyYesAsk;
    const fees = estimateFees('polymarket', 'kalshi', polyYesAsk, kalshiYesBid);
    
    if (spread > fees + MIN_PROFIT_THRESHOLD) {
      return {
        buyPlatform: 'polymarket',
        buyPrice: polyYesAsk,
        sellPlatform: 'kalshi',
        sellPrice: kalshiYesBid,
        grossSpread: spread,
        estimatedFees: fees,
        netProfit: spread - fees,
        // ... other fields
      };
    }
  }
  
  // Case 2: Buy on Kalshi, Sell on Polymarket
  if (kalshiYesAsk < polyYesBid) {
    const spread = polyYesBid - kalshiYesAsk;
    const fees = estimateFees('kalshi', 'polymarket', kalshiYesAsk, polyYesBid);
    
    if (spread > fees + MIN_PROFIT_THRESHOLD) {
      return {
        buyPlatform: 'kalshi',
        buyPrice: kalshiYesAsk,
        sellPlatform: 'polymarket',
        sellPrice: polyYesBid,
        grossSpread: spread,
        estimatedFees: fees,
        netProfit: spread - fees,
        // ... other fields
      };
    }
  }
  
  return null;
}
```

### 3.4 Fee Calculation

```typescript
interface FeeCalculator {
  polymarketFees(side: 'buy' | 'sell', price: number, quantity: number): number;
  kalshiFees(side: 'buy' | 'sell', price: number, quantity: number): number;
  totalRoundtripFees(opp: ArbitrageOpportunity): number;
}

// Fee estimation
function estimateFees(
  buyPlatform: Platform,
  sellPlatform: Platform,
  buyPrice: number,
  sellPrice: number
): number {
  let fees = 0;
  
  // Polymarket: ~1% maker rebate, ~2% taker fee (approximate)
  if (buyPlatform === 'polymarket') {
    fees += buyPrice * 0.02;  // Taker fee on buy
  }
  if (sellPlatform === 'polymarket') {
    fees += (1 - sellPrice) * 0.02;  // Fee on winnings if YES wins
  }
  
  // Kalshi: 7% on profits, max $0.07 per contract
  if (buyPlatform === 'kalshi') {
    // No fee on buy
  }
  if (sellPlatform === 'kalshi') {
    const potentialProfit = 1 - sellPrice;  // If YES wins
    fees += Math.min(potentialProfit * 0.07, 0.07);
  }
  
  return fees;
}
```

### 3.5 Execution Engine

#### Order Type Policy: FOK (Fill-or-Kill) Only

**CRITICAL:** All orders MUST be Fill-or-Kill (FOK) to prevent partial fills.

FOK orders either:
- Fill completely at the specified price or better, OR
- Are cancelled entirely with no fill

This eliminates the risk of unhedged positions from partial fills.

```typescript
interface ExecutionEngine {
  // Execute an arbitrage opportunity (FOK orders only)
  execute(opp: ArbitrageOpportunity): Promise<ExecutionResult>;

  // NO partial fill handling - FOK prevents this scenario
  // handlePartialFill is intentionally omitted

  // Circuit breaker controls
  pause(reason: string): void;
  resume(): void;
  isPaused(): boolean;
}

interface ExecutionResult {
  success: boolean;
  buyExecution: OrderExecution | null;
  sellExecution: OrderExecution | null;
  actualProfit: number;
  slippage: number;
  errors?: string[];
  circuitBreakerTriggered: boolean;
}

interface FOKOrderParams {
  orderType: 'FOK';           // ALWAYS FOK
  price: number;              // Exact price (no worse)
  quantity: number;           // Exact quantity (no partial)
  timeoutMs: number;          // Max wait time
  maxSlippage: number;        // Abort if slippage exceeds this
}

// Execution strategy - FOK orders only
async function executeArbitrage(opp: ArbitrageOpportunity): Promise<ExecutionResult> {
  // Pre-execution validation
  if (circuitBreaker.isPaused()) {
    return { success: false, circuitBreakerTriggered: true, errors: ['Circuit breaker active'] };
  }

  // Validate slippage before execution
  const currentSpread = await validateCurrentSpread(opp);
  if (currentSpread < opp.netProfit * (1 - SLIPPAGE_CONFIG.maxSlippagePct)) {
    logger.warn('Spread deteriorated, aborting');
    return { success: false, errors: ['Spread deteriorated below threshold'] };
  }

  const quantity = calculateOptimalQuantity(opp);

  // Build FOK orders
  const buyOrder: FOKOrderParams = {
    orderType: 'FOK',
    price: opp.buyPrice,
    quantity: quantity,
    timeoutMs: 1000,
    maxSlippage: SLIPPAGE_CONFIG.maxSlippagePct,
  };

  const sellOrder: FOKOrderParams = {
    orderType: 'FOK',
    price: opp.sellPrice,
    quantity: quantity,
    timeoutMs: 1000,
    maxSlippage: SLIPPAGE_CONFIG.maxSlippagePct,
  };

  // Execute both legs simultaneously
  const [buyResult, sellResult] = await Promise.allSettled([
    executeFOKOrder(opp.buyPlatform, buyOrder),
    executeFOKOrder(opp.sellPlatform, sellOrder),
  ]);

  // Both succeeded - perfect execution
  if (buyResult.status === 'fulfilled' && sellResult.status === 'fulfilled') {
    const actualSlippage = calculateSlippage(opp, buyResult.value, sellResult.value);

    if (actualSlippage > SLIPPAGE_CONFIG.maxSlippagePct) {
      logger.error(`Unexpected slippage: ${actualSlippage}`);
      // Still succeeded, but log for review
    }

    return {
      success: true,
      buyExecution: buyResult.value,
      sellExecution: sellResult.value,
      actualProfit: calculateActualProfit(buyResult.value, sellResult.value),
      slippage: actualSlippage,
      circuitBreakerTriggered: false,
    };
  }

  // One or both FOK orders were rejected (not filled) - this is EXPECTED behavior
  // FOK rejection means: no fill happened, no position opened, no risk
  if (buyResult.status === 'rejected' && sellResult.status === 'rejected') {
    // Both rejected - no action needed, opportunity expired
    return {
      success: false,
      buyExecution: null,
      sellExecution: null,
      actualProfit: 0,
      slippage: 0,
      errors: ['Both FOK orders rejected - opportunity expired'],
      circuitBreakerTriggered: false,
    };
  }

  // CRITICAL: One succeeded, one failed - this should be rare with FOK
  // but possible due to timing. PAUSE AND ALERT.
  logger.error('CRITICAL: Asymmetric FOK execution - one leg filled, one rejected');

  circuitBreaker.pause('Asymmetric FOK execution');
  await alerting.sendCriticalAlert({
    type: 'ASYMMETRIC_EXECUTION',
    buyResult: buyResult.status,
    sellResult: sellResult.status,
    opportunity: opp,
  });

  return {
    success: false,
    buyExecution: buyResult.status === 'fulfilled' ? buyResult.value : null,
    sellExecution: sellResult.status === 'fulfilled' ? sellResult.value : null,
    actualProfit: 0,
    slippage: 0,
    errors: ['Asymmetric execution - circuit breaker triggered'],
    circuitBreakerTriggered: true,
  };
}

// Slippage configuration
const SLIPPAGE_CONFIG = {
  maxSlippagePct: 0.01,        // 1% maximum slippage tolerance
  preTradeValidation: true,    // Always validate spread before trading
  abortOnSlippageExceeded: true,
};
```

### 3.6 Position & Risk Management

#### Conservative Risk Limits

**CRITICAL:** All limits are set to very conservative values for safety.

```typescript
interface PositionManager {
  // Track open positions across both platforms
  getPositions(): Position[];

  // Net exposure calculation
  getNetExposure(eventId: string): ExposureReport;

  // Track P&L
  getUnrealizedPnL(): number;
  getRealizedPnL(): number;

  // Inventory management
  getNetInventory(eventId: string): InventoryReport;
  preferReducingTrades(eventId: string): boolean;
}

interface InventoryReport {
  eventId: string;
  polymarketYesQty: number;
  polymarketNoQty: number;
  kalshiYesQty: number;
  kalshiNoQty: number;
  netPosition: number;           // Positive = long YES, Negative = short YES
  imbalanceUsd: number;          // Dollar value of imbalance
  needsRebalancing: boolean;
}

interface RiskManager {
  // Pre-trade checks
  canExecute(opp: ArbitrageOpportunity): RiskCheck;

  // Position limits
  checkPositionLimits(eventId: string, additionalQuantity: number): boolean;

  // Capital allocation
  getAvailableCapital(platform: Platform): number;

  // Exposure limits
  maxExposurePerEvent: number;
  maxTotalExposure: number;
  maxPositionImbalance: number;  // Allowed net position per event

  // Circuit breaker interface
  circuitBreaker: CircuitBreaker;
}

interface RiskCheck {
  approved: boolean;
  reasons?: string[];
  warnings?: string[];
  suggestedQuantity?: number;  // Reduced quantity if limits hit
}

// ============================================
// CONSERVATIVE RISK PARAMETERS ($100 LIMITS)
// ============================================
const RISK_PARAMS = {
  // Position limits - VERY CONSERVATIVE
  maxExposurePerEvent: 100,      // $100 max per event
  maxTotalExposure: 100,         // $100 total across all events
  maxPositionImbalance: 10,      // $10 max unhedged exposure

  // Trade thresholds
  minProfitThreshold: 0.03,      // 3% minimum spread after fees (conservative)
  maxSlippageTolerance: 0.01,    // 1% max slippage
  minLiquidityDepth: 50,         // Minimum 50 shares available

  // Loss limits
  dailyLossLimit: 20,            // $20 daily loss limit - stop trading
  perTradeLossLimit: 10,         // $10 max loss per trade

  // Quantity limits
  maxQuantityPerTrade: 50,       // Max 50 contracts per trade
  minQuantityPerTrade: 1,        // Min 1 contract

  // Circuit breaker thresholds
  maxConsecutiveFailures: 3,     // Pause after 3 failed executions
  maxAsymmetricExecutions: 1,    // Pause after 1 one-legged trade
};

// Pre-trade risk validation
function validateRisk(opp: ArbitrageOpportunity, quantity: number): RiskCheck {
  const checks: string[] = [];
  const warnings: string[] = [];

  // Check total exposure
  const currentExposure = positionManager.getTotalExposure();
  if (currentExposure + (quantity * opp.buyPrice) > RISK_PARAMS.maxTotalExposure) {
    checks.push(`Total exposure would exceed $${RISK_PARAMS.maxTotalExposure} limit`);
  }

  // Check per-event exposure
  const eventExposure = positionManager.getEventExposure(opp.eventMapping.id);
  if (eventExposure + (quantity * opp.buyPrice) > RISK_PARAMS.maxExposurePerEvent) {
    checks.push(`Event exposure would exceed $${RISK_PARAMS.maxExposurePerEvent} limit`);
  }

  // Check imbalance
  const inventory = positionManager.getNetInventory(opp.eventMapping.id);
  if (Math.abs(inventory.imbalanceUsd) > RISK_PARAMS.maxPositionImbalance) {
    checks.push(`Position imbalance exceeds $${RISK_PARAMS.maxPositionImbalance}`);
  }

  // Check daily loss
  const dailyPnL = positionManager.getDailyPnL();
  if (dailyPnL < -RISK_PARAMS.dailyLossLimit) {
    checks.push(`Daily loss limit of $${RISK_PARAMS.dailyLossLimit} reached`);
  }

  // Check profit threshold
  if (opp.netProfit / opp.buyPrice < RISK_PARAMS.minProfitThreshold) {
    checks.push(`Net profit ${(opp.netProfit / opp.buyPrice * 100).toFixed(1)}% below ${RISK_PARAMS.minProfitThreshold * 100}% threshold`);
  }

  // Check liquidity
  if (opp.maxQuantity < RISK_PARAMS.minLiquidityDepth) {
    warnings.push(`Low liquidity: only ${opp.maxQuantity} available`);
  }

  return {
    approved: checks.length === 0,
    reasons: checks.length > 0 ? checks : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    suggestedQuantity: Math.min(quantity, RISK_PARAMS.maxQuantityPerTrade),
  };
}
```

### 3.7 Inventory Management

Tracks net position per event and prefers trades that reduce imbalance.

```typescript
interface InventoryManager {
  // Get current inventory state
  getInventory(eventId: string): InventoryReport;

  // Check if trade reduces imbalance
  tradeReducesImbalance(eventId: string, side: 'buy' | 'sell', platform: Platform): boolean;

  // Calculate optimal trade direction
  getPreferredDirection(eventId: string): 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly' | 'neutral';
}

// Inventory-aware opportunity scoring
function scoreOpportunity(opp: ArbitrageOpportunity): number {
  let score = opp.netProfit;

  // Bonus for trades that reduce inventory imbalance
  const inventory = inventoryManager.getInventory(opp.eventMapping.id);

  if (inventory.needsRebalancing) {
    const direction = opp.buyPlatform === 'polymarket'
      ? 'buy_poly_sell_kalshi'
      : 'buy_kalshi_sell_poly';

    const preferredDirection = inventoryManager.getPreferredDirection(opp.eventMapping.id);

    if (direction === preferredDirection) {
      score *= 1.2;  // 20% bonus for rebalancing trades
    }
  }

  return score;
}
```

### 3.8 Circuit Breaker

Automatic pause mechanism when errors occur.

```typescript
interface CircuitBreaker {
  // State
  isPaused(): boolean;
  getPauseReason(): string | null;
  getPausedAt(): Date | null;

  // Controls
  pause(reason: string): void;
  resume(): void;

  // Automatic triggers
  recordFailure(type: FailureType): void;
  recordSuccess(): void;
}

type FailureType =
  | 'EXECUTION_FAILURE'
  | 'ASYMMETRIC_EXECUTION'
  | 'CONNECTION_LOST'
  | 'RATE_LIMIT_EXCEEDED'
  | 'DAILY_LOSS_LIMIT';

class CircuitBreakerImpl implements CircuitBreaker {
  private paused: boolean = false;
  private pauseReason: string | null = null;
  private pausedAt: Date | null = null;
  private consecutiveFailures: number = 0;
  private asymmetricExecutions: number = 0;

  recordFailure(type: FailureType): void {
    this.consecutiveFailures++;

    if (type === 'ASYMMETRIC_EXECUTION') {
      this.asymmetricExecutions++;
    }

    // Auto-pause conditions
    if (this.consecutiveFailures >= RISK_PARAMS.maxConsecutiveFailures) {
      this.pause(`${this.consecutiveFailures} consecutive failures`);
    }

    if (this.asymmetricExecutions >= RISK_PARAMS.maxAsymmetricExecutions) {
      this.pause(`${this.asymmetricExecutions} asymmetric executions - manual review required`);
    }

    if (type === 'DAILY_LOSS_LIMIT') {
      this.pause('Daily loss limit reached');
    }

    if (type === 'CONNECTION_LOST') {
      this.pause('Connection lost to exchange');
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;  // Reset on success
  }

  pause(reason: string): void {
    this.paused = true;
    this.pauseReason = reason;
    this.pausedAt = new Date();

    logger.error(`CIRCUIT BREAKER TRIGGERED: ${reason}`);

    // Send alert - ALWAYS notify on pause
    alerting.sendCriticalAlert({
      type: 'CIRCUIT_BREAKER',
      reason: reason,
      timestamp: this.pausedAt,
      action: 'Bot paused - manual intervention required',
    });
  }

  resume(): void {
    logger.info(`Circuit breaker resumed. Was paused for: ${this.pauseReason}`);
    this.paused = false;
    this.pauseReason = null;
    this.pausedAt = null;
    this.consecutiveFailures = 0;
    this.asymmetricExecutions = 0;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getPauseReason(): string | null {
    return this.pauseReason;
  }

  getPausedAt(): Date | null {
    return this.pausedAt;
  }
}
```

---

## 4. Data Models

### 4.1 Database Schema

```sql
-- Event mappings
CREATE TABLE event_mappings (
  id UUID PRIMARY KEY,
  polymarket_condition_id VARCHAR(66) NOT NULL,
  kalshi_ticker VARCHAR(50) NOT NULL,
  description TEXT,
  match_confidence DECIMAL(3,2),
  match_method VARCHAR(20),
  resolution_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(polymarket_condition_id, kalshi_ticker)
);

-- Arbitrage opportunities detected
CREATE TABLE opportunities (
  id UUID PRIMARY KEY,
  event_mapping_id UUID REFERENCES event_mappings(id),
  detected_at TIMESTAMP DEFAULT NOW(),
  buy_platform VARCHAR(20),
  buy_price DECIMAL(10,6),
  buy_quantity DECIMAL(18,6),
  sell_platform VARCHAR(20),
  sell_price DECIMAL(10,6),
  sell_quantity DECIMAL(18,6),
  gross_spread DECIMAL(10,6),
  estimated_fees DECIMAL(10,6),
  net_profit DECIMAL(10,6),
  was_executed BOOLEAN DEFAULT FALSE,
  expired_at TIMESTAMP
);

-- Executions
CREATE TABLE executions (
  id UUID PRIMARY KEY,
  opportunity_id UUID REFERENCES opportunities(id),
  executed_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20),  -- 'pending', 'partial', 'complete', 'failed'
  
  -- Buy leg
  buy_order_id VARCHAR(100),
  buy_fill_price DECIMAL(10,6),
  buy_fill_quantity DECIMAL(18,6),
  buy_fees DECIMAL(10,6),
  
  -- Sell leg
  sell_order_id VARCHAR(100),
  sell_fill_price DECIMAL(10,6),
  sell_fill_quantity DECIMAL(18,6),
  sell_fees DECIMAL(10,6),
  
  -- Results
  actual_profit DECIMAL(10,6),
  slippage DECIMAL(10,6),
  notes TEXT
);

-- Positions
CREATE TABLE positions (
  id UUID PRIMARY KEY,
  platform VARCHAR(20),
  event_id VARCHAR(100),  -- platform-specific event ID
  event_mapping_id UUID REFERENCES event_mappings(id),
  side VARCHAR(10),  -- 'yes' or 'no'
  quantity DECIMAL(18,6),
  avg_price DECIMAL(10,6),
  current_price DECIMAL(10,6),
  unrealized_pnl DECIMAL(10,6),
  opened_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- P&L tracking
CREATE TABLE pnl_records (
  id UUID PRIMARY KEY,
  date DATE,
  platform VARCHAR(20),
  realized_pnl DECIMAL(12,6),
  unrealized_pnl DECIMAL(12,6),
  fees_paid DECIMAL(12,6),
  volume_traded DECIMAL(18,6),
  num_trades INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 5. API Specifications

### 5.1 Polymarket API

```typescript
// Base URL: https://clob.polymarket.com

// Get all markets
GET /markets
Response: {
  markets: PolymarketMarket[]
}

// Get orderbook
GET /book?token_id={tokenId}
Response: {
  bids: { price: string, size: string }[],
  asks: { price: string, size: string }[],
  timestamp: string
}

// WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market
// Subscribe message:
{
  "type": "subscribe",
  "channel": "book",
  "assets_ids": ["token_id_1", "token_id_2"]
}

// Place order (requires CLOB API key + wallet signature)
POST /order
Body: {
  tokenId: string,
  side: 'buy' | 'sell',
  price: string,
  size: string,
  orderType: 'GTC' | 'FOK' | 'GTD',
  signature: string,
  // ... other fields
}
```

### 5.2 Kalshi API

```typescript
// Base URL: https://trading-api.kalshi.com/trade-api/v2

// Authentication
POST /login
Body: { email: string, password: string }
Response: { token: string, member_id: string }

// Get markets
GET /markets?status=open&cursor={cursor}
Response: {
  markets: KalshiMarket[],
  cursor: string
}

// Get orderbook
GET /markets/{ticker}/orderbook
Response: {
  yes: { price: number, quantity: number }[],
  no: { price: number, quantity: number }[],
  timestamp: string
}

// WebSocket: wss://trading-api.kalshi.com/trade-api/ws/v2
// Requires authentication token

// Place order
POST /portfolio/orders
Body: {
  ticker: string,
  action: 'buy' | 'sell',
  side: 'yes' | 'no',
  type: 'limit' | 'market',
  count: number,
  yes_price?: number,  // in cents
  no_price?: number,
  expiration_ts?: number
}
```

---

## 6. Configuration

```yaml
# config.yaml
# CONSERVATIVE CONFIGURATION - $100 limits

# Platform credentials
polymarket:
  api_key: ${POLYMARKET_API_KEY}
  private_key: ${POLYMARKET_PRIVATE_KEY}  # For signing
  rpc_url: "https://polygon-rpc.com"

kalshi:
  email: ${KALSHI_EMAIL}
  password: ${KALSHI_PASSWORD}
  api_base: "https://trading-api.kalshi.com/trade-api/v2"

# Trading parameters - CONSERVATIVE
trading:
  min_profit_threshold: 0.03      # 3% minimum profit after fees
  max_position_per_event: 100     # $100 max per event
  max_total_exposure: 100         # $100 total exposure
  min_liquidity: 50               # Minimum depth required
  max_slippage: 0.01              # 1% max slippage
  execution_timeout_ms: 1000      # 1 second order timeout (FOK)
  order_type: "FOK"               # Fill-or-Kill only

# Event matching
matching:
  min_confidence_threshold: 0.95  # Only trade high-confidence matches
  require_date_validation: true   # Dates must align
  require_category_match: true    # Categories must match

# Risk management - CONSERVATIVE
risk:
  max_imbalance: 10               # $10 max unhedged exposure
  daily_loss_limit: 20            # Stop trading after $20 daily loss
  per_trade_loss_limit: 10        # $10 max loss per trade
  max_quantity_per_trade: 50      # Max 50 contracts per trade

# Circuit breaker
circuit_breaker:
  max_consecutive_failures: 3     # Pause after 3 failures
  max_asymmetric_executions: 1    # Pause after 1 one-legged trade
  auto_resume: false              # Require manual resume

# WebSocket configuration
websocket:
  max_reconnect_attempts: 5
  initial_delay_ms: 1000
  max_delay_ms: 30000
  backoff_multiplier: 2
  heartbeat_interval_ms: 5000
  heartbeat_timeout_ms: 30000

# Rate limiting - conservative to avoid bans
rate_limits:
  polymarket:
    market_data_per_minute: 60
    orders_per_minute: 30
    min_request_interval_ms: 1000
  kalshi:
    read_per_second: 5
    write_per_second: 2
    min_request_interval_ms: 500

# Latency thresholds
latency:
  orderbook_fetch_target_ms: 100
  orderbook_fetch_max_ms: 500
  order_placement_target_ms: 200
  order_placement_max_ms: 1000
  end_to_end_max_ms: 2000

# Monitoring
monitoring:
  alert_on_execution_failure: true
  alert_on_circuit_breaker: true
  alert_on_large_opportunity: 50  # Alert if >$50 opportunity
  metrics_port: 9090

# Database
database:
  host: localhost
  port: 5432
  name: arb_bot
  user: ${DB_USER}
  password: ${DB_PASSWORD}
```

---

## 7. Operational Considerations

### 7.1 Capital Management

**CONSERVATIVE ALLOCATION - $100 Total**

```
┌─────────────────────────────────────────────────────────────┐
│               CONSERVATIVE CAPITAL ALLOCATION               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Total Capital: $100 (MAXIMUM)                              │
│                                                             │
│  ┌──────────────────┐    ┌──────────────────┐              │
│  │   Polymarket     │    │     Kalshi       │              │
│  │   $50 USDC       │    │   $50 USD        │              │
│  │   (on Polygon)   │    │   (in account)   │              │
│  └──────────────────┘    └──────────────────┘              │
│                                                             │
│  Reserve: $10 (for gas fees on Polygon)                    │
│                                                             │
│  Risk Limits:                                               │
│  - Max per event: $100                                      │
│  - Max total exposure: $100                                 │
│  - Max imbalance: $10                                       │
│  - Daily loss limit: $20                                    │
│                                                             │
│  Rebalance triggers:                                        │
│  - Platform balance < $20                                   │
│  - Manual only (no auto-rebalance at this scale)           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Rebalancing

Capital will naturally accumulate on one platform. Rebalancing process:

1. **Polymarket → Kalshi:**
   - Withdraw USDC to Ethereum
   - Bridge to mainnet or offramp via Coinbase/etc
   - Deposit USD to Kalshi

2. **Kalshi → Polymarket:**
   - Withdraw USD from Kalshi (T+1)
   - Buy USDC
   - Bridge to Polygon
   - Deposit to Polymarket wallet

**Estimated rebalancing costs:** ~1-2% (bridge fees, spread, gas)

### 7.3 Settlement Risk

- **Timing mismatch:** Polymarket settles immediately on-chain; Kalshi settles T+1
- **Resolution disputes:** Rare but possible
- **Mitigation:** Only trade events with clear, objective resolution criteria

### 7.4 Regulatory Considerations

- Kalshi is CFTC-regulated; users must be US residents
- Polymarket technically not available to US users
- Consider legal/compliance review before operating

---

## 8. Monitoring & Alerts

### 8.1 Metrics to Track

```typescript
// Prometheus metrics
const metrics = {
  // Performance
  opportunities_detected: Counter,
  opportunities_executed: Counter,
  execution_success_rate: Gauge,
  
  // Latency
  opportunity_detection_latency_ms: Histogram,
  execution_latency_ms: Histogram,
  
  // Financial
  realized_pnl_usd: Gauge,
  unrealized_pnl_usd: Gauge,
  total_volume_usd: Counter,
  
  // Risk
  current_exposure: Gauge,
  position_imbalance: Gauge,
  
  // Health
  polymarket_ws_connected: Gauge,
  kalshi_ws_connected: Gauge,
  last_opportunity_time: Gauge,
};
```

### 8.2 Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| Execution Failure | Any FOK order rejected | Medium | Log and continue |
| Asymmetric Execution | One leg fills, other rejects | Critical | **PAUSE + ALERT** |
| Circuit Breaker Triggered | Any circuit breaker event | Critical | **PAUSE + ALERT** |
| Position Imbalance | > $10 unhedged | High | Block new trades |
| Connection Lost | WS disconnected > 30s | Critical | **PAUSE + ALERT** |
| Daily Loss Limit | > $20 daily loss | Critical | **PAUSE + ALERT** |
| Low Confidence Match | Match < 0.95 attempted | High | Block trade |
| Large Opportunity | > $50 opportunity | Medium | Log for review |
| Low Balance | < $20 on either platform | Medium | Alert only |
| Rate Limit Warning | > 80% of rate limit | Medium | Slow down requests |
| Latency Exceeded | Order placement > 1s | High | Skip opportunity |

---

## 9. Testing Strategy

### 9.1 Unit Tests
- Fee calculation accuracy
- Opportunity detection logic
- Event matching algorithms

### 9.2 Integration Tests
- API connectivity
- Order placement (using test/paper accounts)
- WebSocket reliability

### 9.3 Paper Trading
- Run full system with real market data
- Log hypothetical trades
- Measure expected vs actual prices

### 9.4 Gradual Rollout (Conservative)
1. Start with $100 total capital ($50 per platform)
2. Limit to 1-2 event pairs initially (high confidence only)
3. Monitor for at least 50 successful trades before considering any scaling
4. Review all circuit breaker events before resuming
5. Never exceed $100 total exposure

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] Set up project structure
- [ ] Implement Polymarket connector
- [ ] Implement Kalshi connector
- [ ] Basic event matching (manual curation)
- [ ] Database setup

### Phase 2: Detection (Week 3-4)
- [ ] Real-time orderbook aggregation
- [ ] Arbitrage opportunity detection
- [ ] Fee calculation
- [ ] Logging and metrics

### Phase 3: Execution (Week 5-6)
- [ ] Order placement logic
- [ ] Position tracking
- [ ] Risk management checks
- [ ] Error handling and recovery

### Phase 4: Operations (Week 7-8)
- [ ] Monitoring dashboard
- [ ] Alerting system
- [ ] Paper trading validation
- [ ] Production deployment

### Phase 5: Optimization (Ongoing)
- [ ] Improve event matching (ML/LLM)
- [ ] Reduce latency
- [ ] Advanced execution strategies
- [ ] Auto-rebalancing

---

## Appendix A: Example Arbitrage Calculation

### Conservative Example (Within $100 Limits)

**Scenario:**
- Event: "Will BTC be above $100k on Dec 31, 2025?"
- Polymarket YES price: $0.45 (ask)
- Kalshi YES price: $0.52 (bid)
- Spread: 7 cents (15.6%)

**Trade (Conservative Limits):**
- Buy 50 YES on Polymarket @ $0.45 = $22.50 cost
- Sell 50 YES on Kalshi @ $0.52 = $26.00 received

**Gross profit:** $3.50 (15.6% return on capital)

**Fees:**
- Polymarket taker fee: ~$0.45 (2% of $22.50)
- Kalshi fee if win: ~$0.25 (7% of profit, capped at $0.07/contract)

**Net profit:** ~$2.80 (12.4% return)

**Risk Mitigation (FOK Orders):**
- Both orders are Fill-or-Kill
- If either order can't fill completely at the specified price, it's cancelled
- No partial fills = No unhedged exposure
- Worst case: Both FOK orders rejected, no position opened

**Validation Checks:**
- ✅ Net profit 12.4% > 3% threshold
- ✅ Trade size $22.50 < $100 max per event
- ✅ Total exposure $22.50 < $100 max total
- ✅ Confidence threshold met (assumed ≥ 0.95)

---

## Appendix B: Known Event Pairs (Starter List)

| Polymarket | Kalshi | Category |
|------------|--------|----------|
| "Will X win 2024 election" | "PRES-24" | Politics |
| "Will Fed raise rates in Q1" | "FED-RATE-Q1" | Economics |
| "BTC above $X by date" | "BTC-X-DATE" | Crypto |
| "Will company X IPO" | "IPO-X" | Markets |

---

## Appendix C: Tech Stack Recommendations

- **Language:** TypeScript/Node.js (good async support, both APIs have JS SDKs)
- **Database:** PostgreSQL (relational, good for financial data)
- **Cache:** Redis (orderbook caching, rate limiting)
- **Queue:** Bull/BullMQ (job queue for executions)
- **Monitoring:** Prometheus + Grafana
- **Alerting:** PagerDuty or Telegram bot
- **Deployment:** Docker + Kubernetes or simple VPS

---

*Last updated: January 2025*
*Version: 2.0.0 - Conservative Edition*

---

## Changelog

### v2.0.0 (January 2025)
- Added regulatory disclaimer
- Implemented FOK (Fill-or-Kill) order strategy to prevent partial fills
- Added circuit breaker with pause-and-alert behavior
- Set conservative risk limits ($100 max exposure)
- Added 0.95 minimum confidence threshold for event matching
- Added WebSocket reconnection strategy with exponential backoff
- Documented API rate limits for both platforms
- Added latency requirements and monitoring
- Added inventory/imbalance management
- Added slippage protection enforcement
- Updated all examples to reflect conservative limits
