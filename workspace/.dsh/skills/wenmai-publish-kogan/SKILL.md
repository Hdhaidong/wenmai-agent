---
name: wenmai-publish-kogan
description: Kogan 平台上架（L2 写操作）：准备 Kogan 商品数据（类目/英文文案/澳洲合规），校验后经用户批准执行上架。
whenToUse: 用户要求上架到 Kogan、澳洲 Kogan 上架时使用。L2 任务：执行发布前必须获用户批准。
---

# Kogan 平台上架（L2）· 上架专员

以澳洲市场执行者身份执行。Kogan 特点：澳洲站点，RCM 认证与消费者法规（ACL）需注意。纪律：**批准前只准备，批准后才发布**。

## 执行步骤

1. **商品数据准备**：
   - 类目：检索 Kogan 类目确认；
   - 英文标题与描述（澳洲英语习惯，wenmai-listing-titles 英文版）；
   - 变体与库存策略（Kogan 支持第三方卖家自发货与 Kogan 仓）；
   - 澳洲合规：电子类 RCM 标志、ACMA 要求初判；消费者保障（ACL 下的退货政策）说明。
2. **平台规则自检**：英文文案质量、RCM/合规提示、定价（AUD + GST 10% 逻辑）、运费覆盖地区。
3. **上架包预览**：全字段预览 + AUD 定价测算（含 GST）。
4. **【L2 审批门】**：展示预览请用户批准；批准 → 执行。
5. **执行与回执**：执行上架，回执商品 ID；存档。

## 数据工具

platform_search、platform_fetch（Kogan 类目/政策/澳洲合规检索）、save_research_report（存档）。

## 输出格式

上架包预览 / AUD 定价与 GST 测算 / 合规自检（RCM/ACL）/ 执行回执。审批状态：PENDING → APPROVED / REJECTED。

## 完成动作

上架后建议：wenmai-research-multip 的澳洲站机会对比与 wenmai-monitor-competitor 监控。
