import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { TenantsModule } from '../tenants/tenants.module';

@Module({
  imports: [TenantsModule],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
