# 部署指引

仓库支持 Cloudflare Workers 和 Vercel Node.js Functions。选其中一个部署即可，调用方的 Base URL 都是 `https://你的部署域名/v1`。

**供应商 Key 由调用方通过请求体 `api_key` 或 `Authorization: Bearer` 发送，不需要写入仓库或部署环境。** `BRIDGE_API_KEY` 是可选的、独立的桥接器访问密码。

## Cloudflare Workers（推荐）

### 方式 A：从本机部署

```sh
git clone https://github.com/1475505/jev-api-adapter.git
cd jev-api-adapter
npm ci
npm run check
npx wrangler login
# 可选：限制只有持有桥接密码的调用方能访问
npx wrangler secret put BRIDGE_API_KEY
npm run deploy
```

私有仓库需先登录 GitHub。Wrangler 输出部署域名，例如 `https://jev-api-adapter.<subdomain>.workers.dev`。

### 方式 B：连接 GitHub 自动部署

1. 在 Cloudflare Dashboard 进入 **Workers & Pages**，创建 Worker，选择导入 Git 仓库（不是创建 Pages 静态站）。
2. 授权 Cloudflare 访问 `1475505/jev-api-adapter` 私有仓库，选择 `main` 分支，根目录为仓库根目录。
3. 安装命令使用 `npm ci`（若界面自动识别 npm，可保留自动安装）；Build command 填 `npm run typecheck`；Deploy command 填 `npx wrangler deploy`。
4. Worker 名称与 `wrangler.jsonc` 中的 `jev-api-adapter` 一致。部署后，按需在 Worker 的运行时 Variables and Secrets 添加 `BRIDGE_API_KEY`，类型为 Secret。
5. `ALLOWED_UPSTREAM_ORIGINS` 和 `CORS_ORIGINS` 由 `wrangler.jsonc` 的 vars 管理；修改后提交，避免下一次部署覆盖 Dashboard 上的普通变量。

官方说明：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)。免费额度不包含上游 Jev 的推理费用。

## Vercel

项目已提供 `api/` 函数入口和 `vercel.json`，与 Worker 共用 `src/` 的桥接逻辑。采用 Node.js Functions，不需要 Next.js。

1. 在 Vercel 点击 **Add New → Project**，导入 `1475505/jev-api-adapter`。GitHub App 必须获得这个私有仓库的访问权限。
2. Framework Preset 选 **Other**，Root Directory 为仓库根目录。
3. 项目的 `vercel.json` 已设置 Install Command=`npm ci`、Build Command=`npm run typecheck`、Output Directory=`public`。**不要将 Vercel 的构建命令设成 `npm run build`，那个脚本用于 Cloudflare 打包。**
4. Node.js 选择平台支持的 22.x 或更高版本。按需添加下面的运行时环境变量，并选择 Production（需要预览环境时也选择 Preview）。
5. 点击 Deploy。Base URL 为 `https://<project>.vercel.app/v1`。

| 环境变量 | 用途 |
| --- | --- |
| `BRIDGE_API_KEY` | 自己生成的桥接访问密码，调用方用 `X-Bridge-Key` 发送；不填则不要求桥接鉴权 |
| `ALLOWED_UPSTREAM_ORIGINS` | 自定义上游 origin 白名单，以逗号分隔；默认留空 |
| `CORS_ORIGINS` | 浏览器前端 origin 白名单，以逗号分隔；服务端调用无需设置 |

Vercel Deployment Protection 可能要求浏览器登录。外部 SDK 应使用允许程序访问的 Production 域名；如果保留平台访问保护，则需按 Vercel 文档配置机器访问。应用层的 `X-Bridge-Key` 和 Vercel 平台保护是两层独立机制。

也可以从仓库根目录使用 CLI：

```sh
npx vercel login
npx vercel
# 确认预览部署后发布到 Production
npx vercel --prod
```

函数 `maxDuration` 配置为 60 秒，建议上游超时保持默认 10 秒，或不超过 50 秒，为错误处理留出时间。

Vercel Hobby 适用于个人非商业项目；团队或商业使用应核对所需计划。[Functions 文档](https://vercel.com/docs/functions/runtimes/node-js)、[Hobby 说明](https://vercel.com/docs/plans/hobby)。

## 验证部署

先用不触发模型调用的健康检查：

```sh
curl -i https://YOUR_DEPLOYMENT/health
```

应返回 HTTP 200 和 `{"status":"ok","version":"0.1.0"}`。配置了桥接密码时，模型列表需要带密码：

```sh
curl https://YOUR_DEPLOYMENT/v1/models -H 'X-Bridge-Key: YOUR_BRIDGE_SECRET'
```

然后从本机运行仓库的真实调用示例：

```sh
export BRIDGE_BASE_URL='https://YOUR_DEPLOYMENT/v1'
export JEV_PROVIDER='vercel'
export JEV_MODEL='typesafe-ai/jev'
export JEV_API_KEY='YOUR_UPSTREAM_KEY'
# 如果部署了桥接密码，还需设置：
export BRIDGE_API_KEY='YOUR_BRIDGE_SECRET'
node --import tsx examples/openai.ts
```

这里的值均为占位符。若没有启用桥接密码，省略 `BRIDGE_API_KEY`。

## 当前实测状态与限制

- 本地单元测试及 OpenAI SDK 兼容性测试通过；Cloudflare dry-run 打包及本地 Workers 健康检查通过。
- Vercel 入口有本地请求/环境变量测试；首次云端部署仍需用 `/health` 验证平台构建和路由。
- 2026-09-21，从当前测试网络访问 Vercel AI Gateway 时，原生 HTTP 接口和官方 AI SDK 都返回了 `403 Vercel Security Checkpoint` HTML，尚未取得成功的真实 Jev 推理结果。
- **把桥接器部署到云端不保证能消除该上游拦截。** 若云端仍被拦截，需由 Vercel 根据请求 ID 排查，或改用自己有访问权限的其他供应商。

`.env*`（除占位示例）、`.dev.vars*`、`.vercel/` 和 `.wrangler/` 均已忽略。不要将供应商 Key 填到 README、配置文件、GitHub Issue 或提交内容中。

## 可选 GitHub Actions

CI 示例位于 `docs/ci.yml.example`。当前推送凭证没有 `workflow` 权限，因此没有自动启用 Actions。需要时在 GitHub 网页上新建 `.github/workflows/ci.yml` 并复制示例，或用具有 workflow 权限的凭证提交该文件。Cloudflare / Vercel 自身的 Git 集成部署不依赖这个工作流。
