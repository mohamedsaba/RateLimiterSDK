# Distributed Rate Limiter as a Service — Full Project Blueprint

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| API | NestJS + TypeScript | Decorators, DI, Guards fit perfectly |
| Queue | BullMQ + Redis | Job processing, retries |
| Cache/DB | Redis (ioredis) | Atomic Lua scripts, sorted sets |
| Dashboard | Next.js 14 | SSE for real-time metrics |
| SDK | TypeScript (vanilla) | No framework dependency |
| Monorepo | pnpm workspaces | Shared types between API + SDK |
| Containers | Docker + Docker Compose | Redis + API + Dashboard together |
| Testing | Jest + Supertest | Unit + integration |
| Deploy | Railway / Render | Free tier, easy Redis add-on |

---

## Monorepo Folder Structure

```
ratelimit-saas/
│
├── pnpm-workspace.yaml
├── package.json                    ← root scripts
├── docker-compose.yml
├── .env.example
│
├── apps/
│   ├── api/                        ← NestJS backend
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   │
│   │   │   ├── modules/
│   │   │   │   │
│   │   │   │   ├── auth/
│   │   │   │   │   ├── auth.module.ts
│   │   │   │   │   ├── api-key.guard.ts       ← validates Bearer tokens
│   │   │   │   │   ├── api-key.service.ts     ← lookup key → tenant
│   │   │   │   │   └── decorators/
│   │   │   │   │       └── tenant.decorator.ts
│   │   │   │   │
│   │   │   │   ├── rate-limit/
│   │   │   │   │   ├── rate-limit.module.ts
│   │   │   │   │   ├── rate-limit.controller.ts
│   │   │   │   │   ├── rate-limit.service.ts  ← orchestrator
│   │   │   │   │   ├── algorithms/
│   │   │   │   │   │   ├── algorithm.interface.ts
│   │   │   │   │   │   ├── fixed-window.ts
│   │   │   │   │   │   ├── sliding-log.ts
│   │   │   │   │   │   └── sliding-counter.ts ← main production algo
│   │   │   │   │   ├── scripts/
│   │   │   │   │   │   └── sliding-counter.lua
│   │   │   │   │   └── dto/
│   │   │   │   │       ├── check-request.dto.ts
│   │   │   │   │       └── check-response.dto.ts
│   │   │   │   │
│   │   │   │   ├── tenants/
│   │   │   │   │   ├── tenants.module.ts
│   │   │   │   │   ├── tenants.controller.ts  ← admin: create/delete tenants
│   │   │   │   │   ├── tenants.service.ts
│   │   │   │   │   └── dto/
│   │   │   │   │       └── create-tenant.dto.ts
│   │   │   │   │
│   │   │   │   └── metrics/
│   │   │   │       ├── metrics.module.ts
│   │   │   │       ├── metrics.controller.ts  ← SSE stream endpoint
│   │   │   │       └── metrics.service.ts
│   │   │   │
│   │   │   ├── config/
│   │   │   │   ├── redis.config.ts
│   │   │   │   └── app.config.ts
│   │   │   │
│   │   │   └── common/
│   │   │       ├── filters/
│   │   │       │   └── http-exception.filter.ts
│   │   │       └── interceptors/
│   │   │           └── logging.interceptor.ts
│   │   │
│   │   ├── test/
│   │   │   ├── rate-limit.e2e.spec.ts
│   │   │   └── auth.e2e.spec.ts
│   │   │
│   │   ├── Dockerfile
│   │   ├── nest-cli.json
│   │   └── package.json
│   │
│   └── dashboard/                  ← Next.js admin UI
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx            ← overview
│       │   ├── tenants/
│       │   │   └── page.tsx        ← manage API keys
│       │   └── metrics/
│       │       └── page.tsx        ← live charts
│       ├── components/
│       │   ├── MetricsChart.tsx    ← SSE consumer + recharts
│       │   ├── TenantTable.tsx
│       │   └── UsageCard.tsx
│       ├── lib/
│       │   └── api.ts              ← typed fetch wrapper
│       ├── Dockerfile
│       └── package.json
│
└── packages/
    └── sdk/                        ← @yourname/ratelimit npm package
        ├── src/
        │   ├── index.ts            ← public exports
        │   ├── ratelimit.ts        ← main class
        │   ├── types.ts            ← shared interfaces
        │   └── errors.ts
        ├── tsconfig.json
        └── package.json
```

