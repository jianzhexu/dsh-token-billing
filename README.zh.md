# dsh-token-billing

[English](README.md) | 中文

DeepSeek Harness 的 token 计费插件：按 DeepSeek 官方定价对每次模型调用记账，在 Web UI 输入框下方的环境读数带显示计费读数行。

## 功能

- 当前会话与所属工作区的费用汇总：读数行以工作区名标注工作区费用，切换工作区即切换；hover 明细另含全部会话全局汇总
- 高峰/空闲时段分别计价（北京时间 9:00-12:00、14:00-18:00 为高峰，其余为空闲，空闲价格为高峰的一半）
- 账本持久化在 storage-domain 领域 `token_billing`，进程重启后保留
- 读数行悬停显示完整明细：当前会话与全局费用、token 用量、分模型统计、工作区列表、单价表

## 安装

要求使用 web 组合的 profile（如 `dsh --profile web`；插件依赖 `webServer`、`storageDomain` 服务与浏览器插件表，均由 `dsh-web-app` 组合包提供）：

```sh
dsh plugin --profile <name> add github:jianzhexu/dsh-token-billing
```

安装即激活：插件行随包自带的组合层挂载，无需手动编辑配置。本插件为纯 JavaScript、无构建步骤，git 安装不需要 pnpm 构建授权（`allowBuilds`）。

## 卸载与覆盖

```sh
dsh plugin --profile <name> remove dsh-token-billing
```

覆盖配置或禁用：在 profile 自己的 `cordis.patch.yml` 中按行 id `token-billing` 操作。

## 定价来源

<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（价格表内置于插件，随版本更新；不在定价页上的模型不计价）

## License

MIT
