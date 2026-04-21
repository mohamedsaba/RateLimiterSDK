import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TenantsService, Tenant } from '../tenants/tenants.service';

@Injectable()
export class AuthService {
  constructor(private readonly tenantsService: TenantsService) {}

  async validateApiKey(apiKey: string): Promise<Tenant> {
    const tenant = await this.tenantsService.getTenantByApiKey(apiKey);
    
    if (!tenant) {
      throw new UnauthorizedException('Invalid API key');
    }

    return tenant;
  }
}
