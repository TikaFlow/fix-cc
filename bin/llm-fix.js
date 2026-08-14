#!/usr/bin/env node

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('node:crypto');
const { program } = require('commander');

// ---------- 解析命令行参数 ----------
program
    .option('--host <host>', '监听地址（默认 127.0.0.1）', '127.0.0.1')
    .option('-p, --port <port>', '监听端口（默认 3210）', parseInt, 3210)
    .option('-b, --body-rewrite <key=value>', '覆盖请求体字段（仅处理点：/nova/v1/messages 与 /zen/v1/*，JSON body），支持点号路径，可多次使用', (val, acc) => acc.concat([val]), [])
    .option('--thinking <value>', 'body 覆盖 thinking.type=<value>，仅 /nova/v1/messages')
    .option('--header-rewrite <key=value>', '覆盖出站请求头（仅处理点：/nova/v1/messages 与 /zen/v1/*），可多次使用', (val, acc) => acc.concat([val]), [])
    .parse(process.argv);

const options = program.opts();
const HOST = options.host;
const PORT = options.port;

// 上游目标（固定，不读环境变量）
const NOVA_TARGET = 'https://token.sensenova.cn';
const ZEN_TARGET = 'https://opencode.ai/zen';
const ZEN_UA = 'opencode/1.18.18 (windows amd64; go1.24.0)';
const UPSTREAM_TIMEOUT = 120_000;   // 等待上游"响应开始"的上限；响应开始后流式响应不限时长
const MAX_BODY = 20 * 1024 * 1024;  // 缓冲请求体的上限，超出返回 413

// 预解析覆盖规则（仅处理点生效）
const headerRewrite = {};
for (const entry of (options.headerRewrite || [])) {
    const eq = entry.indexOf('=');
    if (eq !== -1) headerRewrite[entry.slice(0, eq)] = entry.slice(eq + 1);
}
const bodyRewrites = (options.bodyRewrite || [])
    .map((entry) => {
        const eq = entry.indexOf('=');
        return eq === -1 ? null : { key: entry.slice(0, eq), value: entry.slice(eq + 1) };
    })
    .filter(Boolean);
const thinkingValue = options.thinking || null;

const app = express();

// ---------- 工具函数 ----------

// 按点号路径设置对象属性值（如 "thinking.type"）
function setByPath(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}

// 缓冲请求体（仅处理点需要覆盖 body 时使用），超出上限报错
function bufferBody(req, cb) {
    const chunks = [];
    let size = 0;
    let stopped = false;
    req.on('error', (e) => { if (!stopped) { stopped = true; cb(e); } });
    req.on('data', (chunk) => {
        if (stopped) return;
        size += chunk.length;
        if (size > MAX_BODY) {
            stopped = true;
            req.pause();
            cb(new Error('Request body too large'));
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => { if (!stopped) cb(null, Buffer.concat(chunks)); });
}

// /nova：将 messages 中的 system 提取并合并到顶层 system 字段
function foldSystem(body) {
    const messages = body.messages || [];
    let topSystem = body.system; // 可能为 undefined、string 或 array
    if (typeof topSystem === 'string') {
        topSystem = [{ type: 'text', text: topSystem }];
    } else if (!Array.isArray(topSystem)) {
        topSystem = [];
    }
    const rest = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            if (typeof msg.content === 'string') {
                topSystem.push({ type: 'text', text: msg.content });
            } else if (Array.isArray(msg.content)) {
                topSystem.push(...msg.content);
            } else if (msg.content) {
                topSystem.push({ type: 'text', text: String(msg.content) });
            }
        } else {
            rest.push(msg);
        }
    }
    body.messages = rest;
    body.system = topSystem;
}

