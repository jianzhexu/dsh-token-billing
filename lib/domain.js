/**
 * dsh-token-billing — 持久化领域声明（纯模块，可独立测试）。
 *
 * 账本持久化在 storage-domain 的 `token_billing` 领域中：
 * - 每次模型调用 = `calls` 表里一条记录，键为 `<sessionId>#<seq>`（seq 为会话内单调序号）；
 * - 启动时从表重建内存账本（聚合），之后每次调用先落盘、再更新内存；
 * - 记录 schema 用 zod 声明，storage-domain 在重新打开领域时对每条存量记录做校验。
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 一条已持久化的调用记录。 */
export const callRecordSchema = z.object({
  /** 归属会话 id。 */
  sessionId: z.string().min(1),
  /** 会话内单调序号（用于键与重建）。 */
  seq: z.number().int().nonnegative(),
  /** 调用时刻（epoch 毫秒）。 */
  at: z.number().int().nonnegative(),
  /** 模型名原文。 */
  model: z.string(),
  /** 计费时段。 */
  period: z.union([z.literal('peak'), z.literal('off-peak')]),
  /** 是否在定价表内（false = 未计价模型）。 */
  known: z.boolean(),
  /** 本次调用费用（元，4 位小数）。 */
  cost: z.number(),
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** 记账时解析的工作区归属（键/标题/路径/实体 id）。 */
  workspace: z.object({
    key: z.string(),
    title: z.string(),
    path: z.string().nullable(),
    id: z.string().nullable(),
  }),
})

/** 记录键：会话内单调序号保证唯一。 */
export const recordKey = (sessionId, seq) => `${sessionId}#${seq}`

/** 领域 spec：名称/表名均符合 UNIT_NAME_RE（小写字母开头，仅小写/数字/下划线）。 */
export const billingDomainSpec = defineDomain({
  name: 'token_billing',
  version: 0,
  tables: {
    calls: domainTable(callRecordSchema),
  },
})