---

## Redis Key Schema

Everything is namespaced by tenant to prevent collisions between customers.

```
# API key → tenant lookup
tenant:{apiKey}                     → Hash { id, name, defaultLimit, defaultWindow, plan }

# Rate limit counters (sliding counter algo)
rl:{tenantId}:{identifier}:{windowTs}      → Integer (current window count)
rl:{tenantId}:{identifier}:{prevWindowTs}  → Integer (previous window count)

# Rate limit sorted set (sliding log algo)
rl:log:{tenantId}:{identifier}      → Sorted Set (score = timestamp, value = timestamp)

# Metrics counters (reset hourly)
metrics:{tenantId}:allowed:{hourTs} → Integer
metrics:{tenantId}:blocked:{hourTs} → Integer

# Admin keys
admin:keys                          → Set of all admin API keys
```

TTL strategy: every key gets `EXPIRE = window * 2` so Redis auto-cleans stale data.

---

## API Contract

### POST /v1/check — core endpoint

Request:
```json
{
  "identifier": "user_789",
  "limit": 100,
  "window": "1m",
  "algorithm": "sliding_counter"
}
```

Response 200 — allowed:
```json
{
  "allowed": true,
  "limit": 100,
  "remaining": 43,
  "reset_at": 1713700060,
  "algorithm": "sliding_counter",
  "latency_ms": 2
}
```

Response 429 — blocked:
```json
{
  "allowed": false,
  "limit": 100,
  "remaining": 0,
  "retry_after": 12,
  "reset_at": 1713700060
}
```

### GET /v1/status/:identifier
Returns current usage without incrementing the counter. Used for dashboards.

### DELETE /v1/reset/:identifier
Manually clears a user's counter. Admin only.

### GET /v1/metrics (SSE)
Server-Sent Events stream. Pushes a JSON payload every 2 seconds:
```json
{
  "tenant_id": "tenant_A",
  "requests_per_sec": 142,
  "blocked_per_sec": 3,
  "top_identifiers": [
    { "id": "user_123", "count": 89 },
    { "id": "user_456", "count": 54 }
  ]
}
```

### POST /v1/tenants — create tenant (admin)
```json
{
  "name": "My SaaS App",
  "default_limit": 1000,
  "default_window": "1m",
  "plan": "pro"
}
```
Returns `{ api_key: "sk_live_abc123..." }`

---

## Core Files — What Goes In Each

### `sliding-counter.lua`
The atomic heart of the system. Runs as a single unit on Redis — no race conditions possible.

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

### `algorithm.interface.ts`
```typescript
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;        // seconds
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

### `api-key.guard.ts`
Runs on every request before the controller. Validates the Bearer token and attaches the tenant to the request object.

```typescript
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing API key');
    }

    const apiKey = authHeader.split(' ')[1];
    const tenant = await this.apiKeyService.findTenant(apiKey);

    if (!tenant) {
      throw new UnauthorizedException('Invalid API key');
    }

    request.tenant = tenant;
    return true;
  }
}
```

### `rate-limit.service.ts`
Selects the right algorithm and calls it. Also records metrics.

```typescript
@Injectable()
export class RateLimitService {
  constructor(
    private readonly fixedWindow: FixedWindowAlgorithm,
    private readonly slidingLog: SlidingLogAlgorithm,
    private readonly slidingCounter: SlidingCounterAlgorithm,
    private readonly metricsService: MetricsService,
  ) {}

