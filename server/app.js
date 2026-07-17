const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fs = require('fs');
const MongoStore = require('connect-mongo');
const session = require('express-session');
const morgan = require('morgan');
const { port, host } = require('./config/serve');
const db = require('./config/db');
const { logger, accessLogStream, logApiError } = require('./utils/logger');

// 路由引入
const { router: getwordRouter } = require('./router/third_part/getword');
const authRouter = require('./router/auth');
const wordRouter = require('./router/word_updated_new');
const vocabularyRouter = require('./router/vocabulary');
const vocabularyLearningRouter = require('./router/vocabularyLearning');
const flashcardStatsRouter = require('./router/flashcardStats');
const commendWordsRouter = require('./router/commendWords');
const logsRouter = require('./router/logs');
const aiRouter = require('./router/ai');
const checkInRouter = require('./router/checkin');
const reviewPlanRouter = require('./router/reviewPlan');
const favoriteWordsRouter = require('./router/favoriteWords');
const questionRouter = require('./router/question');
const reportRouter = require('./router/report_new');
const storyRouter = require('./router/story_new');
const storyProgressRouter = require('./router/storyProgress');
const listeningRouter = require('./router/listening');
const studyRecordRouter = require('./router/studyRecord');
const friendsRouter = require('./router/friends');
const settingsRouter = require('./router/settings');
const chatRouter = require('./router/chat');
const oralRouter = require('./router/oral');
const userProgressRouter = require('./router/userProgress');

const app = express();

// CORS配置
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// 数据库连接
db(() => {
    logger.info('数据库连接成功');
});

// 中间件配置
app.use(morgan('combined', { stream: accessLogStream }));
app.use(morgan('dev'));

// 会话配置 - 使用 MongoDB 作为 session 存储
app.use(session({
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'your-super-secret-key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/session',
        collectionName: 'sessions',
        ttl: 86400 // 24小时过期
    }),
    cookie: {
        maxAge: 86400000, // 24小时
        secure: process.env.NODE_ENV === 'production', // 生产环境使用 HTTPS
        httpOnly: true,
        sameSite: 'lax' // 使用lax以支持同站请求
    }
}));
logger.info('MongoDB session store 初始化成功');

// 请求体解析
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务
const publicPath = path.resolve(__dirname, '../public');
console.log('静态文件目录:', publicPath);

// 确保avatars目录存在
const avatarsPath = path.join(publicPath, 'avatars');
if (!fs.existsSync(avatarsPath)) {
    console.log('创建avatars目录:', avatarsPath);
    fs.mkdirSync(avatarsPath, { recursive: true });
}

// 配置静态文件服务，设置正确的缓存头
app.use('/avatars', express.static(avatarsPath, {
    maxAge: '1d', // 缓存1天
    etag: true,
    lastModified: true
}));

// 其他静态文件
app.use(express.static(publicPath));

// 认证中间件
function requireAuth(req, res, next) {
    // 白名单路由 - 不需要登录即可访问
    const publicPaths = [
        '/api/auth/login', 
        '/api/auth/register', 
        '/word',
        '/api/oral',  // 口语评测接口
        '/api/oral/config',
        '/api/oral/evaluate',
        '/api/oral/batch-evaluate'
    ];
    if (publicPaths.some(path => req.originalUrl.startsWith(path))) {
        return next();
    }

    // 检查会话
    if (req.session?.isLogin && req.session?.userid) {
        next();
    } else {
        res.status(401).json({
            code: 401,
            message: '未登录',
            redirect: '/login'
        });
    }
}

// 路由配置
app.get('/', (req, res) => {
    res.send('Hello World');
});

// 测试静态文件服务
app.get('/test-static', (req, res) => {
    const testPath = path.join(publicPath, 'avatars');
    const files = fs.existsSync(testPath) ? fs.readdirSync(testPath) : [];
    res.json({
        publicPath,
        avatarsPath: testPath,
        files,
        exists: fs.existsSync(testPath)
    });
});

// 先注册认证路由（不需要认证）
app.use('/api/auth', authRouter);

// 应用认证中间件到其他需要认证的路由
app.use('/api', requireAuth);

app.use('/api/word', getwordRouter, wordRouter);
app.use('/api/vocabulary', vocabularyRouter);
app.use('/api/vocabulary-learning', vocabularyLearningRouter);
app.use('/api/flashcard', flashcardStatsRouter);
app.use('/api/commendWords', commendWordsRouter);
app.use('/logs', logsRouter);
app.use('/api/aiApi', aiRouter);
app.use('/api/checkin', checkInRouter);
app.use('/api/reviewPlan', reviewPlanRouter);
app.use('/api/favoriteWords', favoriteWordsRouter);
app.use('/api/question', questionRouter);
app.use('/api/report', reportRouter);
app.use('/api/story', storyRouter);
app.use('/api/story', storyProgressRouter);
app.use('/api/listening', listeningRouter);
app.use('/api/study-record', studyRecordRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/oral', oralRouter);
app.use('/api/user', userProgressRouter);

// 404处理
app.use((req, res) => {
    logger.warn(`404 Not Found: ${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });

    res.status(404).json({
        code: 404,
        message: '请求的资源不存在'
    });
});

// 全局错误处理
app.use((err, req, res, next) => {
    logApiError(req, err, err.status || 500);

    res.status(err.status || 500).json({
        code: err.status || 500,
        message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message,
        error: process.env.NODE_ENV === 'production' ? {} : err
    });
});

// 优雅关闭
let server;

const gracefulShutdown = (signal) => {
    logger.info(`收到${signal}信号，正在关闭服务器...`);
    if (server) {
        server.close(() => {
            logger.info('服务器已关闭');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }

    // 强制关闭超时
    setTimeout(() => {
        logger.error('服务器关闭超时，强制退出');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 服务器启动
server = app.listen(port, host, () => {
    logger.info('服务器启动成功', {
        host,
        port,
        env: process.env.NODE_ENV || 'development',
        pid: process.pid
    });
    console.log(`服务器运行在 http://${host}:${port}`);
});

// 错误处理
process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的Promise拒绝', {
        reason: reason,
        promise: promise
    });
});