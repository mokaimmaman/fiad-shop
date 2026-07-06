// Seed: creates the first ADMIN user, support settings, and a few demo products.
// Run: `node prisma/seed.js`
// Env: SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD

require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@fiad.shop').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        email, passwordHash: hash,
        displayName: 'Fiad Admin',
        username: 'admin_' + Math.floor(1000 + Math.random() * 9000),
        role: 'ADMIN', isVerified: true,
      },
    });
    console.log(`✅ Created admin: ${email} / ${password}`);
    console.log('   ⚠ Change this password immediately.');
  } else {
    console.log(`ℹ Admin already exists: ${email}`);
  }

  // Support settings singleton
  const s = await prisma.supportSettings.findFirst();
  if (!s) await prisma.supportSettings.create({ data: { isLiveEnabled: false } });

  // Demo products (only if the table is empty)
  const productCount = await prisma.product.count();
  if (productCount === 0) {
    const demo = [
      {
        sku: 'FIAD-TSHIRT-001', pid: 'CJ-DEMO-001',
        name: 'Fiad Signature T-Shirt', description: 'Premium cotton tee with the Fiad Shop signature print.',
        category: 'Apparel', basePrice: 24.99, stock: 100,
        images: ['https://picsum.photos/seed/tshirt/600/600'],
        affiliateCommission: 15,
      },
      {
        sku: 'FIAD-BAG-002', pid: 'CJ-DEMO-002',
        name: 'Everyday Canvas Backpack', description: 'Water-resistant canvas backpack with laptop sleeve.',
        category: 'Bags', basePrice: 49.99, stock: 50,
        images: ['https://picsum.photos/seed/bag/600/600'],
        affiliateCommission: 12, isProMode: true,
      },
      {
        sku: 'FIAD-MUG-003', pid: 'CJ-DEMO-003',
        name: 'Ceramic Coffee Mug', description: 'Dishwasher-safe 350ml mug in matte finish.',
        category: 'Home', basePrice: 12.99, stock: 200,
        images: ['https://picsum.photos/seed/mug/600/600'],
        affiliateCommission: 10,
      },
    ];
    for (const d of demo) await prisma.product.create({ data: d });
    console.log(`✅ Created ${demo.length} demo products`);
  }

  // Basic KB seed
  const kbCount = await prisma.aIKnowledge.count();
  if (kbCount === 0) {
    await prisma.aIKnowledge.createMany({
      data: [
        {
          category: 'shipping', question: 'How long does shipping take?',
          answer: 'Standard shipping takes 7–15 business days worldwide. You will receive a tracking number once your order ships.',
          keywords: ['shipping','delivery','ship','arrive','when'], priority: 10,
        },
        {
          category: 'returns', question: 'What is your return policy?',
          answer: 'We accept returns within 30 days of delivery for unused items in original packaging. Contact support@fiad.shop to start a return.',
          keywords: ['return','refund','exchange','policy'], priority: 10,
        },
        {
          category: 'payment', question: 'What payment methods do you accept?',
          answer: 'We accept crypto (BTC, ETH, USDT and more) and Hawala Visa card via NOWPayments — a secure checkout experience.',
          keywords: ['payment','pay','crypto','visa','method'], priority: 10,
        },
      ],
    });
    console.log('✅ Seeded 3 AI knowledge entries');
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
