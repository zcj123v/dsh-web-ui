/**
 * Official session event projection — pure. Maps the durable DSH session
 * vocabulary onto the pet's visual phases and carries an optional completed-
 * turn reward for the ledger. Holds no state of its own; callers keep a
 * {@link ProjectionRuntime} per session and feed events in arrival order.
 * @module @neystan/dsh-pet/event-projection
 */

import { assistantStreamHasVisibleText } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PetStateInput } from './state.ts'

/** Runtime shape of the optional legacy activity event. */
export interface ActivityStatusEventLike {
  phase?: string
  line?: string
  phrase?: string
}

/** Per-session facts needed to project the official event stream. */
export interface ProjectionRuntime {
  activeTools: Set<string>
  officialEventsSeen: boolean
  stepHadFailure: boolean
}

/** One official event projection, optionally carrying a completed turn reward. */
export interface PetActivityTransition {
  input: PetStateInput
  completedTurn?: number
}

/** Fresh projection runtime for a newly seen session. */
export function emptyProjectionRuntime(): ProjectionRuntime {
  return { activeTools: new Set(), officialEventsSeen: false, stepHadFailure: false }
}

/** Keep tool names readable inside the compact status bubble. */
function displayToolName(name: string): string {
  const compact = name.replace(/\s+/g, ' ').trim() || '工具'
  return compact.length <= 24 ? compact : `${compact.slice(0, 21)}...`
}

/** Whether a legacy phase is part of the pet's supported vocabulary. */
export function isActivityPhase(phase: string): phase is PetStateInput['phase'] {
  return ['idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed'].includes(phase)
}

/**
 * Whether one settled attempt stream carries reasoning text. 0.1.5 removed the
 * live `assistant/chunk` event, so a reasoning run is only observable after
 * settlement, through the compact stream the attempt embeds.
 */
function streamHasReasoningText(stream: readonly AssistantStreamRecord[]): boolean {
  return stream.some(record => record.type === 'reasoning-chunks'
    && record.texts.some(text => text.trim() !== ''))
}

/**
 * Project the durable DSH session vocabulary into the pet's visual phases.
 * Unknown and log-only events do not disturb the last meaningful activity.
 *
 * 0.1.5 dropped `assistant/chunk`: deltas no longer reach the session log as
 * live events, so the streamed phases are read off the compact stream a
 * settled attempt or message embeds instead. An attempt that committed no
 * surface message keeps both streamed phases (reasoning-only streams are the
 * `thinking` run, text-bearing ones the `review` run, and an empty stream
 * projects nothing); a committed message keeps its unconditional `review`.
 * The trade-off is granularity: a successful step's reasoning prefix no
 * longer flashes `thinking` before the answer, because the whole stream now
 * arrives in one event.
 */
export function projectOfficialEvent(
  event: SessionEvent,
  runtime: ProjectionRuntime,
): PetActivityTransition | undefined {
  switch (event.type) {
    case 'turn/start':
      runtime.activeTools.clear()
      runtime.stepHadFailure = false
      return { input: { phase: 'waiting', line: '准备开始' } }
    case 'step/start':
      runtime.activeTools.clear()
      runtime.stepHadFailure = false
      return { input: { phase: 'waiting', line: '等待模型响应' } }
    case 'assistant/attempt':
      if (assistantStreamHasVisibleText(event.data.stream)) {
        return { input: { phase: 'review', line: '整理回复中' } }
      }
      if (streamHasReasoningText(event.data.stream)) {
        return { input: { phase: 'thinking', line: '正在思考' } }
      }
      return undefined
    case 'assistant/message':
      return { input: { phase: 'review', line: '整理回复中' } }
    case 'tool/call':
      runtime.activeTools.add(String(event.data.callId))
      return {
        input: {
          phase: 'tool',
          line: `正在使用 ${displayToolName(event.data.name)}`,
        },
      }
    case 'tool/result': {
      const block = event.data.message.content[0]
      runtime.activeTools.delete(String(event.data.message.source.callId))
      runtime.stepHadFailure ||= event.data.error !== undefined || block.isError === true
      if (runtime.activeTools.size > 0) {
        return {
          input: {
            phase: 'tool',
            line: `还有 ${runtime.activeTools.size} 个工具运行中`,
          },
        }
      }
      return runtime.stepHadFailure
        ? { input: { phase: 'failed', line: '工具执行失败' } }
        : { input: { phase: 'thinking', line: '处理工具结果' } }
    }
    case 'turn/end': {
      runtime.activeTools.clear()
      switch (event.data.reason.kind) {
        case 'completed':
          return {
            input: { phase: 'done', line: '完成啦' },
            completedTurn: event.data.turn,
          }
        case 'error':
          return { input: { phase: 'failed', line: '执行失败' } }
        case 'max-tokens':
          return { input: { phase: 'failed', line: '达到输出上限' } }
        case 'interrupted':
          return { input: { phase: 'failed', line: '执行意外中断' } }
        case 'blocked':
          return { input: { phase: 'waiting', line: '等待继续' } }
        case 'aborted':
          return { input: { phase: 'idle', line: '已停止' } }
        default:
          // TurnEndReasonMap is merge-extensible; a newer ending must not
          // leave the pet showing stale in-progress work.
          return { input: { phase: 'idle' } }
      }
    }
    default:
      return undefined
  }
}
