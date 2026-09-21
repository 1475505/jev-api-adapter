# Jev Adapter

在 Cloudflare Workers 上，把 Jev 决策接口包装成 OpenAI Chat Completions / Responses 协议。支持 TypeSafe、Vercel AI Gateway、OpenRouter。运行时代码无第三方依赖，不需要数据库。

也提供 Vercel Node.js Functions 入口。完整平台配置及 GitHub 自动部署步骤见 [部署指引](DEPLOYMENT.md)。

请求的 `model` 和上游 API Key 原样使用；结果把 Jev `answers` 序列化成 JSON 文本，放入 assistant message。保留概率、置信度和小数评分，不生成解释、不做阈值判断、不调用另一个 LLM。

## 本地启动

需要 Node.js 22.12+ 和 npm。

```sh
npm ci
cp .env.example .dev.vars
npm run dev
```

默认地址 `http://localhost:8787`。`.dev.vars` 已加入 Git 忽略，默认无需填写任何上游 Key：上游 Key 由每次请求提供。

```sh
curl http://localhost:8787/health
curl http://localhost:8787/v1/models
```

## 请求协议

支持以下端点：

| 端点 | 用途 |
| --- | --- |
| `POST /v1/chat/completions` | Chat Completions 非流式 / SSE |
| `POST /v1/responses` | 无状态 Responses 非流式 / SSE |
| `GET /v1/models` | 静态列出已配置的供应商模型；不是账户可用性查询 |
| `GET /health` | 无鉴权健康检查，不访问上游 |

原始 HTTP 可以在请求体放 `api_key`；OpenAI SDK 则用原生 `apiKey` / `api_key` 配置，通过 `Authorization: Bearer` 传入。二者同时出现必须相同。无需 `extra_body`，SDK 侧用 `defaultHeaders` / `extra_headers` 配置桥接选项。

请求头：

| 请求头 | 作用 / 默认值 |
| --- | --- |
| `X-Jev-Provider` | `typesafe`、`vercel`、`openrouter`；能自动识别时可省略 |
| `X-Jev-Endpoint` | 完整上游 HTTPS POST URL，含路径；不追加 `/v1` 等后缀 |
| `X-Jev-Timeout-Ms` | 上游请求及响应体读取期限，默认 10000，范围 100–60000 |
| `X-Jev-Preset` | 选择预设，直接传普通文本；默认不启用 |
| `X-Jev-Result` | `answers`（默认）或 `full`（将完整上游 JSON 放进 message） |
| `X-Bridge-Key` | 部署者配置 `BRIDGE_API_KEY` 时，用它访问桥接器 |

### JSON 输入

Chat 的单条 user `content` 或 Responses 的 `input` 是 JSON **字符串**，字符串的内容为：

```json
{
  "state": "订单重复扣款，请尽快退款。",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "应该交给哪个部门处理？",
      "criteria": {
        "billing": "支付、账单和退款",
        "technical": "技术故障",
        "other": "其他问题"
      }
    },
    "urgent": {
      "type": "noul",
      "instructions": "客户是否表达了紧迫性？"
    }
  }
}
```

`state` 可用字符串、JSON 对象或数组。`questions` 支持 Noul、Choice、Score，`instructions` 及 criteria 中的指导信息也可用结构化对象或数组。第一版限制 1–64 个问题，Choice 2–255 个选项，Score 2–10 个评分等级。它们是桥接器的明确限制，不代表所有供应商的完整能力。

### 普通自然语言输入

带上 `X-Jev-Preset: sentiment-v1` 时，内容直接作为 `state`，不解析 JSON。

内置预设在 `src/presets.ts`：

| 预设 | 输出 |
| --- | --- |
| `sentiment-v1` | 正面 / 中性 / 负面的选择和权重 |
| `ticket-routing-v1` | 部门选择和紧急程度概率 |

需要新的任务时在这个文件里增加预设；修改规则时建议换版本名。预设模式里，即使输入看起来像 JSON，也会作为普通文本处理。

## 原始 HTTP 示例

以下 OpenRouter 示例使用 Key 前缀自动路由；占位 Key 必须换成你自己的 Key。

