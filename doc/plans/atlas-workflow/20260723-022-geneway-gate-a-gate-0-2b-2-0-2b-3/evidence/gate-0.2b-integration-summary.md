# Gate 0.2B 集成汇总

完整聚合严格串行执行：V2 → V3 integration → V4 security → V5 Gate 0.2B.2 → V6 Gate 0.2B.3 → V7 三组基线。

| 阶段 | containers | networks | loopback proxies | backup runs | backup boundary receipts |
| --- | ---: | ---: | ---: | ---: | ---: |
| V5 Gate 0.2B.2 | 30 | 8 | 16 | 0 | 0 |
| V6 Gate 0.2B.3 | 237 | 38 | 76 | 3 | 104 |
| V7 Gate 0.2A baseline | 169 | 20 | 40 | 3 | 104 |
| V7 Gate 0.2B.1 baseline | 22 | 6 | 12 | 0 | 0 |
| V7 local A0 | 8 | 2 | 4 | 0 | 0 |

13 份 raw Docker ledger 均为 `0600`，实文件 bytes/SHA-256、JSON、start/end sentinel、无精度损失 `timeNano`、bounded recordCount 和 catch-up audit 均由 fresh verifier 独立复算通过。

193/193 teardown receipts 能回指 raw daemon ledger，顺序精确为 `network disconnect < container die < container destroy`。208/208 backup container boundary receipts 与完整 container/network identity 对齐，其中 80 个 host、46 个 none、82 个 internal data-network；80/80 host-mode egress boundary 通过。
