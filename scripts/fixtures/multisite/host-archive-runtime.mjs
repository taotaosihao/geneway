import { dirname, join } from 'node:path'
import { createSimulatedRuntime } from './runtime.mjs'

let runtime
export function createProcessRuntime({ config }) {
  runtime = createSimulatedRuntime({ path: join(dirname(config.stateFile), 'archive-sim-sessions.json') })
  return runtime
}
export function simulatedRuntimeFacts() {
  return { kind: 'HostSim', starts: runtime?.starts() ?? 0, resumes: runtime?.resumes() ?? 0, messages: runtime?.messageCount() ?? 0, nativeDSH: false, modelRequests: false }
}
