// Wrap an async route handler so thrown errors propagate to Express's
// error-handling middleware (instead of hanging the request).

const { ZodError } = require('zod');

module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
      });
    }
    next(err);
  });
};
