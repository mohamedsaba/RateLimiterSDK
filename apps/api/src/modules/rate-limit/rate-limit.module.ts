import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { RateLimitController } from './rate-limit.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [RateLimitService],
  controllers: [RateLimitController],
  exports: [RateLimitService],
})
export class RateLimitModule {}
