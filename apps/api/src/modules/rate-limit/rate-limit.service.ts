import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset: number;
}

@Injectable()
export class RateLimitService {
  constructor(private readonly redisService: RedisService) {}

  async check(
    tenantId: string,
    identifier: string,
    limit: number,
    windowMs: number,
    algorithm: 'sliding-counter' | 'fixed-window' | 'sliding-log' = 'sliding-counter',
  ): Promise<RateLimitResult> {
    const redis = this.redisService.getClient();
    const now = Date.now();
    
    if (algorithm === 'sliding-counter') {
      const sha = this.redisService.getScriptSha('sliding-counter');
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const prevWindowStart = windowStart - windowMs;
      const currKey = `rl:{${tenantId}:${identifier}}:sc:${windowStart}`;
      const prevKey = `rl:{${tenantId}:${identifier}}:sc:${prevWindowStart}`;
      
      const result = await redis.evalsha(sha, 2, currKey, prevKey, limit.toString(), windowMs.toString(), now.toString()) as [number, number, number];
      return { allowed: result[0] === 1, remaining: result[1], reset: result[2] };
    }

    if (algorithm === 'fixed-window') {
      const sha = this.redisService.getScriptSha('fixed-window');
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const key = `rl:{${tenantId}:${identifier}}:fw:${windowStart}`;
      
      const result = await redis.evalsha(sha, 1, key, limit.toString(), windowMs.toString()) as [number, number, number];
      return { allowed: result[0] === 1, remaining: result[1], reset: result[2] };
    }

    if (algorithm === 'sliding-log') {
      const sha = this.redisService.getScriptSha('sliding-log');
      const key = `rl:{${tenantId}:${identifier}}:sl`;
      
      const result = await redis.evalsha(sha, 1, key, limit.toString(), windowMs.toString(), now.toString()) as [number, number, number];
      return { allowed: result[0] === 1, remaining: result[1], reset: result[2] };
    }

    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
}
