import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;
  private scripts: Record<string, string> = {};

  async onModuleInit() {
    this.client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 10,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    this.client.on('error', (err) => {
      if ((err as any).code !== 'ENOTFOUND') {
        console.error('Redis error:', err);
      }
    });
    
    const scriptFiles = [
      { name: 'sliding-counter', file: 'sliding-counter.lua' },
      { name: 'fixed-window', file: 'fixed-window.lua' },
      { name: 'sliding-log', file: 'sliding-log.lua' },
    ];

    // Wait a bit for Redis to be ready
    let retries = 5;
    while (retries > 0) {
      try {
        for (const s of scriptFiles) {
          const luaPath = path.join(__dirname, `../rate-limit/scripts/${s.file}`);
          const luaScript = fs.readFileSync(luaPath, 'utf8');
          this.scripts[s.name] = await this.client.script('LOAD', luaScript) as string;
          console.log(`Loaded script: ${s.name}`);
        }
        break; // Success
      } catch (error) {
        console.warn(`Attempt ${6 - retries} failed to load scripts. Retrying in 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        retries--;
      }
    }

    if (retries === 0) {
      console.error('Failed to load Lua scripts after multiple attempts.');
    }
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  getClient(): Redis {
    return this.client;
  }

  getScriptSha(name: string): string {
    return this.scripts[name];
  }

  getSlidingCounterSha(): string {
    return this.scripts['sliding-counter'];
  }
}
