# V-4 真实对象存储摘要

结论：通过。

- `pnpm test:storage`：3 个测试文件、20 个测试全部通过。
- 测试连接真实 VersityGW，镜像固定为 `ghcr.io/versity/versitygw@sha256:7d56e0a6c246f00e2385ba4fe84065981959be1d822648f88a155c82e0e0652d`；没有使用 S3 client mock。
- 覆盖 create-only put、head/get、preverified download、原始字节 SHA-256、幂等重放和状态 CAS。
- 覆盖 DB/S3 双向 inventory、put 中断、响应丢失、孤儿对象、缺失对象、hash 篡改和 reconciler 收敛。
- Control Plane 只在 manifest/intent 状态满足条件时公开元数据或下载；缺失和篡改会 fail closed。
- 聚合结束后没有残留 `geneway-storage-*` 测试容器、卷或网络。

原始聚合日志：`/tmp/geneway-gate0.2a-final.log`。
