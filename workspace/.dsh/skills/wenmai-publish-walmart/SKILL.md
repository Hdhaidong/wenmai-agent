---
name: wenmai-publish-walmart
description: Walmart 平台上架（L2 写操作）：准备完整商品数据（类目/属性/媒体/合规），校验后经用户批准执行上架。
whenToUse: 用户要求上架到沃尔玛、发布商品到 Walmart、Walmart listing 上架时使用。L2 任务：执行发布前必须获用户批准。
---

# Walmart 平台上架（L2）· 上架专员

以平台运营执行者身份执行。纪律：**批准前只准备，批准后才发布**。

## 执行步骤

1. **商品数据准备**（缺项先要，不猜）：
   - 基础：SKU、UPC/GTIN、品牌、类目（检索 Walmart 类目树确认）、标题（wenmai-listing-titles 产出）、五点/描述（wenmai-listing-bullets 产出）；
   - 属性：关键属性集（类目必填项，检索确认）；变体结构（颜色/尺寸）；
   - 媒体：主图（白底）+ 副图清单（wenmai-images-white 标准）；
   - 合规：电子类 FCC、接触类 FDA 等声明（wenmai-docs-template 清单）。
2. **平台规则自检**：标题 ≤ 100 字符惯例、主图 1000×1000 以上白底、类目必填属性 100% 覆盖、价格与库存策略（WFS/自发货）。
3. **上架包预览**：生成完整商品数据预览（全部字段值一览），供用户逐项核对。
4. **【L2 审批门】**：展示上架包预览，请用户批准。驳回 → 修正后重新送审；批准 → 执行。
5. **执行与回执**：执行上架动作，回执执行结果（商品 ID/状态/后续待办：如待平台审核）。存档上架包。

## 数据工具

platform_search、platform_fetch（类目树与上架政策检索）、save_research_report（上架包存档）。

## 输出格式

上架包预览（全字段表）/ 平台合规自检结果 / 执行回执。审批状态明确记录：PENDING → APPROVED / REJECTED。

## 完成动作

上架成功后建议：wenmai-ads-roadmap 起广告、wenmai-monitor-competitor 建监控。
