const express = require('express');
const router = express.Router();
const { verifyToken, verifyCard, useCard } = require('../services/authService');
const { isValidCardCode } = require('../utils/validators');

// 使用卡密
router.post('/use', async (req, res) => {
  try {
    const { code } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        code: 'NO_TOKEN'
      });
    }

    if (!code) {
      return res.status(400).json({ error: 'Card code required' });
    }

    if (!isValidCardCode(code)) {
      return res.status(400).json({ error: '卡密格式不正确' });
    }

    const username = await verifyToken(token);

    // 验证卡密
    const card = await verifyCard(code);
    if (!card) {
      return res.status(400).json({ error: '卡密无效或已被使用' });
    }

    // 使用卡密
    const updatedVip = await useCard(code, username);

    res.json({
      quota: {
        type: updatedVip.type,
        expireAt: updatedVip.expireAt,
        quotaChars: updatedVip.quotaChars,
        usedChars: updatedVip.usedChars,
        remainingChars: Math.max(0, updatedVip.quotaChars - updatedVip.usedChars)
      }
    });
  } catch (error) {
    console.error('Use card error:', error);
    
    // 区分认证错误和业务错误
    if (error.message.includes('Token') || error.message.includes('Invalid token')) {
      res.status(401).json({ 
        error: 'Authentication failed',
        code: 'TOKEN_INVALID'
      });
    } else {
      // 业务逻辑错误（如卡密无效等）
      res.status(400).json({ error: error.message });
    }
  }
});

module.exports = router;