```http
POST /v1/chat/completions
Content-Type: application/json
X-Jev-Preset: sentiment-v1

{
  "model": "typesafe/jev-1.13",
  "api_key": "sk-or-v1-YOUR_KEY",
  "messages": [{"role": "user", "content": "体验很好，下次还会来！"}],
  "stream": false
}
```

非预设模式的 Responses 示例：

```http
POST /v1/responses
Content-Type: application/json
X-Jev-Provider: typesafe

{
  "model": "jev-1.13.0",
  "api_key": "YOUR_TYPESAFE_KEY",
  "input": "{\"state\":\"订单被重复扣款\",\"questions\":{\"refund\":{\"type\":\"noul\",\"instructions\":\"是否涉及退款？\"}}}",
  "store": false
}
```

运行示例脚本（会消耗上游账户额度；不要把实际 Key 提交到 Git）：

```sh
export JEV_API_KEY='your-upstream-key'
export JEV_PROVIDER='openrouter'
export JEV_MODEL='typesafe/jev-1.13'
node --import tsx examples/raw.ts
```

还可设置 `BRIDGE_BASE_URL`、`BRIDGE_API_KEY`、`JEV_ENDPOINT`。

## OpenAI SDK（不使用 extra_body）

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.JEV_API_KEY,
  baseURL: 'http://localhost:8787/v1',
  defaultHeaders: {
    'X-Jev-Provider': 'openrouter',
    'X-Jev-Preset': 'sentiment-v1',
  },
  maxRetries: 0,
});

const result = await client.chat.completions.create({
  model: 'typesafe/jev-1.13',
  messages: [{ role: 'user', content: '体验很好，下次还会来！' }],
});
console.log(JSON.parse(result.choices[0].message.content!));

const response = await client.responses.create({
  model: 'typesafe/jev-1.13',
  input: '体验很好，下次还会来！',
  store: false,
});
console.log(JSON.parse(response.output_text));
```

上面两个调用各自发起一次推理。独立可运行的 JSON 输入示例：

```sh
node --import tsx examples/openai.ts
EXAMPLE_API=chat node --import tsx examples/openai.ts
EXAMPLE_API=stream node --import tsx examples/openai.ts
```

Python 的同等用法：

```python
import os, json
from openai import OpenAI

client = OpenAI(
    api_key=os.environ['JEV_API_KEY'],
    base_url='http://localhost:8787/v1',
    default_headers={
        'X-Jev-Provider': 'openrouter',
        'X-Jev-Preset': 'sentiment-v1',
    },
    max_retries=0,
)
response = client.responses.create(
    model='typesafe/jev-1.13', input='体验很好！', store=False,
)
print(json.loads(response.output_text))
```

### 输出

Chat 返回 `choices[0].message.content`；Responses 返回 `output[].content[].text`，OpenAI SDK 会生成便利属性 `output_text`。文本内容示例：

```json
{"sentiment":{"type":"choice","choice":"positive","probabilities":{"positive":0.9,"neutral":0.08,"negative":0.02},"confidence":0.7}}
```

示例数值不代表实际预测。桥接器保留原始权重，不假设 `confidence` 等于最大概率。`usage` 映射上游实际 token 数，输出免费不代表输出 token 数为 0。响应的 `model` 使用上游报告值，可能是解析后的固定版本；请求的模型 ID 始终原样发送。

`stream:true` 在完整决策返回后发送合法 SSE：Chat 使用 chunks 和 `[DONE]`，Responses 使用带 `sequence_number` 的 created、item/part、text delta/done、completed 事件。它不是逐 token 模型推理，不会降低首个内容返回的等待时间。上游失败在 SSE 开始前返回正常 HTTP 错误。Chat 的使用量事件需要 `stream_options: { include_usage: true }`。

## 供应商及路由

| Provider | 默认 endpoint | model 示例 |
| --- | --- | --- |
| typesafe | `https://api.typesafe.ai/v1/systemone` | `jev-latest` / `jev-1.13.0` |
| vercel | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` |
| openrouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` |

OpenRouter 的 operation-level OpenAPI server 是 `https://openrouter.ai`，因此路径是 `/api/alpha/decisions`，不是 `/api/v1/...`。三个原生接口都使用 `model + state + questions` 和 Bearer 鉴权，内部可复用同一个传输层。

