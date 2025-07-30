-- 创建数据库表结构
-- TTS应用迁移 - PostgreSQL表结构

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- VIP信息 (JSON格式存储，保持与原KV结构兼容)
    vip_info JSONB DEFAULT '{}',
    
    -- 使用统计 (JSON格式存储)
    usage_stats JSONB DEFAULT '{"totalChars": 0, "monthlyChars": 0, "monthlyResetAt": 0}'
);

-- 创建用户表索引
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 卡密表
CREATE TABLE IF NOT EXISTS cards (
    id SERIAL PRIMARY KEY,
    code VARCHAR(32) UNIQUE NOT NULL,
    package_type VARCHAR(10) NOT NULL, -- M, Q, H, PM, PQ, PH, PT
    status VARCHAR(20) DEFAULT 'unused', -- unused, used, expired
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    used_at TIMESTAMP NULL,
    used_by VARCHAR(50) NULL,
    
    -- 套餐信息 (JSON格式)
    package_info JSONB NOT NULL
);

-- 创建卡密表索引
CREATE INDEX IF NOT EXISTS idx_cards_code ON cards(code);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_used_by ON cards(used_by);

-- 任务状态表
CREATE TABLE IF NOT EXISTS task_status (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(36) UNIQUE NOT NULL,
    username VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL, -- initialized, processing, complete, failed
    
    -- 任务详情 (JSON格式存储)
    task_data JSONB DEFAULT '{}',
    
    -- 结果信息 (JSON格式存储)
    result_data JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL
);

-- 创建任务状态表索引
CREATE INDEX IF NOT EXISTS idx_task_status_task_id ON task_status(task_id);
CREATE INDEX IF NOT EXISTS idx_task_status_username ON task_status(username);
CREATE INDEX IF NOT EXISTS idx_task_status_status ON task_status(status);
CREATE INDEX IF NOT EXISTS idx_task_status_created_at ON task_status(created_at);

-- 语音映射表
CREATE TABLE IF NOT EXISTS voice_mappings (
    id SERIAL PRIMARY KEY,
    voice_name VARCHAR(100) UNIQUE NOT NULL,
    voice_id VARCHAR(100) NOT NULL,
    model_support JSONB DEFAULT '[]', -- 支持的模型列表
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建语音映射表索引
CREATE INDEX IF NOT EXISTS idx_voice_mappings_name ON voice_mappings(voice_name);
CREATE INDEX IF NOT EXISTS idx_voice_mappings_id ON voice_mappings(voice_id);

-- 验证码表（替代KV存储验证码）
CREATE TABLE IF NOT EXISTS verification_codes (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    code VARCHAR(10) NOT NULL,
    expire_time TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建验证码表索引
CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON verification_codes(email);
CREATE INDEX IF NOT EXISTS idx_verification_codes_expire ON verification_codes(expire_time);

-- 邮件发送限制表（防止频繁发送验证码）
CREATE TABLE IF NOT EXISTS email_send_limits (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    last_send_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建邮件发送限制表索引
CREATE INDEX IF NOT EXISTS idx_email_send_limits_email ON email_send_limits(email);
CREATE INDEX IF NOT EXISTS idx_email_send_limits_time ON email_send_limits(last_send_time);

-- 创建更新时间触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为用户表创建更新时间触发器
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- 为任务状态表创建更新时间触发器
DROP TRIGGER IF EXISTS update_task_status_updated_at ON task_status;
CREATE TRIGGER update_task_status_updated_at 
    BEFORE UPDATE ON task_status
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- 插入默认语音映射数据
INSERT INTO voice_mappings (voice_name, voice_id, model_support) VALUES
('Adam', 'pNInz6obpgDQGcFmaJgB', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Alice', 'Xb7hH8MSUJpSbSDYk0k2', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Antoni', 'ErXwobaYiN019PkySvjV', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Arnold', 'VR6AewLTigWG4xSOukaG', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Bill', 'pqHfZKP75CvOlQylNhV4', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Brian', 'nPczCjzI2devNBz1zQrb', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Callum', 'N2lVS1w4EtoT3dr4eOWO', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Charlie', 'IKne3meq5aSn9XLyUdCD', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Charlotte', 'XB0fDUnXU5powFXDhCwa', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Chris', 'iP95p4xoKVk53GoZ742B', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Daniel', 'onwK4e9ZLuTAKqWW03F9', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Dave', 'CYw3kZ02Hs0563khs1Fj', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Domi', 'AZnzlk1XvdvUeBnXmlld', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Dorothy', 'ThT5KcBeYPX3keUQqHPh', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Elli', 'MF3mGyEYCl7XYWbV9V6O', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Emily', 'LcfcDJNUP1GQjkzn1xUU', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Ethan', 'g5CIjZEefAph4nQFvHAz', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Fin', 'D38z5RcWu1voky8WS1ja', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Freya', 'jsCqWAovK2LkecY7zXl4', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('George', 'JBFqnCBsd6RMkjVDRZzb', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Gigi', 'jBpfuIE2acCO8z3wKNLl', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Giovanni', 'zcAOhNBS3c14rBihAFp1', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Glinda', 'z9fAnlkpzviPz146aGWa', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Grace', 'oWAxZDx7w5VEj9dCyTzz', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Harry', 'SOYHLrjzK2X1ezoPC6cr', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('James', 'ZQe5CZNOzWyzPSCn5a3c', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Jeremy', 'bVMeCyTHy58xNoL34h3p', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Jessie', 't0jbNlBVZ17f02VDIeMI', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Joseph', 'Zlb1dXrM653N07WRdFW3', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Josh', 'TxGEqnHWrfWFTfGW9XjX', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Liam', 'TX3LPaxmHKxFdv7VOQHJ', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Matilda', 'XrExE9yKIg1WjnnlVkGX', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Michael', 'flq6f7yk4E4fJM5XTYuZ', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Mimi', 'zrHiDhphv9ZnVXBqCLjz', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Nicole', 'piTKgcLEGmPE4e6mEKli', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Patrick', 'ODq5zmih8GrVes37Dizd', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Rachel', '21m00Tcm4TlvDq8ikWAM', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('River', 'SAz9YHcvj6GT2YYXdXww', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Roger', 'CwhRBWXzGAHq8TQ4Fs17', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Sam', 'yoZ06aMxZJJ28mfd3POQ', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Sarah', 'EXAVITQu4vr4xnSDxMaL', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Serena', 'pMsXgVXv3BLzUgSXRplE', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Thomas', 'GBv7mTt0atIp3Br8iCZE', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]'),
('Will', 'bIHbv24MWmeRgasZH58o', '["eleven_turbo_v2", "eleven_turbo_v2_5", "eleven_v3"]')
ON CONFLICT (voice_name) DO NOTHING;
