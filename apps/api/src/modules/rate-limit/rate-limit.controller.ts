import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { IsString, IsNumber, IsOptional, IsIn, IsNotEmpty } from 'class-validator';

class CheckRateLimitDto {
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @IsNumber()
  limit: number;

  @IsNumber()
  windowMs: number;

  @IsOptional()
  @IsIn(['sliding-counter', 'fixed-window', 'sliding-log'])
  algorithm?: 'sliding-counter' | 'fixed-window' | 'sliding-log';
}

@Controller('v1/check')
export class RateLimitController {
  constructor(private readonly rateLimitService: RateLimitService) {}

  @Post()
  @UseGuards(ApiKeyGuard)
  async check(@Body() dto: CheckRateLimitDto, @Req() req: any) {
    const tenant = req.tenant;
    return this.rateLimitService.check(
      tenant.id,
      dto.identifier,
      dto.limit,
      dto.windowMs,
      dto.algorithm,
    );
  }
}
