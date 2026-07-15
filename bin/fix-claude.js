#!/usr/bin/env node

const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { program } = require('commander');

// ---------- 解析命令行参数 ----------
program
    .option('-u, --target-url <url>', '目标 API 基础 URL')
    .option('-p, --port <port>', '代理服务器监听端口', parseInt)
    .parse(process.argv);

const options = program.opts();
const TARGET_URL = options.targetUrl || '';
const PORT = options.port || 3210;

const app = express();

// 通用转发函数
function forwardRequest(req, res, payloadString) {
    const target = new URL(req.originalUrl, TARGET_URL);
    const headers = { ...req.headers };
    delete headers['content-length'];
    delete headers['host'];
    delete headers['connection'];

    let payloadBuffer = null;
    if (payloadString !== null) {
        payloadBuffer = Buffer.from(payloadString, 'utf8');
        headers['content-type'] = 'application/json';
        headers['content-length'] = payloadBuffer.length;
    }

    const options = { method: req.method, headers };
    const httpModule = target.protocol === 'https:' ? https : http;
    const proxyReq = httpModule.request(target, options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('Proxy error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Proxy failed' });
        else res.end();
    });

    if (payloadBuffer) {
        proxyReq.write(payloadBuffer);
        proxyReq.end();
    } else {
        req.pipe(proxyReq);
    }
}

// 只对 POST /v1/messages 进行 body 覆盖
app.post('/v1/messages', express.json({ limit: '10mb' }), (req, res) => {
    const body = req.body || {};
    const messages = body.messages || [];
    let topSystem = body.system; // 可能为 undefined、string 或 array

    // 统一将顶层 system 转为数组格式
    if (typeof topSystem === 'string') {
        topSystem = [{ type: 'text', text: topSystem }];
    } else if (!Array.isArray(topSystem)) {
        topSystem = [];
    }

    const newMessages = [];

    // 提取 messages 中的 system 提取、并合并到顶层
    for (const msg of messages) {
        if (msg.role === 'system') {
            // 提取 system 内容
            if (typeof msg.content === 'string') {
                topSystem.push({ type: 'text', text: msg.content });
            } else if (Array.isArray(msg.content)) {
                topSystem.push(...msg.content);
            } else if (msg.content) {
                topSystem.push({ type: 'text', text: String(msg.content) });
            }
        } else {
            newMessages.push(msg);
        }
    }

    // 构造新 body
    const newBody = {
        ...body,
        messages: newMessages,
        system: topSystem,
    };

    const payload = JSON.stringify(newBody);
    forwardRequest(req, res, payload);
});

// 其他请求完全透传
app.use((req, res) => {
    forwardRequest(req, res, null);
});

app.listen(PORT, () => {
    console.log(`Proxy running at http://localhost:${PORT}`);
    console.log(`Forwarding to ${TARGET_URL}`);
});