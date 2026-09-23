const mongoose = require('mongoose');

let userSchema = new mongoose.Schema({
    role: {
        type: String,
        enum: ['user', 'admin', 'manager'],
        default: 'user'
    },
    status: {
        type: String,
        enum: ['active', 'disabled', 'pending'],
        default: 'active'
    },
    username: {
        type: String,
        required: true,
        unique: true,
    },
    password: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        unique: true,
        sparse: true, // 允许为空，但如果有值必须唯一
        validate: {
            validator: function(v) {
                return !v || /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(v);
            },
            message: '请输入有效的邮箱地址'
        }
    },
    phone: {
        type: String,
        unique: true,
        sparse: true, // 允许为空，但如果有值必须唯一
        validate: {
            validator: function(v) {
                return !v || /^1[3-9]\d{9}$/.test(v);
            },
            message: '请输入有效的手机号码'
        }
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    avatar: {
        type: String,
        default: 'https://api.dicebear.com/7.x/avataaars/svg?seed=default'
    },
    cet4: {
        position: {
            type: String,
            default: 'A:0'
        },
        // 移除冗余的关卡状态字段，只保留学习统计数据
        lastStudyTime: {
            type: Date,
            default: Date.now
        },
        learnedWords: {
            type: Number,
            default: 0
        },
        todayStudiedWords: {
            type: Number,
            default: 0
        },
        streakDays: {
            type: Number,
            default: 0
        },
        lastStudyDate: {
            type: Date,
            default: Date.now
        }
    },
    // 多章节进度支持
    chapters: {
        type: Map,
        of: {
            level: { type: Number, default: 1 },
            score: { type: Number, default: 0 },
            completedWords: { type: Number, default: 0 },
            wordP: { type: Boolean, default: false },
            spellP: { type: Boolean, default: false },
            listenP: { type: Boolean, default: false },
            customsP: { type: Boolean, default: false },
            coverP: { type: Boolean, default: false }
        },
        default: function() {
            return new Map([
                ['A', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }],
                ['B', { level: 1, score: 0, completedWords: 0, wordP: false, spellP: false, listenP: false, customsP: false, coverP: false }]
            ]);
        }
    },
    currentChapter: {
        type: String,
        default: 'A'
    },
    totalWords: {
        type: Number,
        default: 0
    },
    // 学习历史记录
    studyHistory: {
        type: [{
            date: {
                type: Date,
                required: true
            },
            words: {
                type: Number,
                default: 0
            }
        }],
        default: []
    },
    planReviweWords: {
        type: Number,
        default: 30
    },
    planStudyWords: {
        type: Number,
        default: 30
    },
    question_completed: {
        type: Boolean,
        default: false
    },
    ai_choose_completed: {
        type: Boolean,
        default: false
    },
    createTime: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    // 签到相关字段
    checkIn: {
        lastCheckInDate: {
            type: Date,
            default: null
        },
        continuousCheckInDays: {
            type: Number,
            default: 0
        },
        totalCheckInDays: {
            type: Number,
            default: 0
        },
        checkInRewards: {
            type: Map,
            of: Boolean,
            default: new Map()
        }
    }
}, { timestamps: true });

userSchema.pre('save', function(next) {
    if (!this.createdAt) {
        this.createdAt = new Date();
    }
    this.updatedAt = new Date();
    next();
});

const User = mongoose.model('User', userSchema);
module.exports = User;