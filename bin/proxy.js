const express = require('express')
const crypto = require('node:crypto')
const { createProxyMiddleware } = require('http-proxy-middleware')

const TARGET = process.env.ZEN_TARGET || 'https://opencode.ai/zen'
const UA = 'opencode/1.18.18 (windows amd64; go1.24.0)'
const sha = (prefix, value) => prefix + '_' + crypto.createHash('sha256').update(prefix + '\x00' + value).digest('hex').slice(0, 24)
const rand = (prefix) => prefix + '_' + crypto.randomBytes(16).toString('hex')

const app = express()
app.use(createProxyMiddleware({
    target: TARGET,
    pathFilter: '/v1',
    changeOrigin: true,
    proxyTimeout: 60_000,
    on: {
        proxyReq(proxyReq, req) {
            const sessionSignal =
                req.headers['x-opencode-session'] ||
                req.headers['x-session-id'] ||
                req.headers['conversation-id']
            proxyReq.setHeader('User-Agent', UA)
            proxyReq.setHeader('x-opencode-client', 'cli')
            proxyReq.setHeader('x-opencode-session', sessionSignal ? sha('ses', sessionSignal) : rand('ses'))
            proxyReq.setHeader('x-opencode-request', rand('req'))
            proxyReq.setHeader('x-opencode-project', sha('prj', req.headers['x-opencode-project'] || 'opencode:default-project'))
        },
    },
}))

const PORT = Number(process.env.PORT || 8080)
app.listen(PORT, () => console.log(`opencode zen proxy on :${PORT} -> ${TARGET}`))
