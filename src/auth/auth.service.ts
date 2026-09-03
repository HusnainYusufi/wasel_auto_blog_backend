import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, ChangePasswordDto } from './dto/auth.dto';
import { AccessTokenPayload } from './jwt.strategy';

export const BCRYPT_ROUNDS = 12;

interface RefreshPayload {
  sub: string;
  jti: string;
  family: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get accessSecret() {
    return this.config.get<string>('JWT_ACCESS_SECRET') ?? 'dev-access-secret';
  }

  private get refreshSecret() {
    return this.config.get<string>('JWT_REFRESH_SECRET') ?? 'dev-refresh-secret';
  }

  /** Seconds, so `expiresIn` is unambiguous and strongly typed. */
  private get accessTtl(): number {
    return parseTtlSeconds(this.config.get<string>('JWT_ACCESS_TTL'), 15 * 60);
  }

  private get refreshTtl(): number {
    return parseTtlSeconds(this.config.get<string>('JWT_REFRESH_TTL'), 7 * 24 * 60 * 60);
  }

  // ------------------------------------------------------------------ login

  async login(dto: LoginDto, meta: { userAgent?: string; ip?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });

    // Compare against a dummy hash when the user is missing so that a wrong
    // email and a wrong password take the same amount of time.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await bcrypt.compare(dto.password, hash);

    if (!user || !matches) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokens(user, randomUUID(), meta);
  }

  // ---------------------------------------------------------------- refresh

  /**
   * Rotates the refresh token. Presenting a token that was already rotated means
   * it leaked, so the whole family is revoked and the holder must log in again.
   */
  async refresh(token: string, meta: { userAgent?: string; ip?: string }) {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(token, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    if (!stored) {
      await this.revokeFamily(payload.family);
      throw new UnauthorizedException('Session is no longer valid');
    }

    if (stored.revokedAt) {
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; revoking family ${stored.family}`,
      );
      await this.revokeFamily(stored.family);
      throw new UnauthorizedException('Session reuse detected — please sign in again');
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Session has expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }

    const issued = await this.issueTokens(user, stored.family, meta);

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: issued.refreshTokenId },
    });

    return issued;
  }

  async logout(token: string) {
    if (!token) return { success: true };

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (stored) await this.revokeFamily(stored.family);

    return { success: true };
  }

  /** Invalidates every session for the user, access tokens included. */
  async logoutEverywhere(userId: string) {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      }),
    ]);
    return { success: true };
  }

  // --------------------------------------------------------------- password

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const matches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!matches) throw new BadRequestException('Current password is incorrect');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must differ from the current one');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS) },
    });

    // A password change ends every existing session.
    await this.logoutEverywhere(userId);

    return { success: true };
  }

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  // ------------------------------------------------------------- internals

  private async issueTokens(
    user: { id: string; email: string; name: string; role: string; tokenVersion: number },
    family: string,
    meta: { userAgent?: string; ip?: string },
  ) {
    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tv: user.tokenVersion,
    };

    const jti = randomUUID();
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.accessSecret,
        expiresIn: this.accessTtl,
      }),
      this.jwt.signAsync(
        { sub: user.id, jti, family } satisfies RefreshPayload,
        { secret: this.refreshSecret, expiresIn: this.refreshTtl },
      ),
    ]);

    const decoded = this.jwt.decode(refreshToken) as { exp: number };

    const record = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        family,
        expiresAt: new Date(decoded.exp * 1000),
        userAgent: meta.userAgent?.slice(0, 250),
        ip: meta.ip?.slice(0, 60),
      },
    });

    return {
      accessToken,
      refreshToken,
      refreshTokenId: record.id,
      expiresIn: this.accessTtl,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  private async revokeFamily(family: string) {
    await this.prisma.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Accepts `900`, `15m`, `7d`, `12h`, `30s`; falls back when unparseable. */
function parseTtlSeconds(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const match = /^(\d+)\s*([smhd])?$/i.exec(value.trim());
  if (!match) return fallback;

  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;

  return amount * multiplier;
}

/** Constant-time-ish fallback so login timing does not reveal valid emails. */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Zr1ZL0LqZ8Z0Z0Z0Z0Z0Z0Z0Z0Z0Zu';
