// Singleton Prisma client. Prevents connection storms in dev/hot-reload
// and on Vercel's warm invocations.

const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;
const prisma = globalForPrisma.__fiadPrisma || new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__fiadPrisma = prisma;
}

module.exports = prisma;
