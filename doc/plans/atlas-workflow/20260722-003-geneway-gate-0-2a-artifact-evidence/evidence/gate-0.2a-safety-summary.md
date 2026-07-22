# V-5 安全摘要

结论：通过。

- `pnpm test:security`：2 个测试文件、21 个测试全部通过。
- 固定 multipart corpus 覆盖大小、字段、文件数、UTF-8、BOM/NUL、MIME/扩展名冲突和危险文件名。
- 所有 UI/header 输出按纯文本处理；Markdown HTML、脚本、危险 URL 和远程资源不执行。
- 使用真实 HTTP 边界验证双 principal、双 tenant、resource scope、data class、audience、expiry、retention 和下载重授权。
- 越权、对象缺失、hash 异常和 profile 未注册均 fail closed，拒绝路径不把 integrity 状态污染为 ready。
- Worker 环境扫描拒绝 PostgreSQL、S3、备份、恢复、会话和浏览器 secret；Worker 仅能访问短 UDS 与 0600 token。
- 匿名、伪造或过期 Worker command 被拒绝；测试 hook 仅在 `NODE_ENV=test`、数值 loopback 和精确 0600 token 下开放。

原始聚合日志：`/tmp/geneway-gate0.2a-final.log`。
