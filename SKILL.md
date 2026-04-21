---
name: ratelimit-saas
description: >
  Full working knowledge of the Distributed Rate Limiter as a Service project.
  Use this skill for ANY task touching this codebase: adding features, fixing bugs,
  writing tests, modifying algorithms, updating the SDK, working on the dashboard,
  changing Redis schema, or scaffolding new modules. Trigger on any mention of
  rate limiter, sliding window, fixed window, Lua script, API key guard, tenant,
  BullMQ worker, SDK publish, metrics SSE, or any file path inside ratelimit-saas/.
---

# Distributed Rate Limiter as a Service — Agent Skill

This document is the complete working knowledge base for any AI agent operating
on this codebase. Read it fully before touching any file. Every section is
load-bearing — skipping sections causes subtle bugs.

---

## Project Summary

A multi-tenant rate limiting microservice. Any developer plugs in the npm SDK
and gets rate limiting in 3 lines of code without writing Redis logic themselves.

The system exposes a `POST /v1/check` endpoint. The client sends an identifier
and gets back `{ allowed: true/false, remaining, resetAt }`. Under the hood,
a Lua script runs atomically on Redis to prevent race conditions.

**Three moving parts:**
1. `apps/api` — NestJS backend, the core service
2. `apps/dashboard` — Next.js admin UI with SSE live metrics
3. `packages/sdk` — npm package `@yourname/ratelimit`

---

## Monorepo Layout

```
ratelimit-saas/
├── pnpm-workspace.yaml
├── docker-compose.yml
├── .env.example
├── apps/
│   ├── api/src/
│   │   ├── main.ts
│   │   ├── app.module.ts
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   │   ├── api-key.guard.ts          ← validates every request
│   │   │   │   ├── api-key.service.ts         ← Redis lookup: key → tenant
│   │   │   │   └── decorators/tenant.decorator.ts
│   │   │   ├── rate-limit/
│   │   │   │   ├── rate-limit.controller.ts
│   │   │   │   ├── rate-limit.service.ts      ← orchestrates algo selection
│   │   │   │   ├── algorithms/
│   │   │   │   │   ├── algorithm.interface.ts
│   │   │   │   │   ├── fixed-window.ts
│   │   │   │   │   ├── sliding-log.ts
│   │   │   │   │   └── sliding-counter.ts     ← primary production algorithm
│   │   │   │   ├── scripts/
│   │   │   │   │   └── sliding-counter.lua    ← atomic Redis Lua script
│   │   │   │   └── dto/
│   │   │   │       ├── check-request.dto.ts
│   │   │   │       └── check-response.dto.ts
│   │   │   ├── tenants/
│   │   │   │   ├── tenants.controller.ts      ← admin: create/list/delete
│   │   │   │   ├── tenants.service.ts
│   │   │   │   └── dto/create-tenant.dto.ts
│   │   │   └── metrics/
│   │   │       ├── metrics.controller.ts      ← SSE stream endpoint
│   │   │       └── metrics.service.ts
│   │   ├── config/
│   │   │   ├── redis.config.ts
│   │   │   └── app.config.ts
│   │   └── common/
│   │       ├── filters/http-exception.filter.ts
│   │       └── interceptors/logging.interceptor.ts
│   │   test/
│   │       ├── rate-limit.e2e.spec.ts
│   │       └── auth.e2e.spec.ts
│   └── dashboard/
│       ├── app/
│       │   ├── page.tsx
│       │   ├── tenants/page.tsx
│       │   └── metrics/page.tsx
│       ├── components/
│       │   ├── MetricsChart.tsx               ← SSE consumer + recharts
│       │   ├── TenantTable.tsx
│       │   └── UsageCard.tsx
│       └── lib/api.ts
└── packages/
    └── sdk/src/
        ├── index.ts
        ├── ratelimit.ts                       ← main class
        ├── types.ts
        └── errors.ts
```

---

## Environment Variables

