import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole, ROLES_KEY } from '../decorators/roles.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

/** superadmin implicitly satisfies every lower role. */
const RANK: Record<string, number> = { editor: 1, admin: 2, superadmin: 3 };

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest().user as AuthUser;
    if (!user) throw new ForbiddenException('Not authenticated');

    const held = RANK[user.role] ?? 0;
    const needed = Math.min(...required.map((r) => RANK[r] ?? 99));

    if (held < needed) {
      throw new ForbiddenException(`Requires ${required.join(' or ')} role`);
    }
    return true;
  }
}
