T25 本地对照。最终 R16/T24b 候选接纳并冻结后，协调者依次启动 A、B、C，各用独立进程和新证据目录。每臂在一次启动内重建两轮 Work、Thread、Source，仍使用同一身份、权限、历史资料、配置、模型和工具节拍。开环安排提交；同 Thread 只等前一 HTTP 受理以保版本，不等模型或业务完成。

当前目录只写私有实验。A 对已知普通订阅使用真实 Router，Router 决定经过原授权和处理者交付；A/B 每次只取一条合法语义候选，C 使用正式有界批处理。私有 Node loader 在内存精确替换两处锚点，拒绝源码漂移，实际替换与前后源码校验写原件。显式 Work Input、责任 Q 答、停止和撤权仍走原确定入口。

从仓库根目录运行。冻结 JSON 的格式为 `{"candidate":"已接纳候选的标识","node":"实际 Node 版本","sources":{"仓库相对路径":"SHA-256"}}`，三个臂必须消费同一份；`produce.mjs` 列出最小必含文件。证据目录由本脚本排他创建，建议放在仓库外。

```sh
node experiments/t25-routing-comparison/produce.mjs A /absolute/final-context.json /absolute/new-evidence/a
node experiments/t25-routing-comparison/produce.mjs B /absolute/final-context.json /absolute/new-evidence/b
node experiments/t25-routing-comparison/produce.mjs C /absolute/final-context.json /absolute/new-evidence/c
node experiments/t25-routing-comparison/summarize.mjs /absolute/new-evidence/a /absolute/new-evidence/b /absolute/new-evidence/c
```

汇总离线读取 HTTP、HostSim Session、正式 Worker 网关与 Router 上游请求、云侧账本和 owner 投影；失败不会剔除原事件分母。模拟模型根据请求内容和实际 tool 结果应答，独立 oracle 只在汇总阶段读取。缓存拆分与缺失用量保留 unknown，费用是内部模拟计价。此实验不生成 XLSX；真实 XLSX 质量另用既有正式入口及独立核验器。
