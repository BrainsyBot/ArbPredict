/**
 * Coinbase CDP (Developer Platform) Authentication
 * Uses JWT Bearer token instead of legacy CB-ACCESS-KEY
 */

import axios from 'axios';
import crypto from 'crypto';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('coinbase-cdp');

export class CoinbaseCDP {
  private readonly baseUrl = 'https://api.coinbase.com';
  private readonly apiKeyId: string;
  private readonly apiSecret: string;

  constructor() {
    this.apiKeyId = process.env.COINBASE_API_KEY_ID || '';
    this.apiSecret = process.env.COINBASE_API_SECRET || '';
    
    if (!this.apiKeyId || !this.apiSecret) {
      throw new Error('Coinbase CDP credentials not configured');
    }
  }

  /**
   * Generate JWT token for CDP authentication
   */
  private generateJWT(method: string, path: string): string {
    const header = {
      alg: 'ES256',
      kid: this.apiKeyId,
      typ: 'JWT',
    };

    const payload = {
      sub: this.apiKeyId,
      iss: 'cdp',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120, // 2 minutes
      uri: method + ' ' + 'api.coinbase.com' + path,
    };

    // Encode header and payload
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const message = encodedHeader + '.' + encodedPayload;

    // Sign with private key (assuming ES256 = ECDSA with SHA-256)
    // If the secret is base64-encoded, decode it first
    const privateKey = Buffer.from(this.apiSecret, 'base64').toString('utf8');
    
    const signature = crypto
      .createSign('SHA256')
      .update(message)
      .sign(privateKey, 'base64url');

    return message + '.' + signature;
  }

  /**
   * Get historical candles using CDP authentication
   */
  async getCandles(productId: string = 'BTC-USD', granularity: string = 'ONE_MINUTE'): Promise<any> {
    try {
      const path = `/api/v3/brokerage/products/${productId}/candles`;
      const jwt = this.generateJWT('GET', path);

      logger.info(`Fetching candles with CDP auth: ${productId} / ${granularity}`);

      const response = await axios.get(`${this.baseUrl}${path}`, {
        params: { granularity },
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error: any) {
      logger.error('Failed to fetch candles with CDP auth', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
      throw error;
    }
  }
}
