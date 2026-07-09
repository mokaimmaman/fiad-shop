// Fiad Shop — Express entrypoint.
// Designed to run on Vercel serverless AND as a normal Node process locally.

require('dotenv').config(); // Load .env from root (works locally and on Vercel)

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// Routes point to local ./routes/ folder
const authRoutes      = require('./routes/auth');
const adminRoutes     = require('./routes/admin');
const affiliateRoutes = require('./routes/affiliate');
const orderRoutes     = require('./routes/orders');
const paymentRoutes   = require('./routes/payment');
const feedbackRoutes  = require('./routes/feedback');
const aiRoutes        = require('./routes/ai');
const supportRoutes   = require('./routes/support');
const productRoutes   = require('./routes/products');
const settingRoutes   = require('./routes/settings');

const app = express();

// ---- Security ---------------------------------------------------------------
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// ---- CORS -------------------------------------------------------------------
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true);
    if (allowedOrigins.some(o => origin === o || origin.startsWith(o))) {
      return cb(null, true);
    }
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ---- Body parsers -----------------------------------------------------------
app.use('/api/payment/webhook',
  express.raw({ type: '*/*', limit: '2mb' })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---- Logging ----------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ---- Global rate limit ------------------------------------------------------
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', globalLimiter);

// ---- Routes -----------------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({
    service: 'Fiad Shop API',
    version: '1.0.0',
    status: 'ok',
    time: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth',      authRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/affiliate', affiliateRoutes);
app.use('/api/orders',    orderRoutes);
app.use('/api/payment',   paymentRoutes);
app.use('/api/feedback',  feedbackRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/support',   supportRoutes);
app.use('/api/products',  productRoutes);
app.use('/api/settings',  settingRoutes);

// ---- 404 --------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ---- Error handler ----------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.publicMessage || err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ---- Boot -------------------------------------------------------------------
const port = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Fiad Shop API listening on http://localhost:${port}`);
  });
}

// Export for Vercel serverless
module.exports = app;
