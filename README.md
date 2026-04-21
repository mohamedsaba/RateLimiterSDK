# 🚀 Distributed Rate Limiter SDK & SaaS

A high-performance, multi-tenant distributed rate limiting solution built with **NestJS**, **Redis (Lua Scripts)**, and **TypeScript**.

## ✨ Features
*   **Multi-tenant Architecture**: Isolated rate limits for different customers/apps.
*   **Atomic Operations**: Uses Redis Lua scripts to ensure accuracy under high concurrency.
*   **Multiple Algorithms**:
    *   Sliding Window Counter
    *   Fixed Window
    *   Sliding Log
*   **Management CLI**: Easy tenant management (create, list) via terminal.
*   **Lightweight SDK**: Zero-dependency client for integration.

## 📁 Project Structure
```text
.
├── apps/
│   ├── api/          # NestJS Backend Service
│   └── cli/          # Management CLI tool
├── packages/
│   └── sdk/          # Rate Limiter SDK for clients
├── docker-compose.yml # Infrastructure (Redis + API)
└── pnpm-workspace.yaml
```

## 🛠️ Getting Started

### 1. Prerequisites
*   Node.js (v20+)
*   Docker & Docker Compose
*   pnpm (v10+)

### 2. Run the Infrastructure
Start the API and Redis using Docker:
```bash
npm run docker:up
```

### 3. Setup Management CLI
Create your first tenant:
```bash
# List tenants (initially empty)
npm run cli -- tenant list

# Create a new tenant
npm run cli -- tenant create "My Awesome App"
```
*Take note of the API Key generated.*

### 4. Use the SDK
Install the SDK in your project and check limits:
```typescript
import { RateLimiter } from '@ratelimit/sdk';

const limiter = new RateLimiter('YOUR_API_KEY');

const res = await limiter.check({
  identifier: 'user_123',
  limit: 100,
  windowMs: 60000 // 1 minute
});

if (res.allowed) {
  // Proceed with request
}
```

## 🧪 Development & Testing
Run integration tests to verify the flow:
```bash
export RL_API_KEY="your_api_key_here"
pnpm --filter @ratelimit/sdk run test:integration
```

## 📜 License
MIT
