export interface RateLimitOptions {
  identifier: string;
  limit: number;
  windowMs: number;
  algorithm?: 'sliding-counter' | 'fixed-window' | 'sliding-log';
}

export interface RateLimitResponse {
  allowed: boolean;
  remaining: number;
  reset: number;
}

export class RateLimiter {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl: string = 'http://localhost:3000') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  async check(options: RateLimitOptions): Promise<RateLimitResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key');
      }
      const error = await response.json();
      throw new Error(error.message || 'Failed to check rate limit');
    }

    return response.json();
  }

  /**
   * Convenience method for simple checks
   */
  async isAllowed(identifier: string, limit: number, windowMs: number): Promise<boolean> {
    const res = await this.check({ identifier, limit, windowMs });
    return res.allowed;
  }
}
