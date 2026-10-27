# qiushui-airadar

qiushui-airadar 的 TypeScript 工程。Web 界面以 `satnaing/shadcn-admin` v2.2.1（MIT）为基座。

开发、打包、安装和更新请看：[本地开发、发布、安装与更新](./本地开发、发布、安装与更新.md)。说明包含 2026-09-19 本机验收范围。

## 快速开始

需要 Node.js 24.21.0 或更高的 24.x、pnpm 10.34.1。

```bash
pnpm install --frozen-lockfile
pnpm dev # 启动并使用已安装的正式服务：http://127.0.0.1:43120/
```

日常使用与开发验收统一访问已安装的正式服务 `http://127.0.0.1:43120/`，数据位于 `~/.qiushui-airadar/production-data`。修改源码后需构建并更新安装包，页面才会使用新代码。

```bash
pnpm check         # 检查、测试、构建、独立安装升级验收
pnpm release:local # 生成 release/ 下的安装包和校验文件
pnpm release:remote # 将已提交并推送的版本发布到 GitHub Releases
```

安装包启动当前单表服务：`qiushui-airadar.sqlite` 保存内容目录、状态和分析字段；Markdown 保存正文和执行日志；YAML 保存配置。密钥保存在数据目录的 `.env`，不随程序发布。手动采集使用 `qiushui-airadar collect`，远程升级使用 `qiushui-airadar upgrade`，当前服务尚未启用定时采集。

## 工程目录

- `apps/cli`：安装后的命令入口与后台服务管理。
- `apps/service`：本机 HTTP 服务与采集入口。
- `apps/web`：Web 界面。
- `packages/domain`：领域契约。
- `packages/config`：配置和密钥读取。
- `packages/source-adapters`：平台与供应商适配。
- `packages/runtime`：内容数据库与 Markdown 存储。
- `packages/pipeline`：采集、分析、评分和翻译。

旧版多表运行时仍有兼容代码，正式安装入口已切换为当前单表版本；不要按旧版文档将两套数据混用。
