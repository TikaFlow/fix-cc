# fix-cc

修复 Claude Code 请求中 system message 格式的轻量级代理服务器。

## 概述

Claude Code 发送 API 请求时，system message 有时会以 `messages` 数组中的 `role: "system"` 条目形式存在，而非顶层 `system` 字段。部分第三方 Anthropic 风格接口不兼容这种格式：

```
API Error: 400 Failed to build prompt: System message must be at the beginning.
```

`fix-cc` 作为中间代理，自动将 `messages` 中的 system 内容提取并合并到顶层 `system` 字段。

## 安装

### 全局安装

```bash
npm i -g github:TikaFlow/fix-cc
```

### 临时运行（无需安装）

```bash
npx github:TikaFlow/fix-cc -u https://your-api-endpoint.com -p 8080
```

## 使用

```bash
# 指定目标 API 和端口
fix-cc -u https://your-api-endpoint.com -p 8080

# 使用长选项
fix-cc --target-url https://your-api-endpoint.com --port 8080
```

然后配置 Claude Code 将 API 请求指向该代理。

### CLI 选项

| 选项 | 别名 | 说明 | 默认值 |
|------|------|------|--------|
| `--target-url` | `-u` | 目标 API 基础 URL | 必填 |
| `--port` | `-p` | 代理服务器监听端口 | `3210` |

## 工作原理

1. 接收客户端发来的 POST `/v1/messages` 请求
2. 将 `messages` 数组中所有 `role: "system"` 条目的内容提取到顶层 `system` 字段
3. 非 system 的消息保持原顺序
4. 其他请求完全透传，不做任何修改

## 许可证

MIT © TikaFlow