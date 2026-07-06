const express = require('express');
const c = require('../controllers/orderController');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { orderLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Guest OR logged-in — optionalAuth attaches req.user if a token is present.
router.post('/create',           optionalAuth, orderLimiter, asyncHandler(c.createOrder));
router.get ('/mine',             requireAuth,  asyncHandler(c.myOrders));
router.get ('/:orderNumber/track', optionalAuth, asyncHandler(c.trackOrder));

module.exports = router;
