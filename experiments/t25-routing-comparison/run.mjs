import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { arms, scenario } from './fixture.mjs'

const segmentOffsets = [0, 5750, 8750]

// 由最终候选的私有启动接缝传入同一个业务入口；本模块本身不启动服务。
// openArm 必须在独立进程和新 root 中运行，record 接收只追加的原件索引。
export async function runArm(arm, { openArm, record }) {
  assert(arms.includes(arm))
  const live = await openArm({ arm })
  try {
    for (let round = 1; round <= scenario.rounds; round++) {
      try {
        const ready = await live.prepareRound(round)
        await record({ type: 'ready', arm, round, ...ready })
        const epoch = performance.now()
        const wallEpoch = new Date().toISOString()
        await record({ type: 'epoch', arm, round, wallEpoch })
        const pendingByThread = new Map()
        const results = await Promise.all(scenario.segments.flatMap((segment, index) => segment.events.map(async event => {
          const scheduledMs = segmentOffsets[index] + event.at
          await setTimeout(Math.max(0, scheduledMs - (performance.now() - epoch)))
          const lane = event.thread ?? 'control'
          const prior = pendingByThread.get(lane)
          const submit = (async () => {
            await prior
            const submittedMs = performance.now() - epoch
            try {
              const receipt = await live.submit(round, event)
              return { receipt, submittedMs, receivedMs: performance.now() - epoch }
            } catch (error) {
              return { error: { message: error.message, code: error.code ?? null }, submittedMs }
            }
          })()
          pendingByThread.set(lane, submit)
          const result = { type: 'event', arm, round, eventId: event.id, segment: segment.name, scheduledMs, ...await submit }
          await record(result)
          return result
        })))
        const raw = await live.finishRound(round, results)
        await record({ type: 'terminal', arm, round, ...raw })
      } catch (error) {
        await record({ type: 'round-failure', arm, round, message: error.message, code: error.code ?? null })
        try { await live.abortRound(round) } catch (cleanupError) {
          await record({ type: 'round-failure', arm, round, message: cleanupError.message, code: cleanupError.code ?? null })
          break
        }
      }
    }
  } finally {
    await live.close()
  }
}