  async check(dto: CheckRequestDto, tenant: Tenant): Promise<CheckResponseDto> {
    const algo = this.selectAlgorithm(dto.algorithm ?? tenant.defaultAlgorithm);
    const windowMs = this.parseWindow(dto.window ?? tenant.defaultWindow);
    const limit = dto.limit ?? tenant.defaultLimit;

    const start = Date.now();
    const result = await algo.check(tenant.id, dto.identifier, limit, windowMs);
    const latencyMs = Date.now() - start;

    await this.metricsService.record(tenant.id, result.allowed);

    return {
      allowed: result.allowed,
      limit,
      remaining: result.remaining,
      resetAt: Math.floor(Date.now() / 1000) + result.resetIn,
      retryAfter: result.allowed ? undefined : result.resetIn,
      algorithm: dto.algorithm ?? 'sliding_counter',
      latencyMs,
    };
  }

  private selectAlgorithm(name: string): Algorithm {
    const map = {
      fixed_window: this.fixedWindow,
      sliding_log: this.slidingLog,
      sliding_counter: this.slidingCounter,
    };
    return map[name] ?? this.slidingCounter;
  }

  private parseWindow(window: string): number {
    const units = { s: 1000, m: 60000, h: 3600000 };
    const match = window.match(/^(\d+)([smh])$/);
    if (!match) throw new BadRequestException('Invalid window format. Use: 30s, 1m, 1h');
    return parseInt(match[1]) * units[match[2]];
  }
}
```

### `MetricsChart.tsx` (dashboard SSE consumer)
```typescript
'use client';
export function MetricsChart({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<MetricPoint[]>([]);

  useEffect(() => {
    const es = new EventSource(`/api/v1/metrics?tenant=${tenantId}`);
    es.onmessage = (e) => {
      const point = JSON.parse(e.data);
      setData(prev => [...prev.slice(-30), point]); // keep last 30 points
    };
    return () => es.close();
  }, [tenantId]);

  return (
    <LineChart width={600} height={200} data={data}>
      <Line type="monotone" dataKey="requests_per_sec" stroke="#4a9eff" dot={false}/>
      <Line type="monotone" dataKey="blocked_per_sec"  stroke="#ff5252" dot={false}/>
      <XAxis dataKey="timestamp" hide />
      <YAxis />
      <Tooltip />
    </LineChart>
  );
}
```

### `sdk/src/ratelimit.ts`
```typescript
export class Ratelimit {
  private baseUrl: string;
  private apiKey: string;
  private defaultLimit: number;
  private defaultWindow: string;

  constructor(config: RatelimitConfig) {
    this.baseUrl    = config.baseUrl;
    this.apiKey     = config.apiKey;
    this.defaultLimit  = config.defaultLimit  ?? 100;
    this.defaultWindow = config.defaultWindow ?? '1m';
  }

  async check(identifier: string, options?: CheckOptions): Promise<CheckResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 200);

    try {
      const res = await fetch(`${this.baseUrl}/v1/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          identifier,
          limit:  options?.limit  ?? this.defaultLimit,
          window: options?.window ?? this.defaultWindow,
        }),
        signal: controller.signal,
      });

      return res.json();
    } catch {
      // fail-open: if the service is unreachable, allow the request
      // configurable via options.failOpen = false for strict mode
      if (options?.failOpen === false) {
        return { allowed: false, remaining: 0, resetAt: 0, retryAfter: 60 };
      }
      return { allowed: true, remaining: -1, resetAt: 0 };
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

---

## docker-compose.yml

```yaml
version: '3.9'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

  api:
    build: ./apps/api
    ports:
      - "3000:3000"
    environment:
      - REDIS_URL=redis://redis:6379
      - ADMIN_SECRET=${ADMIN_SECRET}
    depends_on:
      - redis

  dashboard:
    build: ./apps/dashboard
    ports:
      - "3001:3001"
    environment:
      - API_URL=http://api:3000
    depends_on:
      - api

volumes:
  redis_data:
```

---

## Build Order — Day by Day

### Week 1 — Core Service

**Day 1 — Monorepo + Redis foundation**
- Init pnpm workspace
- Scaffold NestJS app
- Connect Redis with ioredis
- Write and test the Lua script in isolation using `redis-cli`

**Day 2 — Fixed window algorithm**
- Implement `FixedWindowAlgorithm`
- Wire up `RateLimitController` with `POST /v1/check`
- Test manually with curl

**Day 3 — Sliding counter algorithm + API key auth**
- Load Lua script at startup using `redis.defineCommand`
- Implement `SlidingCounterAlgorithm`
- Build `ApiKeyGuard` and `ApiKeyService`
- Test race conditions with concurrent requests using `Promise.all`

**Day 4 — Tenants + multi-tenancy**
- Build `TenantsService` (create, find, delete)
- Add `POST /v1/tenants` admin endpoint (protected by admin secret)
- Namespace all Redis keys by `tenantId`

**Day 5 — Docker + tests**
- Write `docker-compose.yml`
- Write unit tests for all three algorithms
- Write one e2e test: create tenant → check → hit limit → 429

---

### Week 2 — Polish + Products

**Day 6 — Metrics + SSE**
- Implement `MetricsService` (INCR counters per allowed/blocked)
- Build `GET /v1/metrics` SSE endpoint using NestJS `@Sse()`
- Test SSE stream with curl

**Day 7-8 — npm SDK**
- Build `Ratelimit` class in `packages/sdk`
- Add fail-open/fail-closed config
- Write README with usage examples
- Publish to npm: `npm publish --access public`

**Day 9-10 — Next.js Dashboard**
- Scaffold Next.js app
- Build SSE consumer + recharts line chart
- Build tenant management table
- Wire up to API with typed fetch wrapper

**Day 11 — Performance + README**
- Benchmark with `autocannon` or `k6`: target sub-5ms p99
- Write architecture README with diagrams
- Record a 60-second demo video showing live rate limiting

---

## Testing Strategy

### Unit tests (per algorithm)
- Allows requests under the limit
- Blocks at exactly the limit
- Allows again after window resets
- Handles concurrent requests correctly (no race condition)

### Integration tests (Redis required)
- Full request cycle: check → increment → check → blocked → reset
- Multi-tenant isolation: tenant A's limit does not affect tenant B

### Load test (k6)
```javascript
// k6 script: 500 virtual users, 10 seconds
export default function () {
  const res = http.post('http://localhost:3000/v1/check', JSON.stringify({
    identifier: `user_${Math.floor(Math.random() * 100)}`,
    limit: 10,
    window: '1m',
  }), { headers: { Authorization: 'Bearer sk_test_...' } });

  check(res, { 'status is 200 or 429': (r) => [200, 429].includes(r.status) });
}
```
Target: 2000+ req/sec, p99 < 5ms.

---

## Environment Variables

```bash
# apps/api/.env
REDIS_URL=redis://localhost:6379
ADMIN_SECRET=super_secret_admin_key
PORT=3000
NODE_ENV=development

# apps/dashboard/.env
NEXT_PUBLIC_API_URL=http://localhost:3000

# packages/sdk — consumed by the user, not stored in .env
RL_API_KEY=sk_live_abc123
RL_BASE_URL=https://your-service.com
```

---

## CV Bullet Point

> Built a multi-tenant rate limiting microservice with REST API and npm SDK. Implemented three algorithms — fixed window, sliding window log, and sliding window counter — using Redis sorted sets and atomic Lua scripts to eliminate race conditions under concurrent load. Supports 2,000+ req/sec at sub-5ms p99. Includes real-time metrics dashboard via SSE and a typed TypeScript SDK with fail-open fallback.

---

## Deployment (Free)

1. Push to GitHub
2. Create project on Railway.app
3. Add Redis plugin (free tier: 25MB, plenty for dev)
4. Set environment variables
5. Deploy — Railway auto-detects Docker

For the npm SDK: `npm publish` once, then it's live at `npmjs.com/package/@yourname/ratelimit`.
