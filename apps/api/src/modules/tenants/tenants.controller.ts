import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { IsString, IsNotEmpty } from 'class-validator';

class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}

@Controller('tenants')
@UseGuards(AdminGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  async create(@Body() createTenantDto: CreateTenantDto) {
    return this.tenantsService.createTenant(createTenantDto.name);
  }

  @Get()
  async list() {
    return this.tenantsService.listTenants();
  }
}