### `apps/api/.env`
```
REDIS_URL=redis://localhost:6379
ADMIN_SECRET=super_secret_admin_key
PORT=3000
NODE_ENV=development
```

### `apps/dashboard/.env`
```
NEXT_PUBLIC_API_URL=http://localhost:3000
```

### SDK (consumed by end users, not in .env)
```
RL_API_KEY=sk_live_abc123
RL_BASE_URL=https://your-deployed-service.com
```

**Critical:** `ADMIN_SECRET` protects `POST /v1/tenants`. Never expose it in the
SDK or dashboard. It is only read by `ApiKeyGuard` for admin routes.

---

## Redis Key Schema

All keys are namespaced by `tenantId`. Never write a key without the tenant prefix.

```
# Tenant lookup (Hash)
tenant:{apiKey}
  → { id, name, defaultLimit, defaultWindow, defaultAlgorithm, plan }

# Sliding counter algorithm (2 Strings per user)
rl:{tenantId}:{identifier}:{currentWindowTimestamp}   → Integer
rl:{tenantId}:{identifier}:{previousWindowTimestamp}  → Integer

# Sliding log algorithm (Sorted Set per user)
rl:log:{tenantId}:{identifier}
  → Sorted Set { score: timestamp_ms, value: timestamp_ms }

# Fixed window algorithm (String per user per window)
rl:fw:{tenantId}:{identifier}:{windowTimestamp}       → Integer

# Metrics (Strings, reset hourly)
metrics:{tenantId}:allowed:{hourTimestamp}  → Integer
metrics:{tenantId}:blocked:{hourTimestamp}  → Integer

# Admin key registry
admin:keys  → Set of valid admin API keys
```

### TTL Rules
- Sliding counter keys: `EXPIRE = window_seconds * 2`
- Sliding log sorted sets: `EXPIRE = window_seconds * 2`
- Fixed window keys: `EXPIRE = window_seconds` (set only on first INCR using NX flag)
- Metrics keys: `EXPIRE = 7200` (2 hours)
- Tenant hashes: no TTL (permanent until deleted by admin)

### Window Timestamp Calculation
```typescript
// The timestamp used in keys is the start of the current window
const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
const prevWindowStart = windowStart - windowMs;
```

---

## Algorithm Reference

### Algorithm Interface
Every algorithm must implement this interface. Never call Redis directly
from the controller — always go through the algorithm.

```typescript
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;  // requests left in window (0 if blocked)
  resetIn: number;    // seconds until window resets
}

export interface Algorithm {
  check(
    tenantId: string,
    identifier: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult>;
}
```

---

### Algorithm 1: Fixed Window

**When to use:** Simple use cases where boundary bursts are acceptable.
**Redis ops:** `INCR` + `EXPIRE` (NX)
**Race condition risk:** Yes — two simultaneous requests can both read 99 and
both increment to 100, allowing 101st request. Acceptable for non-critical limits.

```typescript
async check(tenantId, identifier, limit, windowMs): Promise<RateLimitResult> {
  const windowTs = Math.floor(Date.now() / windowMs) * windowMs;
  const key = `rl:fw:${tenantId}:${identifier}:${windowTs}`;

  const count = await this.redis.incr(key);
  if (count === 1) {
    await this.redis.expire(key, Math.ceil(windowMs / 1000) * 2);
  }

  const resetIn = Math.ceil((windowTs + windowMs - Date.now()) / 1000);

  if (count > limit) {
    return { allowed: false, remaining: 0, resetIn };
  }
  return { allowed: true, remaining: limit - count, resetIn };
}
```

**The boundary burst problem:** A user can send `limit` requests at second 59
and `limit` more at second 61 — both windows see a valid count. Do not use fixed
window for billing or security-critical limits.

---

### Algorithm 2: Sliding Window Log

**When to use:** Low-traffic use cases requiring perfect accuracy.
**Redis ops:** `ZADD` + `ZREMRANGEBYSCORE` + `ZCARD` + `EXPIRE`
**Memory cost:** One sorted set entry per request per user. At scale this is
prohibitive — 10k users × 1k req/min = 10M entries. Always warn the consumer.

