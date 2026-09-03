import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export type AppRole = 'superadmin' | 'admin' | 'editor';

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
