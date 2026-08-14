# llm-fix

轻量级双端点代理：`/nova` 修复 Claude Code 请求中 system message 格式（并支持 thinking），`/zen` 注入 opencode-cli 伪装头。

## 概述

Claude Code 发送 API 请求时，system message 有时会以 `messages` 数组中的 `role: "system"` 条目形式存在，而非顶层 `system` 字段。部分第三方 Anthropic 风格接口不兼容这种格式：

```
API Error: 400 Failed to build prompt: System message must be at the beginning.
```

`llm-fix` 作为中间代理，提供两个端点，分别对接不同上游：

| 本地前缀 | 上游目标 | 处理内容 |
|---|---|---|
| `/nova` | `https://token.sensenova.cn` | `POST /nova/v1/messages`：把 `messages` 中的 system 折叠到顶层 + `--body-rewrite` + `--thinking` + `--header-rewrite` |
| `/zen` | `https://opencode.ai/zen` | `/zen/v1/*`：注入 opencode-cli 伪装头 + `--body-rewrite` + `--header-rewrite` |

除上述两个处理点外，`/nova`、`/zen` 下的其余请求一律字节级透传；不属于这两个前缀的路径返回 404。

## 安装

### 全局安装

```bash
npm i -g github:TikaFlow/llm-fix
```

### 临时运行（无需安装）

```bash
npx github:TikaFlow/llm-fix
```

## 使用

```bash
# 默认监听 127.0.0.1:3210
llm-fix

# 指定监听地址和端口
llm-fix --host 127.0.0.1 --port 8080

# 覆盖请求体字段（仅处理点，JSON body，支持点号路径，可多次使用）
llm-fix --body-rewrite thinking.type=enabled

# 仅对 /nova/v1/messages 生效的 thinking 覆盖
llm-fix --thinking enabled

# 覆盖出站请求头（仅处理点，可多次使用）
llm-fix --header-rewrite anthropic-version=2023-06-01
```

配置 Claude Code 时，把直连 API 地址的基址替换为本地代理对应前缀，后面路径保留：

- 直连 `https://token.sensenova.cn` → 填 `http://127.0.0.1:3210/nova`
- 直连 `https://opencode.ai/zen` → 填 `http://127.0.0.1:3210/zen`

例如 `https://opencode.ai/zen/v1` → `http://127.0.0.1:3210/zen/v1`。

### CLI 选项

| 选项 | 别名 | 说明 | 默认值 |
|------|------|------|--------|
| `--host <host>` | - | 监听地址 | `127.0.0.1` |
| `--port <port>` | `-p` | 监听端口 | `3210` |
| `--body-rewrite <key=value>` | `-b` | 覆盖请求体字段，支持点号路径（如 `thinking.type=enabled`），仅处理点、JSON body，可多次指定 | 空 |
| `--thinking <value>` | - | body 覆盖 `thinking.type=<value>`，仅 `/nova/v1/messages`；常见值 `enabled` / `disabled` / `auto` | 空 |
| `--header-rewrite <key=value>` | - | 覆盖出站请求头字段（如 `anthropic-version=2023-06-01`），仅处理点，可多次指定 | 空 |

## 工作原理

1. 监听本地端口，`/nova`、`/zen` 分别透传到固定上游，前缀替换、其后路径保留
2. `POST /nova/v1/messages`：将 `messages` 中所有 `role: "system"` 的内容提取到顶层 `system` 字段，应用 `--body-rewrite`、`--thinking`、`--header-rewrite` 后转发
3. `/zen/v1/*`：注入 5 个 opencode-cli 标识头，应用 `--body-rewrite`、`--header-rewrite` 后转发
4. 其余请求字节级透传，不做任何修改
5. 上游 120s 内未返回响应头则返回 504；响应一旦开始即解除超时，流式响应不限时长

## 许可证

MIT © TikaFlow