```typescript
async check(tenantId, identifier, limit, windowMs): Promise<RateLimitResult> {
  const now = Date.now();
  const key = `rl:log:${tenantId}:${identifier}`;
  const windowStart = now - windowMs;

  const pipeline = this.redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, now.toString());
  pipeline.zcard(key);
  pipeline.expire(key, Math.ceil(windowMs / 1000) * 2);
  const results = await pipeline.exec();

  const count = results[2][1] as number;
  const resetIn = Math.ceil(windowMs / 1000);

  if (count > limit) {
    // Remove the entry we just added since request is denied
    await this.redis.zrem(key, now.toString());
    return { allowed: false, remaining: 0, resetIn };
  }
  return { allowed: true, remaining: limit - count, resetIn };
}
```

**Note on pipeline:** `ZADD` then `ZCARD` in a pipeline is NOT atomic. Two
simultaneous requests can both read count=4 on a limit of 5 and both be allowed.
For strict accuracy under concurrency, use a Lua script variant of this algorithm.

---

### Algorithm 3: Sliding Window Counter (PRIMARY)

**When to use:** All production use cases. Default algorithm.
**Redis ops:** Atomic Lua script (2 GETs + 1 INCR + 1 EXPIRE)
**Memory cost:** 2 string keys per user regardless of traffic volume.
**Race condition risk:** Zero — Lua script is atomic on Redis.

The formula:
```
rate = prev_count × (1 − elapsed/window_ms) + curr_count
```

The Lua script at `scripts/sliding-counter.lua` is loaded at app startup and
called via `redis.evalsha`. Never rebuild this logic in TypeScript — the
atomicity guarantee is the entire point.

**How to load the script at startup:**

```typescript
// In RedisService or OnModuleInit
const script = fs.readFileSync(
  path.join(__dirname, 'scripts/sliding-counter.lua'),
  'utf-8'
);
this.scriptSha = await this.redis.script('LOAD', script);
```

**How to call it:**

```typescript
const [allowed, remaining, resetIn] = await this.redis.evalsha(
  this.scriptSha,
  2,                            // number of KEYS
  currKey,                      // KEYS[1]
  prevKey,                      // KEYS[2]
  limit.toString(),             // ARGV[1]
  windowMs.toString(),          // ARGV[2]
  Date.now().toString(),        // ARGV[3]
) as [number, number, number];
```

**The Lua script (`scripts/sliding-counter.lua`):**

```lua
local curr_key    = KEYS[1]
local prev_key    = KEYS[2]
local limit       = tonumber(ARGV[1])
local window_ms   = tonumber(ARGV[2])
local now_ms      = tonumber(ARGV[3])

local window_start = math.floor(now_ms / window_ms) * window_ms
local elapsed      = now_ms - window_start
local weight       = 1 - (elapsed / window_ms)

local prev_count = tonumber(redis.call('GET', prev_key) or 0)
local curr_count = tonumber(redis.call('GET', curr_key) or 0)
local rate       = prev_count * weight + curr_count

if rate >= limit then
  local reset_in = math.ceil((window_ms - elapsed) / 1000)
  return { 0, 0, reset_in }
end

local new_count = redis.call('INCR', curr_key)
redis.call('EXPIRE', curr_key, math.ceil(window_ms / 1000) * 2)

local remaining = limit - (prev_count * weight + new_count)
local reset_in  = math.ceil((window_ms - elapsed) / 1000)
return { 1, math.floor(remaining), reset_in }
```

**Critical constraints on the Lua script:**
- Never use `os.time()` inside the script — Redis Cluster forbids non-deterministic
  calls. Always pass `now_ms` as an argument from the application layer.
- The script returns an array of 3 integers: `[allowed(0|1), remaining, resetIn]`
- Both `curr_key` and `prev_key` must be passed as KEYS (not ARGV) for Redis
  Cluster compatibility — keys must be declared so the cluster can route correctly.

---

## API Contracts

