const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const User = require('../modules/User');
const { logger, logApiError, logUserAction } = require('../utils/logger');
const verificationCodeService = require('../services/verificationCodeService');
const router = express.Router();

// 配置头像上传
const avatarStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../../public/avatars');
        console.log('上传目录:', uploadDir);
        if (!fs.existsSync(uploadDir)) {
            console.log('创建上传目录:', uploadDir);
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const avatarUpload = multer({
    storage: avatarStorage,
    limits: {
        fileSize: 2 * 1024 * 1024 // 限制2MB
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('只允许上传jpeg、jpg、png或gif格式的图片'));
        }
    }
});

const SALT_ROUNDS = 10;

// 判断是否为 bcrypt 哈希（格式 $2a$、$2b$、$2y$）
function isBcryptHash(str) {
  return typeof str === 'string' && /^\$2[aby]\$\d{2}\$/.test(str);
}
// 忘记密码 - 验证邮箱验证码并返回重置页面
router.post('/forgot-password', async (req, res) => {
    try {
        const { contact, code } = req.body;

        if (!contact || !code) {
            return res.json({ code: 400, message: '邮箱和验证码不能为空' });
        }

        // 验证邮箱格式
        if (!contact.includes('@')) {
            return res.json({ code: 400, message: '请输入有效的邮箱地址' });
        }

        // 先查找用户（避免验证码被消费后才发现邮箱未注册）
        const user = await User.findOne({ email: contact });

        if (!user) {
            return res.json({ code: 400, message: '该邮箱未注册' });
        }

        // 验证验证码
        const verifyResult = await verificationCodeService.verifyCode(contact, code);
        if (!verifyResult.success) {
            return res.json({ code: 400, message: verifyResult.message });
        }

        // 生成一个简单的token（在实际项目中应该使用JWT等安全方式）
        const token = Buffer.from(contact + ':' + Date.now()).toString('base64');

        logUserAction(req, 'VERIFY_CODE_FORGOT_PASSWORD', { contact });
        logger.info(`用户 ${contact} 验证验证码成功，准备重置密码`);

        // 返回重置密码页面链接
        return res.json({
            code: 200,
            message: '验证成功，请设置新密码',
            data: {
                resetUrl: `/auth/reset-password?token=${token}`,
                contact: contact
            }
        });
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 忘记密码 - 验证验证码（兼容前端调用 /forgot-password-verify）
router.post('/forgot-password-verify', async (req, res) => {
    try {
        const { contact, code } = req.body;

        if (!contact || !code) {
            return res.json({ code: 400, message: '邮箱和验证码不能为空' });
        }

        // 验证邮箱格式
        if (!contact.includes('@')) {
            return res.json({ code: 400, message: '请输入有效的邮箱地址' });
        }

        // 先查找用户（避免验证码被消费后才发现邮箱未注册）
        const user = await User.findOne({ email: contact });

        if (!user) {
            return res.json({ code: 400, message: '该邮箱未注册' });
        }

        // 验证验证码
        const verifyResult = await verificationCodeService.verifyCode(contact, code);
        if (!verifyResult.success) {
            return res.json({ code: 400, message: verifyResult.message });
        }

        logUserAction(req, 'VERIFY_CODE_FORGOT_PASSWORD', { contact });
        logger.info(`用户 ${contact} 验证验证码成功，准备重置密码`);

        return res.json({
            code: 200,
            message: '验证成功，请设置新密码'
        });
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 重置密码 - 实际更新密码
router.post('/reset-password', async (req, res) => {
    try {
        const { contact, password, confirmPassword } = req.body;

        if (!contact || !password || !confirmPassword) {
            return res.json({ code: 400, message: '邮箱、密码和确认密码不能为空' });
        }

        if (password.length < 6) {
            return res.json({ code: 400, message: '密码长度不能少于6位' });
        }

        if (password !== confirmPassword) {
            return res.json({ code: 400, message: '两次密码输入不一致' });
        }

        // 验证邮箱格式
        if (!contact.includes('@')) {
            return res.json({ code: 400, message: '邮箱格式不正确' });
        }

        // 查找用户
        const user = await User.findOne({ email: contact });

        if (!user) {
            return res.json({ code: 400, message: '该邮箱未注册' });
        }

        // 检查新密码是否和旧密码相同
        const isSamePassword = await bcrypt.compare(password, user.password);
        if (isSamePassword) {
            return res.json({ code: 400, message: '新密码不能与旧密码相同' });
        }

        // 更新密码
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        user.password = hashedPassword;
        await user.save();

        logUserAction(req, 'RESET_PASSWORD_SUCCESS', { contact });
        logger.info(`用户 ${contact} 重置密码成功`);

        return res.json({ code: 200, message: '密码重置成功' });
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 忘记密码页面
router.get('/forgot-password', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/forgot-password.html'));
});

// 获取重置密码页面
router.get('/reset-password', (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).send('缺少重置令牌');
    }

    // 在实际项目中，这里应该验证令牌的有效性
    // 简化版直接渲染重置密码页面
    res.send(`
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>重置密码 - 英语学习平台</title>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
            <style>
                body {
                    background-color: #f8f9fa;
                    padding-top: 50px;
                }
                .reset-password-container {
                    max-width: 400px;
                    margin: 0 auto;
                    background-color: white;
                    padding: 30px;
                    border-radius: 8px;
                    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
                }
                .form-title {
                    text-align: center;
                    margin-bottom: 20px;
                    color: #333;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="reset-password-container">
                    <h2 class="form-title">重置密码</h2>
                    <form id="resetPasswordForm">
                        <input type="hidden" id="token" value="${token}">
                        <div class="mb-3">
                            <label for="newPassword" class="form-label">新密码</label>
                            <input type="password" class="form-control" id="newPassword" required>
                            <div class="form-text">密码长度至少为6个字符</div>
                        </div>
                        <div class="mb-3">
                            <label for="confirmPassword" class="form-label">确认密码</label>
                            <input type="password" class="form-control" id="confirmPassword" required>
                        </div>
                        <div class="d-grid">
                            <button type="submit" class="btn btn-primary">重置密码</button>
                        </div>
                    </form>
                </div>
            </div>

            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
            <script>
                document.getElementById('resetPasswordForm').addEventListener('submit', async function(e) {
                    e.preventDefault();

                    const token = document.getElementById('token').value;
                    const newPassword = document.getElementById('newPassword').value;
                    const confirmPassword = document.getElementById('confirmPassword').value;

                    if (newPassword !== confirmPassword) {
                        alert('两次输入的密码不一致');
                        return;
                    }

                    if (newPassword.length < 6) {
                        alert('密码长度至少为6个字符');
                        return;
                    }

                    try {
                        // 直接调用重置密码API
                        const resetResponse = await fetch('/auth/reset-password', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                token: token,
                                newPassword: newPassword
                            })
                        });

                        const resetData = await resetResponse.json();

                        if (resetData.code === 200) {
                            alert('密码重置成功，请使用新密码登录');
                            window.location.href = '/login';
                        } else {
                            alert('密码重置失败: ' + resetData.message);
                        }
                    } catch (error) {
                        console.error('重置密码失败:', error);
                        alert('重置密码失败，请稍后重试');
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// 获取联系方式（简化版，实际项目中应该从token中解析）
router.get('/get-contact-from-token', (req, res) => {
    const { token } = req.query;

    // 在实际项目中，这里应该解析token并返回联系方式
    // 简化版直接返回模拟数据
    res.json({
        code: 200,
        message: '获取联系方式成功',
        data: {
            contact: 'test@example.com',
            verificationCode: '123456'
        }
    });
});

router.post('/login', async (req, res) => {
    let username, password;
    try {
        ({ username, password } = req.body);
    } catch (err) {
        logApiError(req, err, 400);
        return res.json({ code: 400, message: '错误的请求格式，请求体结构缺失' });
    }

    try {
        const user = await User.findOne({ username });

        if (!user) {
            logUserAction(req, 'LOGIN_FAILED', { username, reason: '用户不存在' });
            return res.json({ code: 400, message: '用户不存在' });
        }

        let passwordValid = false;
        if (isBcryptHash(user.password)) {
            passwordValid = await bcrypt.compare(password, user.password);
            // 登录成功时，若之前是明文密码已通过下方兼容逻辑迁移，此处不会执行
        } else {
            // 兼容旧数据：明文密码，验证后迁移为 bcrypt 哈希
            if (password === user.password) {
                passwordValid = true;
                user.password = await bcrypt.hash(password, SALT_ROUNDS);
                await user.save();
                logger.info(`用户 ${username} 密码已迁移为 bcrypt 哈希`);
            }
        }

        if (passwordValid) {
            // 确保 session 存在
            if (!req.session) {
                req.session = {};
            }

            // 直接更新会话信息
            req.session.userid = user._id;
            req.session.isLogin = true;
            req.session.username = username;

            logUserAction(req, 'LOGIN_SUCCESS', { username, userId: user._id });
            logger.info(`用户登录成功: ${username}`);

            return res.json({ code: 200, message: '登录成功' });
        } else {
            logUserAction(req, 'LOGIN_FAILED', { username, reason: '密码错误' });
            return res.json({ code: 400, message: '密码错误' });
        }
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 发送验证码
router.post('/send-code', async (req, res) => {
    try {
        const { contact, type } = req.body;

        if (!contact || !type) {
            return res.json({ code: 400, message: '邮箱和验证码类型不能为空' });
        }

        // 验证邮箱格式
        if (!contact.includes('@')) {
            return res.json({ code: 400, message: '请输入有效的邮箱地址' });
        }

        // 检查验证码类型
        if (type !== 'register' && type !== 'reset') {
            return res.json({ code: 400, message: '验证码类型必须是register或reset' });
        }

        // 注册时检查邮箱是否已被使用
        if (type === 'register') {
            const existingUser = await User.findOne({ email: contact });

            if (existingUser) {
                return res.json({ code: 400, message: '该邮箱已被注册' });
            }
        }

        // 发送验证码
        const result = await verificationCodeService.sendCode(contact, type);

        if (result.success) {
            logUserAction(req, 'SEND_CODE_SUCCESS', { contact, type });
            return res.json({ code: 200, message: result.message });
        } else {
            logUserAction(req, 'SEND_CODE_FAILED', { contact, type, reason: result.message });
            return res.json({ code: 400, message: result.message });
        }
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 验证验证码
router.post('/verify-code', async (req, res) => {
    try {
        const { contact, code } = req.body;

        if (!contact || !code) {
            return res.json({ code: 400, message: '邮箱和验证码不能为空' });
        }

        // 验证验证码
        const result = await verificationCodeService.verifyCode(contact, code);

        if (result.success) {
            // 更新用户验证状态
            const user = await User.findOne({ email: contact });

            if (user) {
                user.isVerified = true;
                await user.save();
            }

            // 生成一个简单的token（在实际项目中应该使用JWT等安全方式）
            const token = Buffer.from(contact + ':' + Date.now()).toString('base64');

            logUserAction(req, 'VERIFY_CODE_SUCCESS', { contact });
            return res.json({ 
                code: 200, 
                message: result.message,
                data: {
                    resetUrl: `/api/auth/reset-password?token=${token}`,
                    contact: contact
                }
            });
        } else {
            logUserAction(req, 'VERIFY_CODE_FAILED', { contact, reason: result.message });
            return res.json({ code: 400, message: result.message });
        }
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 发送邮箱验证码
router.post('/send-email-code', async (req, res) => {
    try {
        const { email, type = 'register' } = req.body;

        if (!email) {
            return res.json({ code: 400, message: '邮箱不能为空' });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ code: 400, message: '邮箱格式不正确' });
        }

        if (type !== 'register' && type !== 'reset') {
            return res.json({ code: 400, message: '验证码类型必须是register或reset' });
        }

        // 注册时：邮箱不能已被注册
        if (type === 'register') {
            const existingUser = await User.findOne({ email });
            if (existingUser) {
                return res.json({ code: 400, message: '该邮箱已被注册' });
            }
        }

        // 重置密码时：邮箱必须已注册
        if (type === 'reset') {
            const user = await User.findOne({ email });
            if (!user) {
                return res.json({ code: 400, message: '该邮箱未注册' });
            }
        }

        const result = await verificationCodeService.sendCode(email, type);

        if (result.success) {
            logger.info(`验证码已发送到邮箱: ${email}, 类型: ${type}, 验证码: ${result.code}`);
            return res.json({ code: 200, message: '验证码已发送' });
        } else {
            return res.json({ code: 400, message: result.message });
        }
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

router.post('/register', async (req, res) => {
    try {
        const { username, password, email, verificationCode } = req.body;

        if (!username || !password) {
            return res.json({ code: 400, message: '用户名和密码不能为空' });
        }

        if (!email) {
            return res.json({ code: 400, message: '请提供邮箱' });
        }

        // 先检查用户名是否已存在（避免验证码被消费后才发现用户名重复）
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            logUserAction(req, 'REGISTER_FAILED', { username, reason: '用户已存在' });
            return res.json({ code: 400, message: '用户已存在' });
        }

        // 验证邮箱验证码
        if (!verificationCode) {
            return res.json({ code: 400, message: '请提供验证码' });
        }

        const verifyResult = await verificationCodeService.verifyCode(email, verificationCode);
        if (!verifyResult.success) {
            return res.json({ code: 400, message: verifyResult.message });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        // 创建用户对象
        const userData = {
            username,
            password: hashedPassword,
            email,
            role: 'user',
            status: 'active'
        };

        const newUser = new User(userData);
        await newUser.save();

        logUserAction(req, 'REGISTER_SUCCESS', { username, userId: newUser._id });
        logger.info(`新用户注册成功: ${username}`);

        return res.json({ code: 200, message: '注册成功' });
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

router.post('/logout', (req, res) => {
    try {
        const userId = req.session?.userid;

        req.session.destroy((err) => {
            if (err) {
                logApiError(req, err, 500);
                return res.json({ code: 500, message: '退出登录失败' });
            }

            res.clearCookie('sid');
            logUserAction(req, 'LOGOUT_SUCCESS', { userId });
            logger.info(`用户退出登录: ${userId}`);

            return res.json({ code: 200, message: '退出登录成功' });
        });
    } catch (error) {
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 上传头像
router.post('/upload-avatar', avatarUpload.single('avatar'), async (req, res) => {
    try {
        const { userid } = req.session;
        if (!userid) {
            return res.json({ code: 401, message: '请先登录' });
        }

        if (!req.file) {
            return res.json({ code: 400, message: '请选择要上传的图片' });
        }

        const avatarPath = '/avatars/' + req.file.filename;

        // 更新用户头像
        const user = await User.findById(userid);
        if (!user) {
            return res.json({ code: 404, message: '用户不存在' });
        }

        // 如果用户已有头像且不是默认头像，则删除旧头像
        if (user.avatar && !user.avatar.startsWith('http')) {
            const oldAvatarPath = path.join(__dirname, '../../public', user.avatar);
            if (fs.existsSync(oldAvatarPath)) {
                fs.unlinkSync(oldAvatarPath);
                logger.info(`删除旧头像: ${oldAvatarPath}`);
            }
        }

        user.avatar = avatarPath;
        await user.save();

        logUserAction(req, 'UPLOAD_AVATAR', { userId: userid, avatarPath });
        logger.info(`用户 ${userid} 上传头像成功: ${avatarPath}`);

        res.json({
            code: 200,
            message: '头像上传成功',
            data: {
                avatar: avatarPath
            }
        });
    } catch (error) {
        logger.error('上传头像失败:', error);
        logApiError(req, error, 500);
        res.json({ code: 500, message: '上传头像失败' });
    }
});

router.get('/info', async (req, res) => {
    try {
        // 禁用缓存，确保每次请求都返回完整数据
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        // 确保 session 存在
        if (!req.session) {
            return res.status(401).json({ code: 401, message: '未登录', redirect: '/login' });
        }

        const { userid } = req.session || {};
        if (!userid) {
            return res.status(401).json({ code: 401, message: '未登录', redirect: '/login' });
        }

        const user = await User.findById(userid);
        if (!user) {
            return res.json({ code: 400, message: '用户不存在' });
        }

        // 计算今日学习单词数
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayWords = user.cet4.todayStudiedWords || 0;

        // 计算连续学习天数
        const streakDays = user.cet4.streakDays || 0;

        logUserAction(req, 'GET_USER_INFO', { userId: userid });

        // 确保用户有chapters字段，如果没有则初始化
        if (!user.chapters || user.chapters.size === 0) {
            user.chapters = new Map([
                ['A', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }],
                ['B', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }]
            ]);
            user.currentChapter = user.currentChapter || 'A';
            await user.save();
        }

        // 将 Mongoose Map 转换为普通对象
        const chaptersObj = {};
        if (user.chapters) {
            user.chapters.forEach((value, key) => {
                chaptersObj[key] = value;
            });
        }

        return res.json({
            code: 200,
            message: '获取用户信息成功',
            _id: user._id,
            username: user.username,
            role: user.role || 'user',
            status: user.status || 'active',
            createdAt: user.createdAt || user.createTime || new Date(),
            updatedAt: user.updatedAt || new Date(),
            creatTime: user.createTime,
            avatar: user.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=default',
            cet4: user.cet4,
            todayWords: todayWords,
            streakDays: streakDays,
            totalWords: user.totalWords,
            planStudyWords: user.planStudyWords,
            planReviweWords: user.planReviweWords,
            question_completed: user.question_completed,
            ai_choose_completed: user.ai_choose_completed,
            // 新增多章节支持
            chapters: chaptersObj,
            currentChapter: user.currentChapter
        });
    } catch (error) {
        logger.error('获取用户信息失败:', error);
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

router.post('/changeinfo', async (req, res) => {
    try {
        const { userid } = req.session;

        if (!userid) {
            return res.json({ code: 401, message: '请先登录' });
        }

        if (!req.body || Object.keys(req.body).length === 0) {
            return res.json({ code: 400, message: '请求体不能为空' });
        }

        const { username, password, planStudyWords, planReviweWords, question_completed, ai_choose_completed, wordP, spellP, listenP, customsP, coverP } = req.body;
        const updateData = {};
        const cet4Update = {};
        // 验证用户名
        if (username !== undefined) {
            if (!username || username.trim().length < 2) {
                return res.json({ code: 400, message: '用户名至少需要2个字符' });
            }

            // 检查用户名是否已存在（排除当前用户）
            const existingUser = await User.findOne({
                username: username.trim(),
                _id: { $ne: userid }
            });

            if (existingUser) {
                return res.json({ code: 400, message: '用户名已存在' });
            }

            updateData.username = username.trim();
        }
        // 验证问卷完成状态
        if (question_completed !== undefined) {
            updateData.question_completed = question_completed;
        }
        // 验证AI选择完成状态
        if (ai_choose_completed !== undefined) {
            updateData.ai_choose_completed = ai_choose_completed;
        }
        // 验证密码（修改时需哈希后存储）
        if (password !== undefined) {
            if (!password || password.length < 6) {
                return res.json({ code: 400, message: '密码至少需要6个字符' });
            }
            updateData.password = await bcrypt.hash(password, SALT_ROUNDS);
        }

        // 验证学习计划
        if (planStudyWords !== undefined) {
            const studyWords = parseInt(planStudyWords);
            if (isNaN(studyWords) || studyWords < 1 || studyWords > 100) {
                return res.json({ code: 400, message: '每日学习单词数应在1-100之间' });
            }
            updateData.planStudyWords = studyWords;
        }

        if (planReviweWords !== undefined) {
            const reviewWords = parseInt(planReviweWords);
            if (isNaN(reviewWords) || reviewWords < 1 || reviewWords > 50) {
                return res.json({ code: 400, message: '每日复习单词数应在1-50之间' });
            }
            updateData.planReviweWords = reviewWords;
        }

        // 获取用户当前章节
        const user = await User.findById(userid);
        if (!user) {
            return res.json({ code: 404, message: '用户不存在' });
        }

        // 确保用户有chapters字段
        if (!user.chapters || user.chapters.size === 0) {
            user.chapters = new Map([
                ['A', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }],
                ['B', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }]
            ]);
            user.currentChapter = user.currentChapter || 'A';
        }

        const currentChapter = user.currentChapter || 'A';

        // 关卡进度更新 - 只更新当前章节，移除cet4冗余字段
        const progressFields = { wordP, spellP, listenP, customsP, coverP };
        for (const field in progressFields) {
            if (progressFields[field] !== undefined) {
                // 只更新当前章节的进度
                const chapterProgress = user.chapters.get(currentChapter) || {};
                chapterProgress[field] = !!progressFields[field];
                user.chapters.set(currentChapter, chapterProgress);
            }
        }

        // 合并所有更新
        const finalUpdate = { ...updateData, ...cet4Update };

        // 保存章节进度
        await user.save();

        // 更新用户信息
        const updatedUser = await User.findByIdAndUpdate(
            userid,
            { $set: finalUpdate },
            { new: true, runValidators: true }
        );

        if (!updatedUser) {
            return res.json({ code: 404, message: '用户不存在' });
        }


        // 记录操作日志
        logUserAction(req, 'UPDATE_USER_INFO', {
            userId: userid,
            updatedFields: Object.keys(updateData)
        });

        res.json({
            code: 200,
            message: '修改成功',
            data: {
                username: updatedUser.username,
                planStudyWords: updatedUser.planStudyWords,
                planReviweWords: updatedUser.planReviweWords,
                cet4: updatedUser.cet4
            }
        });

    } catch (err) {
        console.error('修改用户信息失败:', err);
        logApiError(req, err, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
})
// 切换章节接口
router.post('/switch-chapter', async (req, res) => {
    try {
        const { userid } = req.session;
        const { chapter } = req.body;

        if (!userid) {
            return res.json({ code: 401, message: '请先登录' });
        }

        if (!chapter || !['A', 'B'].includes(chapter)) {
            return res.json({ code: 400, message: '无效的章节' });
        }

        const user = await User.findById(userid);
        if (!user) {
            return res.json({ code: 404, message: '用户不存在' });
        }

        // 确保用户有chapters字段
        if (!user.chapters || user.chapters.size === 0) {
            user.chapters = new Map([
                ['A', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }],
                ['B', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }]
            ]);
        }

        user.currentChapter = chapter;
        await user.save();

        logUserAction(req, 'SWITCH_CHAPTER', { userId: userid, chapter });

        res.json({
            code: 200,
            message: '切换章节成功',
            currentChapter: chapter,
            chapterProgress: user.chapters.get(chapter)
        });

    } catch (error) {
        console.error('切换章节失败:', error);
        logApiError(req, error, 500);
        return res.json({ code: 500, message: '服务器内部错误' });
    }
});

// 关卡进度函数
async function advanceToNextStage(userid) {
    const user = await User.findById(userid);
    if (!user) throw new Error('User not found for stage advancement');

    const [letter, number] = user.cet4.position.split(':');
    const nextLetter = String.fromCharCode(letter.charCodeAt(0) + 1);

    // 更新 position 并重置所有关卡进度
    user.cet4.position = `${nextLetter}:${number}`;
    user.cet4.wordP = false;
    user.cet4.spellP = false;
    user.cet4.listenP = false;
    user.cet4.customsP = false;
    user.cet4.coverP = false;

    await user.save();
}

// 获取用户进度数据
router.get('/user/progress', async (req, res) => {
    try {
        const userid = req.session.userid;
        if (!userid) {
            return res.json({
                code: 401,
                message: '请先登录'
            });
        }

        const user = await User.findById(userid);
        if (!user) {
            return res.json({
                code: 404,
                message: '用户不存在'
            });
        }

        logUserAction(req, 'GET_USER_PROGRESS', { userId: userid });

        // 返回用户进度数据
        res.json({
            code: 200,
            data: {
                completedChapters: user.chapters ? user.chapters.size : 0,
                completedTasks: user.totalWords || 0,
                totalStudyTime: user.totalStudyTime || 0,
                currentChapter: user.cet4 ? user.cet4.position : null
            }
        });
    } catch (error) {
        logApiError(req, error, 500);
        res.status(500).json({
            code: 500,
            message: '获取用户进度失败',
            error: error.message
        });
    }
});

module.exports = router;