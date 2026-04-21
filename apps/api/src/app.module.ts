import { Module } from '@nestjs/common';
import { RedisModule } from './modules/redis/redis.module';
import { RateLimitModule } from './modules/rate-limit/rate-limit.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { AuthModule } from './modules/auth/auth.module';
import { MetricsModule } from './modules/metrics/metrics.module';

@Module({
  imports: [
    RedisModule,
    RateLimitModule,
    TenantsModule,
    AuthModule,
    MetricsModule,
  ],
})
export class AppModule {}