### POST /v1/check
Protected by `ApiKeyGuard`. Tenant is injected from the guard into the request.

**Request body:**
```typescript
{
  identifier: string;           // required — e.g. "user_123", IP address
  limit?: number;               // optional, falls back to tenant.defaultLimit
  window?: string;              // optional, e.g. "30s" | "1m" | "1h"
  algorithm?: 'fixed_window'    // optional, defaults to 'sliding_counter'
            | 'sliding_log'
            | 'sliding_counter';
}
```

**Response 200 — allowed:**
```typescript
{
  allowed: true;
  limit: number;
  remaining: number;
  reset_at: number;             // Unix timestamp seconds
  algorithm: string;
  latency_ms: number;
}
```

**Response 429 — blocked:**
```typescript
{
  allowed: false;
  limit: number;
  remaining: 0;
  retry_after: number;          // seconds until window resets
  reset_at: number;
}
```

**Response 401 — missing or invalid API key:**
```json
{ "message": "Missing API key" }
{ "message": "Invalid API key" }
```

**Response 400 — validation error:**
```json
{ "message": "Invalid window format. Use: 30s, 1m, 1h" }
```

---

### GET /v1/status/:identifier
Read-only. Returns current rate limit state without incrementing. Use for
dashboards and preflight checks. Same auth as `/v1/check`.

### DELETE /v1/reset/:identifier
Deletes all Redis keys for this identifier under the authenticated tenant.
Admin use only. Returns `{ reset: true }`.

### GET /v1/metrics (SSE)
Server-Sent Events. One JSON event per 2 seconds. Never close this connection
from the server side — the client manages reconnection.

**Event payload:**
```typescript
{
  tenant_id: string;
  requests_per_sec: number;
  blocked_per_sec: number;
  top_identifiers: Array<{ id: string; count: number }>;
  timestamp: number;
}
```

### POST /v1/tenants (admin)
Protected by `ADMIN_SECRET` header, not a tenant API key.
Header: `x-admin-secret: <ADMIN_SECRET>`

**Request:**
```typescript
{
  name: string;
  default_limit?: number;       // default: 100
  default_window?: string;      // default: "1m"
  default_algorithm?: string;   // default: "sliding_counter"
  plan?: 'free' | 'pro';       // default: "free"
}
```

**Response:**
```typescript
{
  api_key: string;              // "sk_live_<32 random chars>"
  tenant_id: string;
  name: string;
}
```

---

## Auth Flow

Every request to `/v1/*` (except admin routes) goes through `ApiKeyGuard`:

```
Request → ApiKeyGuard
  → Extract "Bearer <key>" from Authorization header
  → redis.hgetall("tenant:<key>")
  → If null → 401
  → If found → attach to request.tenant → continue
```

The guard uses a custom `@Tenant()` decorator to extract the tenant in
controllers:

```typescript
// In controller
@Post('check')
@UseGuards(ApiKeyGuard)
async check(
  @Body() dto: CheckRequestDto,
  @Tenant() tenant: TenantEntity,
) { ... }
```

---

## Window String Parser

The `parseWindow` helper in `rate-limit.service.ts` converts human-readable
window strings to milliseconds. This is the only place this conversion happens.

```typescript
private parseWindow(window: string): number {
  const units = { s: 1000, m: 60_000, h: 3_600_000 };
  const match = window.match(/^(\d+)([smh])$/);
  if (!match) throw new BadRequestException('Invalid window format. Use: 30s, 1m, 1h');
  return parseInt(match[1]) * units[match[2]];
}
```

Valid inputs: `"10s"`, `"30s"`, `"1m"`, `"5m"`, `"1h"`.
Invalid: `"60"`, `"1min"`, `"1 m"`. Always validate at the DTO level with a
regex before it reaches the service.

---

## SDK Behaviour Contract

The SDK (`packages/sdk`) must conform to these rules regardless of any refactor:

