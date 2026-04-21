# PDF Studio AI

一套可直接部署到 GitHub Pages 的纯前端 PDF 工具站。

## 已实现的核心能力

- PDF 页面管理：合并、重排、旋转、删除、插入、拆分
- PDF 优化：压缩、基础修复、裁剪、归档增强导出
- 格式转换：PDF→JPG、JPG/PNG→PDF、PDF→PPTX、PDF→DOCX、PDF→XLSX、DOCX/XLSX→PDF
- 编辑与标注：添加文本、矩形、图片/签名，页码、水印导出
- 安全工具：加密、解锁副本生成、关键字密文版导出、签名封面页
- OCR 与实用工具：OCR、扫描为 PDF、双 PDF 文本对比
- AI 增强：本地摘要、OpenAI 兼容接口翻译增强

## 技术说明

- 默认纯前端本地处理，不上传用户文件
- 采用 CDN 方式加载浏览器端依赖，适配 GitHub Pages 静态托管
- 无需构建步骤，直接推送仓库即可通过 GitHub Actions 发布

## 部署方式

1. 将本项目全部文件放入目标仓库根目录
2. 推送到 `main` 或 `master` 分支
3. 在仓库 `Settings > Pages` 中确认 Source 使用 GitHub Actions
4. 等待 `Deploy PDF Studio AI to GitHub Pages` 工作流完成

## 重要边界

以下功能在“纯静态 + GitHub Pages”模式下存在天然限制，当前版本提供的是增强或兼容实现：

- 真正的 PDF/A 认证导出
- 复杂损坏 PDF 的深度修复
- 高保真 PPT/PPTX → PDF
- 高保真 PDF 全文保版式翻译
- 真实第三方签署工作流发起
- 任意 URL 网页抓取转换（受 CORS 限制）

如需把这些能力全部做到生产级，需要补充服务端文档引擎或第三方 API。