路由优先级：显式 `X-Jev-Provider` → 官方 endpoint → 已识别 Key 前缀。目前只识别 OpenRouter 的 `sk-or-v1-`，它是便利规则，不是永久格式保证；其他 Key 必须提供 provider 或官方 endpoint。冲突返回 400，不把同一个 Key 发给不同供应商试探，不根据 model 偷改路由。

### 自定义 endpoint

```http
X-Jev-Provider: openrouter
X-Jev-Endpoint: https://gateway.example.com/custom/decisions
```

在 `wrangler.jsonc` 的 vars（本地也可用 `.dev.vars`）里配置：

```json
{"ALLOWED_UPSTREAM_ORIGINS":"https://gateway.example.com,https://other.example.com"}
```

只接收 HTTPS/443，不允许 IP 字面量、常见本地域名、URL 用户名密码、query、fragment 或重定向。官方域名只允许表中核实的原生决策路径。自定义 origin 必须由部署者显式允许，路径不做自动拼接；不要加入不受自己信任的域名，**允许的域名会收到请求中的上游 Key**。

这不是通用互联网代理。域名白名单是信任边界，不对管理员允许的域名做 DNS pinning；不要允许可由不可信方控制 DNS 或指向内部服务的域名。自定义网关必须遵循所选接口的请求/响应形状。

## 部署到 Cloudflare Workers

```sh
npm run check
npx wrangler login
# 可选：设置桥接器自己的访问密码，使用 X-Bridge-Key 传入
npx wrangler secret put BRIDGE_API_KEY
npm run deploy
```

Wrangler 输出 `https://jev-adapter.<your-subdomain>.workers.dev`，SDK `baseURL` 设置为该地址加 `/v1`。无需把供应商 Key 部署到 Worker。

如果浏览器直接调用，在 `CORS_ORIGINS` 配置准确的前端 origin（逗号分隔，不支持 `*`）。这只控制浏览器跨域，不替代鉴权。服务端 SDK 不需要 CORS。

Workers 免费层有请求数和每请求 CPU 时间限制；纯网络等待不计 CPU，但大 JSON 解析仍计入。部署免费与上游模型费用独立。项目不存储 Key/正文，不缓存结果，也不主动打印它们；自行开启平台日志或外部网关日志时，应另行检查其记录内容。

默认不自动重试，避免隐式重复计费；429 的 `Retry-After` 会保留。SDK 自身可能重试，示例显式关闭。需要共享给其他用户时，可配置 `BRIDGE_API_KEY`，按需在 Cloudflare 添加限流；此项目没有实现分布式配额计数。

## 边界与验证

- 第一版接受单条 user message（字符串或纯文本 parts）；Responses 也接受字符串 input。
- 不接收任意聊天历史、自由文本生成、工具调用、图片/音频、JSON Schema 自动编译。
- 不支持有状态 `previous_response_id`、`store:true`、后台任务或响应检索。缺省 `store` 按 false 处理。
- 不支持 `temperature` / `top_p` 等生成参数；未支持的字段返回 400，不静默忽略。
- 请求最大 256 KiB，上游响应最大 1 MiB，决策 JSON 深度最多 32。超过限制显式报错。
- 标准 OpenAI 风格 `error` 对象；上游报错正文不透传，避免回显凭证。529 转为 503，524 转为 504，重定向转为 502。
- 非法上游结果（缺问题答案、非法类型/范围或缺 usage）返回 502。

```sh
npm run typecheck
npm test
npm run build
```

测试使用本地模拟上游，验证三家 URL/鉴权/模型和 payload、路由/endpoint、预设、概率保留、错误、超时、取消、体积限制以及真实 OpenAI JavaScript SDK 的 Chat/Responses 非流式和 SSE 消费。测试不消耗模型额度，也不能替代账户权限和真实推理验证。Python 示例需要自行安装 `openai`，未纳入 JavaScript 测试。

## 官方协议来源

核对日期：2026-09-21。

- [TypeSafe API](https://docs.typesafe.ai/api)
- [Vercel TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
- [OpenRouter OpenAPI](https://openrouter.ai/openapi.json)：`/api/alpha/decisions` 与 `DecisionsRequest` / `DecisionsResponse`
- [OpenRouter Authentication](https://openrouter.ai/docs/api_reference/authentication)
- [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
