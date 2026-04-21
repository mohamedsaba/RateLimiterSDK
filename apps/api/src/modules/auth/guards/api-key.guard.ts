import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'] || request.headers['X-API-KEY'];

    if (!apiKey) {
      throw new UnauthorizedException('API key is missing');
    }

    const tenant = await this.authService.validateApiKey(apiKey as string);
    
    // Attach tenant to request for use in controllers
    request['tenant'] = tenant;
    
    return true;
  }
}
