# dsh-token-billing

English | [中文](README.zh.md)

A token billing plugin for DeepSeek Harness: records every model call at DeepSeek's official pricing and shows a billing readout row in the ambient stats band under the Web UI input box.

## Features

- Session and owning-workspace cost totals: the row names the workspace inline and follows workspace switches; hover adds the all-sessions global totals
- Separate peak / off-peak pricing (Beijing time 9:00-12:00 and 14:00-18:00 are peak; off-peak is half the peak price)
- The ledger persists in the `token_billing` storage-domain domain and survives restarts
- Hover the readout row for the full breakdown: session and global cost, token usage, per-model stats, workspace list, price table

## Install

Requires a profile composing the web app (e.g. `dsh --profile web`; the plugin injects the `webServer` and `storageDomain` services and registers in the browser plugin table, all provided by the `dsh-web-app` bundle):

```sh
dsh plugin --profile <name> add github:jianzhexu/dsh-token-billing
```

Installing activates it: the plugin row mounts through the bundle's own patch layer — no manual config editing. The plugin is plain JavaScript with no build step, so git installs need no pnpm build authorization (`allowBuilds`).

## Uninstall & override

```sh
dsh plugin --profile <name> remove dsh-token-billing
```

To override config or disable the row, target row id `token-billing` in your profile's own `cordis.patch.yml`.

## Pricing source

<https://api-docs.deepseek.com/zh-cn/quick_start/pricing> (prices are built into the plugin and updated per release; models not listed on the pricing page are not billed)

## License

MIT
