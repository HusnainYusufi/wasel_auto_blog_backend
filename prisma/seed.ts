/**
 * Creates the superadmin account. There is no signup route by design, so this is
 * the only way the first account comes into existence.
 *
 *   npm run seed
 *
 * Also seeds a starter keyword set, so the studio has something usable on first run.
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

/** Starter keyword sets. Existing sets are never overwritten. */
const STARTER_KEYWORD_SETS = [
  {
    name: 'مراتب السرير',
    note: 'Arabic mattress keywords for the Saudi market',
    language: 'Arabic',
    pinned: true,
    keywords: [
      'افضل مراتب',
      'عروض مراتب السرير',
      'مراتب السرير',
      'مراتب سرير',
    ],
  },
];

async function seedKeywordSets() {
  for (const set of STARTER_KEYWORD_SETS) {
    const existing = await prisma.keywordSet.findUnique({
      where: { name: set.name },
    });
    if (existing) {
      console.log(`Keyword set "${set.name}" already exists — skipped.`);
      continue;
    }

    await prisma.keywordSet.create({
      data: {
        name: set.name,
        note: set.note,
        language: set.language,
        pinned: set.pinned,
        keywords: JSON.stringify(set.keywords),
      },
    });
    console.log(
      `Keyword set created: ${set.name} (${set.keywords.length} keywords)`,
    );
  }
}

main()
  .then(seedKeywordSets)
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