// ---------- 转发核心 ----------
// opts: { transform?, rewriteBody?, applyThinking?, extraHeaders? }
//   transform      对解析后的 JSON body 做结构化改写（/nova/v1/messages 的 system 折叠）
//   rewriteBody    是否应用 --body-rewrite（仅处理点）
//   applyThinking  是否写入 --thinking（仅 /nova/v1/messages）
//   extraHeaders   额外注入的请求头（处理点：headerRewrite + /zen/v1 伪装头）
// 未配置任何 body 覆盖时流式透传；需要覆盖时缓冲 body 再转发
function forward(req, res, targetBase, opts) {
    const transform = opts.transform || null;
    const rewriteBody = opts.rewriteBody || false;
    const applyThinking = opts.applyThinking || false;
    const extraHeaders = opts.extraHeaders || null;
    const needBuf = transform || (rewriteBody && bodyRewrites.length > 0) || (applyThinking && thinkingValue);

    // 实际发送：payload 为 null 表示流式透传（保留原 content-length）
    const send = (payload, asJson) => {
        const target = new URL(targetBase.replace(/\/+$/, '') + req.url);
        const headers = { ...req.headers, ...extraHeaders };
        delete headers['host'];       // 改写为上游 Host
        delete headers['connection']; // 去除逐跳头
        if (payload !== null) {
            delete headers['content-length']; // 改写负载需重算
            if (payload.length) {
                if (asJson) headers['content-type'] = 'application/json';
                headers['content-length'] = payload.length;
            }
        }

        const httpModule = target.protocol === 'https:' ? https : http;
        let timer;
        const proxyReq = httpModule.request(target, { method: req.method, headers }, (proxyRes) => {
            clearTimeout(timer); // 响应已开始，解除超时（流式响应不限时长）
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });
        // 120s 内未收到响应头则超时；其余上游错误不伪造响应，直接断开
        timer = setTimeout(() => {
            const err = new Error('upstream timeout');
            err.code = 'ETIMEDOUT';
            proxyReq.destroy(err);
        }, UPSTREAM_TIMEOUT);
        proxyReq.on('error', (err) => {
            clearTimeout(timer);
            if (err.code === 'ETIMEDOUT' && !res.headersSent) {
                res.status(504).json({ error: 'Upstream timeout' });
            } else if (res.headersSent) {
                res.end();
            } else {
                res.destroy();
            }
        });

        if (payload !== null) {
            proxyReq.write(payload);
            proxyReq.end();
        } else {
            req.pipe(proxyReq);
        }
    };

    if (!needBuf) return send(null, false); // 无覆盖：流式透传

    bufferBody(req, (err, buf) => {
        if (err) {
            if (!res.headersSent) res.status(413).json({ error: err.message });
            else res.end();
            return;
        }
        let payload = buf;
        let asJson = false;
        if (buf.length) {
            try {
                const obj = JSON.parse(buf.toString('utf8'));
                if (transform) transform(obj);
                if (rewriteBody) {
                    for (const rule of bodyRewrites) setByPath(obj, rule.key, rule.value);
                }
                if (applyThinking && thinkingValue) setByPath(obj, 'thinking.type', thinkingValue);
                payload = Buffer.from(JSON.stringify(obj), 'utf8');
                asJson = true;
            } catch (e) {
                // 非 JSON body：原样转发
            }
        }
        send(payload, asJson);
    });
}

// ---------- /nova：llm-fix 逻辑 ----------
const nova = express.Router();
nova.post('/v1/messages', (req, res) =>
    forward(req, res, NOVA_TARGET, { transform: foldSystem, rewriteBody: true, applyThinking: true, extraHeaders: headerRewrite }));
// 其余 /nova/* 字节级透传
nova.use((req, res) => forward(req, res, NOVA_TARGET, {}));
app.use('/nova', nova);

// ---------- /zen：opencode 伪装 ----------
const sha = (prefix, value) => prefix + '_' + crypto.createHash('sha256').update(prefix + '\x00' + value).digest('hex').slice(0, 24);
const rand = (prefix) => prefix + '_' + crypto.randomBytes(16).toString('hex');

// 生成注入的伪装头
function buildZenHeaders(req) {
    // 会话信号：客户端显式携带则哈希稳定；否则每次随机
    const sessionSignal =
        req.headers['x-opencode-session'] ||
        req.headers['x-session-id'] ||
        req.headers['conversation-id'];
    return {
        'User-Agent': ZEN_UA,
        'x-opencode-client': 'cli',
        'x-opencode-session': sessionSignal ? sha('ses', sessionSignal) : rand('ses'),
        'x-opencode-request': rand('req'),
        'x-opencode-project': sha('prj', req.headers['x-opencode-project'] || 'opencode:default-project'),
    };
}

const zen = express.Router();
// /zen/v1 任意路径：注入伪装头，--header-rewrite 覆盖优先
zen.use('/v1', (req, res) =>
    forward(req, res, ZEN_TARGET, { rewriteBody: true, extraHeaders: { ...buildZenHeaders(req), ...headerRewrite } }));
// 其余 /zen/* 字节级透传
zen.use((req, res) => forward(req, res, ZEN_TARGET, {}));
app.use('/zen', zen);

// 自定义终端窗口标题：Windows 用 process.title（底层 SetConsoleTitle，修改 cmd 窗口标题），
// 其余平台在 TTY 下输出 OSC 转义序列（主流终端仿真器均支持）
function setWindowTitle(title) {
    if (process.platform === 'win32') {
        process.title = title;
    } else if (process.stdout.isTTY) {
        process.stdout.write('\x1b]0;' + title + '\x07');
    }
}

app.listen(PORT, HOST, () => {
    console.log(`llm-fix proxy on http://${HOST}:${PORT}`);
    console.log(`  /nova -> ${NOVA_TARGET}`);
    console.log(`  /zen  -> ${ZEN_TARGET}`);
    setWindowTitle('llm-fix');
});
