# Gate 0.2B.3 恢复汇总

V6 `gate0.2b.3` PASS，source-bound 日志：

`/tmp/geneway-runs/gate0.2b-1785038729533-2773014/gate-0.2b/V6-gate0.2b.3.log`

聚合子证据覆盖 negative、recovery、visual desktop、visual narrow、Gate 0.2B.1 回归以及三类 backup/restore：success、missing-object、manifest-mismatch。

运行时证据：237 containers、38 internal networks、76 loopback proxies、3 backup runs、104 backup boundary receipts。每个 backup container 均有 exact boundary receipt；host/none/data-network matrix 与 egress guard 通过。

193 个 teardown receipts 中涉及本阶段和基线的完整 container/network ID、name、project、service、timeNano/action 均能回指 raw Docker ledger；没有 reconnect、post-destroy reuse、残留 container/network/volume/UDS。

recovery 与 negative 结果保持 fail-closed：错误 manifest 或缺失对象不会被解释为成功恢复，也不会产生可用于真实业务决策的结论。
