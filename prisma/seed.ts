/**
 * Creates the superadmin account. There is no signup route by design, so this is
 * the only way the first account comes into existence.
 *
 *   npm run seed
 *
 * Credentials come from SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD in .env.
 * Re-running is safe: an existing account is left alone unless
 * SUPERADMIN_RESET_PASSWORD=true, in which case its password is reset.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

async function main() {
  const email = (process.env.SUPERADMIN_EMAIL ?? '').toLowerCase().trim();
  const password = process.env.SUPERADMIN_PASSWORD ?? '';
  const name = process.env.SUPERADMIN_NAME ?? 'Super Admin';

  if (!email || !password) {
    throw new Error(
      'Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in .env before seeding.',
    );
  }
  if (password.length < 10) {
    throw new Error('SUPERADMIN_PASSWORD must be at least 10 characters.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    if (process.env.SUPERADMIN_RESET_PASSWORD === 'true') {
      await prisma.user.update({
        where: { email },
        data: {
          passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
          isActive: true,
          role: 'superadmin',
          // Ends every existing session for the account.
          tokenVersion: { increment: 1 },
        },
      });
      console.log(`Password reset for superadmin ${email}`);
    } else {
      console.log(`Superadmin ${email} already exists — nothing to do.`);
    }
    return;
  }

  await prisma.user.create({
    data: {
      email,
      name,
      role: 'superadmin',
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    },
  });

  console.log(`Superadmin created: ${email}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