1. **Fail-open by default.** If the API is unreachable (network error, timeout),
   return `{ allowed: true, remaining: -1, resetAt: 0 }`. Users can override
   with `failOpen: false` for strict mode.

2. **200ms default timeout.** Abort the fetch after 200ms. Rate limiting must
   never add more latency than a fast cache miss.

3. **No retry on 429.** Only retry on network errors (fetch threw), not on
   intentional 429 responses from the server.

4. **Single retry on network error.** One retry, 50ms delay, then fail-open.

5. **No external dependencies.** The SDK must only use the Node.js built-in
   `fetch` (Node 18+). Zero npm dependencies in `packages/sdk/package.json`.

6. **Full TypeScript types exported.** `CheckResult`, `RatelimitConfig`,
   `CheckOptions` must all be exported from `packages/sdk/src/index.ts`.

---

## Testing Patterns

### Unit test pattern (algorithm)
```typescript
describe('SlidingCounterAlgorithm', () => {
  it('allows requests under the limit', async () => {
    const result = await algo.check('t1', 'user_1', 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('blocks at exactly the limit', async () => {
    for (let i = 0; i < 5; i++) await algo.check('t1', 'user_2', 5, 60_000);
    const result = await algo.check('t1', 'user_2', 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('isolates tenants', async () => {
    for (let i = 0; i < 5; i++) await algo.check('tenant_A', 'user_1', 5, 60_000);
    const result = await algo.check('tenant_B', 'user_1', 5, 60_000);
    expect(result.allowed).toBe(true); // tenant B unaffected
  });
});
```

### Race condition test
```typescript
it('handles 20 concurrent requests correctly', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => algo.check('t1', 'user_race', 5, 60_000))
  );
  const allowed = results.filter(r => r.allowed).length;
  expect(allowed).toBe(5); // exactly 5, not 6 or 7
});
```

### E2E test pattern
```typescript
it('full cycle: create tenant → check → hit limit → 429', async () => {
  // 1. Create tenant
  const { api_key } = await request(app.getHttpServer())
    .post('/v1/tenants')
    .set('x-admin-secret', 'test_admin')
    .send({ name: 'Test', default_limit: 3, default_window: '1m' })
    .expect(201)
    .then(r => r.body);

  // 2. Send requests up to limit
  for (let i = 0; i < 3; i++) {
    await request(app.getHttpServer())
      .post('/v1/check')
      .set('Authorization', `Bearer ${api_key}`)
      .send({ identifier: 'user_test' })
      .expect(200);
  }

  // 3. Hit the limit
  const res = await request(app.getHttpServer())
    .post('/v1/check')
    .set('Authorization', `Bearer ${api_key}`)
    .send({ identifier: 'user_test' })
    .expect(429);

  expect(res.body.retry_after).toBeGreaterThan(0);
});
```

---

## Docker Compose

```yaml
version: '3.9'
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: [redis_data:/data]
    command: redis-server --appendonly yes

  api:
    build: ./apps/api
    ports: ["3000:3000"]
    environment:
      REDIS_URL: redis://redis:6379
      ADMIN_SECRET: ${ADMIN_SECRET}
    depends_on: [redis]

  dashboard:
    build: ./apps/dashboard
    ports: ["3001:3001"]
    environment:
      NEXT_PUBLIC_API_URL: http://api:3000
    depends_on: [api]

volumes:
  redis_data:
```

Run everything: `docker compose up --build`
API only for dev: `docker compose up redis` then `pnpm --filter api dev`

---

## Common Agent Tasks

### Add a new algorithm
1. Create `apps/api/src/modules/rate-limit/algorithms/token-bucket.ts`
2. Implement the `Algorithm` interface
3. Register it as a provider in `rate-limit.module.ts`
4. Inject it into `rate-limit.service.ts` and add it to the `selectAlgorithm` map
5. Add `'token_bucket'` to the `algorithm` enum in `check-request.dto.ts`
6. Add unit tests covering: under limit, at limit, concurrent requests

