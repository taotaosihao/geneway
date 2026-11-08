// 固定输入只描述请求。预期归属、回答和失败判定由离线 oracle 持有。
export const arms = ['A', 'B', 'C']
export const scenario = {
  rounds: 2,
  workNames: ['history', 'maintenance'],
  routerDelayMs: 100,
  workerDelayMs: 120,
  firstBurstRouterHoldMs: 1400,
  firstTailWorkerHoldMs: 1400,
  toolDelayMs: 60,
  segments: [
    { name: 'steady', events: [
      { id: 'known-tail', at: 0, thread: 'known', replyTo: 'subscription-seed', text: '继续核对事件历史。请读取全部获准资料直到最后一页，答复最后一条记录的现场交接码。' },
      { id: 'known-status', at: 4600, thread: 'known', replyTo: 'subscription-seed', text: '继续核对事件历史。请确认资料核对范围，并答复。' },
      { id: 'topic-switch', at: 5300, thread: 'known', work: 'maintenance', text: '改做明确指定的维护台账工作：核对保养安排，不沿用事件历史结论。' },
    ] },
    { name: 'burst', events: [
      { id: 'first-unknown', at: 0, thread: 'unbound', text: '请核对之前提到的表；未指定哪份表。' },
      { id: 'ambiguous-date', at: 450, thread: 'unbound', text: '把那份表改成下周的安排，先确认是哪份表。' },
      { id: 'ambiguous-item', at: 550, thread: 'unbound', text: '继续上次那项，任务名称尚未提供。' },
      { id: 'ambiguous-site', at: 650, thread: 'unbound', text: '处理另一处现场的事项，现场和目标尚未确定。' },
      { id: 'unrelated', at: 750, thread: 'separate', text: '这是随手记下的天气，无需处理或答复。' },
    ] },
    { name: 'dense', events: [
      { id: 'known-dense-1', at: 0, thread: 'known', replyTo: 'subscription-seed', text: '继续核对事件历史，请确认范围。' },
      { id: 'known-dense-2', at: 100, thread: 'maintenance', replyTo: 'maintenance-seed', text: '继续核对维护台账，请确认需要核对保养安排。' },
      { id: 'known-dense-replay', at: 250, thread: 'maintenance', replay: 'known-dense-2' },
      { id: 'answer', at: 1500, thread: 'questions', answerTo: 'question-seed', text: '核对周二上午的维护台账。' },
      { id: 'revision', at: 2500, thread: 'known', work: 'maintenance', text: '正式修订维护台账要求：仅核对周二上午；此前要求已替换。' },
      { id: 'stop', at: 3250, operation: 'stop', work: 'maintenance' },
      { id: 'after-stop', at: 4250, thread: 'known', work: 'maintenance', text: '对已停止的维护台账补记范围，保留历史。' },
    ] },
  ],
}
// 同线程只串行提交接收事务以保 revision；模型和 Worker 完成不控制发信节拍。
export const events = scenario.segments.flatMap(segment => segment.events.map(event => ({ ...event, segment: segment.name })))
