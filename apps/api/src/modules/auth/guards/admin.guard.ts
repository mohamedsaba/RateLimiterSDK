import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    const adminSecret = request.headers['x-admin-secret'];
    const expectedSecret = process.env.ADMIN_SECRET || 'admin-secret';

    if (!adminSecret || adminSecret !== expectedSecret) {
      throw new UnauthorizedException('Invalid or missing admin secret');
    }

    return true;
  }
}