### Add a new API endpoint
1. Add method to the relevant controller
2. Add guard if auth is needed: `@UseGuards(ApiKeyGuard)` or admin check
3. Add DTO with class-validator decorators
4. Add to the relevant service
5. Write an e2e test

### Modify the Lua script
1. Edit `apps/api/src/modules/rate-limit/scripts/sliding-counter.lua`
2. Never use `os.time()` — pass time as ARGV from the application
3. All keys that Redis needs to route MUST be in KEYS[], not ARGV[]
4. Test with `redis-cli EVAL "$(cat script.lua)" 2 key1 key2 arg1 arg2 arg3`
5. The script SHA is cached at startup — restart the API after any script change

### Publish the SDK
```bash
cd packages/sdk
pnpm build        # compiles TypeScript to dist/
npm publish --access public
```
Bump `version` in `packages/sdk/package.json` before every publish.
The package name must match `@yourname/ratelimit` exactly.

### Add a metric to the dashboard
1. Add the field to the SSE payload in `metrics.service.ts`
2. Update the `MetricPoint` type in `apps/dashboard/lib/api.ts`
3. Consume the new field in `MetricsChart.tsx` or a new component

---

## Known Constraints and Gotchas

**Redis Lua + Cluster:** If Redis Cluster is used (not standalone), all keys
accessed in one Lua script must map to the same hash slot. Use hash tags to
force this: `rl:{tenantId:identifier}:curr` and `rl:{tenantId:identifier}:prev`.
The part inside `{}` determines the slot. Current key schema already handles
this correctly — do not change the key naming convention without verifying.

**EVALSHA vs EVAL:** The app uses `EVALSHA` (cached script SHA) not `EVAL`
(sends full script every time). If Redis is restarted or flushed, the SHA
becomes invalid. Handle `NOSCRIPT` error by falling back to `EVAL` and
re-caching the SHA. This is implemented in `SlidingCounterAlgorithm` —
do not remove the NOSCRIPT fallback handler.

**SSE and NestJS:** The `@Sse()` decorator requires `Observable` return type.
Do not return a `Promise` or plain object — it silently breaks. Always:
```typescript
@Sse('metrics')
metrics(): Observable<MessageEvent> {
  return interval(2000).pipe(map(stats => ({ data: JSON.stringify(stats) })));
}
```

**SDK fetch and Node versions:** The SDK uses the native `fetch` API which
requires Node 18+. Do not add `node-fetch` as a dependency. Document this
requirement in the SDK README.

**Window timestamp collision:** The sliding counter uses wall-clock window
boundaries. If the system clock jumps backward (NTP correction), two
different wall-clock windows could map to the same Redis key. This is
acceptable for rate limiting (a rare NTP correction is not a security issue)
but should be documented.

**pnpm workspace imports:** The `apps/api` and `apps/dashboard` import shared
types from `packages/sdk` using the workspace protocol. Never use relative
paths (`../../packages/sdk`). Always use the package name:
```typescript
import type { CheckResult } from '@yourname/ratelimit';
```

---

## Performance Targets

These are the targets to hit and verify with a load test before deployment:

| Metric | Target |
|---|---|
| Throughput | 2,000+ req/sec on a single API instance |
| p50 latency | < 2ms |
| p99 latency | < 5ms |
| Redis ops per check | 2 (EVALSHA + EXPIRE, pipelined) |
| Memory per user (sliding counter) | ~100 bytes (2 string keys) |

Load test command:
```bash
npx autocannon -c 200 -d 10 -m POST \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -b '{"identifier":"user_1","limit":10000,"window":"1m"}' \
  http://localhost:3000/v1/check
```

---

## CV Bullet (do not modify)

> Built a multi-tenant rate limiting microservice with REST API and npm SDK.
> Implemented three algorithms — fixed window, sliding window log, and sliding
> window counter — using Redis sorted sets and atomic Lua scripts to eliminate
> race conditions under concurrent load. Supports 2,000+ req/sec at sub-5ms p99.
> Includes real-time metrics dashboard via SSE and a typed TypeScript SDK with
> fail-open fallback.