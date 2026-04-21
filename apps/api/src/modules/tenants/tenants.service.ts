import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import * as crypto from 'crypto';

export interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
}

@Injectable()
export class TenantsService {
  constructor(private readonly redisService: RedisService) {}

  async createTenant(name: string): Promise<Tenant> {
    const id = crypto.randomUUID();
    const apiKey = crypto.randomBytes(32).toString('hex');
    const tenant: Tenant = {
      id,
      name,
      apiKey,
      createdAt: new Date().toISOString(),
    };

    const redis = this.redisService.getClient();
    
    // Store API key to tenant mapping
    await redis.hset(`tenant:${apiKey}`, tenant);
    
    // Store ID to tenant mapping
    await redis.set(`tenant_id:${id}`, apiKey);

    // Track tenant in global set
    await redis.sadd('all_tenants', apiKey);

    return tenant;
  }

  async listTenants(): Promise<Tenant[]> {
    const redis = this.redisService.getClient();
    const apiKeys = await redis.smembers('all_tenants');
    
    const tenants: Tenant[] = [];
    for (const apiKey of apiKeys) {
      const data = await redis.hgetall(`tenant:${apiKey}`);
      if (data && Object.keys(data).length > 0) {
        tenants.push(data as unknown as Tenant);
      }
    }
    
    return tenants;
  }

  async getTenantByApiKey(apiKey: string): Promise<Tenant | null> {
    const redis = this.redisService.getClient();
    const data = await redis.hgetall(`tenant:${apiKey}`);
    
    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return data as unknown as Tenant;
  }
}
