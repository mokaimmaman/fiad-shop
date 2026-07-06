const express = require('express');
const c = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

router.post('/register',        authLimiter, asyncHandler(c.register));
router.post('/verify-otp',      otpLimiter,  asyncHandler(c.verifyOtp));
router.post('/resend-otp',      otpLimiter,  asyncHandler(c.resendOtp));
router.post('/login',           authLimiter, asyncHandler(c.login));
router.post('/forgot-password', authLimiter, asyncHandler(c.forgotPassword));
router.post('/reset-password',  authLimiter, asyncHandler(c.resetPassword));

router.get ('/me',                requireAuth, asyncHandler(c.me));
router.post('/2fa/setup',         requireAuth, asyncHandler(c.twoFactorSetup));
router.post('/2fa/verify-enable', requireAuth, asyncHandler(c.twoFactorVerify));
router.post('/2fa/disable',       requireAuth, asyncHandler(c.twoFactorDisable));

module.exports = router;
