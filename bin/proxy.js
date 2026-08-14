// OpenCode 伪装代理：注入客户端标识头后，将 /v1 请求原样透传给上游 zen 服务
// 环境变量：PORT=18080  /  ZEN_TARGET=https://opencode.ai/zen
const express = require('express')
const http = require('http')
const https = require('https')
const crypto = require('node:crypto')

const TARGET = process.env.ZEN_TARGET || 'https://opencode.ai/zen'
const UA = 'opencode/1.18.18 (windows amd64; go1.24.0)'
const sha = (prefix, value) => prefix + '_' + crypto.createHash('sha256').update(prefix + '\x00' + value).digest('hex').slice(0, 24)
const rand = (prefix) => prefix + '_' + crypto.randomBytes(16).toString('hex')

const app = express()

// 生成注入的伪装头
function buildHeaders(req) {
    // 会话信号：客户端显式携带则哈希稳定；否则每次随机
    const sessionSignal =
        req.headers['x-opencode-session'] ||
        req.headers['x-session-id'] ||
        req.headers['conversation-id']
    return {
        'User-Agent': UA,
        'x-opencode-client': 'cli',
        'x-opencode-session': sessionSignal ? sha('ses', sessionSignal) : rand('ses'),
        'x-opencode-request': rand('req'),
        'x-opencode-project': sha('prj', req.headers['x-opencode-project'] || 'opencode:default-project'),
    }
}

// 转发到上游：追加 target 的路径前缀 + 原始请求路径，注入伪装头，其余原样透传
function forward(req, res) {
    const target = new URL(TARGET.replace(/\/+$/, '') + req.originalUrl)
    const headers = { ...req.headers, ...buildHeaders(req) }
    delete headers['host']          // 改写为上游 Host
    delete headers['connection']    // 去除逐跳头

    const httpModule = target.protocol === 'https:' ? https : http
    const proxyReq = httpModule.request(target, { method: req.method, headers }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers)
        proxyRes.pipe(res)
    })
    proxyReq.setTimeout(60_000, () => proxyReq.destroy(new Error('proxy timeout')))
    proxyReq.on('error', (err) => {
        console.error('Proxy error:', err.message)
        if (!res.headersSent) res.status(502).json({ error: 'Proxy failed' })
        else res.end()
    })
    req.pipe(proxyReq)
}

// 仅代理 /v1 路径，其余请求由 express 返回 404
app.use('/v1', (req, res) => forward(req, res))

const PORT = Number(process.env.PORT || 8080)
app.listen(PORT, () => console.log(`opencode zen proxy on :${PORT} -> ${TARGET}`))
