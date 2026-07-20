# Gate 0.1 Served UI 摘要

命令：`pnpm test:e2e -- --project=gate0.1`，退出码 0，4/4 Playwright 测试通过。

真实用户流覆盖：

1. `page.goto` 访问自动分配空闲端口的真实 Vite 页面，Control Plane 也使用独立空闲端口；
2. 选择“方案专家团”，通过 assistant-ui Composer 给小纬发消息；
3. Control Plane 创建 Conversation、BusinessTask、Approval 和 WorkflowVersion；
4. Base UI Dialog 中展示七节点只读 React Flow；
5. 用户批准后，执行接口先返回 `accepted`，服务端 fake Runtime 经普通 Interpreter 异步执行，页面观察到 1–6/7 的真实中间进度；
6. 页面显示 7/7 步、正向 Claim、内联 Evidence 和 rejected 无证据候选；
7. `assistant-ui` 通过 external store 使用 Control Plane Conversation；API 与 DOM 的消息作者、顺序和正文完全一致；
8. 刷新后从 Control Plane snapshot 与 cursor 增量事件恢复同一专家团、task 和结果。

浏览器可见消息作者集合严格为 `{user, xiaowei}`。现场动态只显示“设备异常待处理”和“产能进度落后”的禁用后续入口，没有实现异常中心或伪造实时数据。

附加 smoke 覆盖用户直接指定 auto、单专家，以及未知 capability 的 UI/API `NOT_OPEN`；1440×900 下三列布局、Dialog 尺寸、七节点不重叠、CSS 200 也有断言。

成功路径测试没有 `page/context.route`、`fulfill`、`setContent`、Service Worker 或 fetch/XHR 响应替代。真实性扫描遍历 config、spec/helper/fixture/global setup 及本地 import 闭包。原始 Playwright 报告：`/tmp/geneway-runs/gate-0.1-1784576455020-2373368/playwright-report.json`。
