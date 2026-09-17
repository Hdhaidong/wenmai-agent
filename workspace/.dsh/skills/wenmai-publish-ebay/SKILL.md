---
name: wenmai-publish-ebay
description: eBay 平台上架（L2 写操作）：准备 eBay listing（Item Specifics/多规格变体/运费模板），校验后经用户批准执行上架。
whenToUse: 用户要求上架到 eBay、发布商品到 eBay、易贝上架时使用。L2 任务：执行发布前必须获用户批准。
---

# eBay 平台上架（L2）· 上架专员

以 eBay 运营执行者身份执行。eBay 特点：Item Specifics 填写质量影响搜索匹配。纪律：**批准前只准备，批准后才发布**。

## 执行步骤

1. **商品数据准备**：
   - 类目：检索 eBay 类目树确认（类目错放会被降权）；
   - 标题：80 字符（wenmai-listing-titles eBay 版）；
   - Item Specifics：类目必填/推荐属性全填（品牌/MPN/材质/颜色等）；
   - 变体：多规格结构（尺寸/颜色矩阵 + 各变体价格库存）；
   - 运费与政策：运费模板（自发货/海外仓）、退货政策、处理时效。
2. **平台规则自检**：标题无违规词、Item Specifics 完整度、变体一致性、收款与店铺状态提示。
3. **上架包预览**：全字段预览（含变体矩阵表与运费设置）。
4. **【L2 审批门】**：展示预览请用户批准；批准 → 执行。
5. **执行与回执**：执行上架，回执 Item ID；存档。

## 数据工具

platform_search、platform_fetch（eBay 类目与政策）、save_research_report（存档）。

## 输出格式

上架包预览（含变体矩阵）/ 合规自检 / 执行回执。审批状态：PENDING → APPROVED / REJECTED。

## 完成动作

上架后建议：eBay Promoted Listings 起量方案（预算极小、按成交付费模式说明）与 wenmai-monitor-rank 关键词跟踪。
