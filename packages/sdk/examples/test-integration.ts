import { RateLimiter } from '../src/index';

async function test() {
  const apiKey = process.env.RL_API_KEY || 'YOUR_API_KEY';
  const baseUrl = process.env.RL_API_URL || 'http://localhost:3000';
  const limiter = new RateLimiter(apiKey, baseUrl);

  console.log('--- Testing Rate Limiter SDK ---');
  console.log('Target: 5 requests per 10 seconds\n');

  for (let i = 1; i <= 7; i++) {
    try {
      const result = await limiter.check({
        identifier: 'user-123',
        limit: 5,
        windowMs: 10000,
        algorithm: 'sliding-counter'
      });

      const status = result.allowed ? '✅ ALLOWED' : '❌ BLOCKED';
      console.log(`Request ${i}: ${status} | Remaining: ${result.remaining} | Reset: ${new Date(result.reset).toLocaleTimeString()}`);
    } catch (error: any) {
      console.error(`Request ${i}: 💥 ERROR: ${error.message}`);
    }
  }
}

test();
