import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { pluginManifestV1Schema, type Agent, type Issue, type IssueLabel } from '@paperclipai/shared'
import { createTestHarness, type TestHarness } from '@paperclipai/plugin-sdk/testing'
import manifest from '../src/manifest.js'
import plugin, { type IssueRouting } from '../src/worker.js'

const companyId = randomUUID()
const agentId = randomUUID()
const otherAgentId = randomUUID()

function issue(input: Partial<Issue> & Pick<Issue, 'id' | 'title'>): Issue {
  const now = new Date()
  return {
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    visibility: 'open',
    privacyRootIssueId: null,
    description: null,
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: agentId,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: 'manual',
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  } as Issue
}

function agent(id: string, adapterType: string, adapterConfig: Record<string, unknown>): Agent {
  return { id, companyId, name: `agent-${id.slice(0, 4)}`, adapterType, adapterConfig, runtimeConfig: {} } as unknown as Agent
}

const DEEP_TASK = {
  title: 'Investigate production outage',
  description: 'Find the root cause of the deadlock in the payment worker.',
}

let harness: TestHarness

async function setup(config: Record<string, unknown>, issues: Issue[], agents?: Agent[]) {
  harness = createTestHarness({
    manifest,
    config,
    // Only the assertions read comments; the plugin itself does not need to.
    capabilities: [...manifest.capabilities, 'issue.comments.read'],
  })
  harness.seed({
    issues,
    agents: agents ?? [agent(agentId, 'claude_local', { model: 'sonnet', effort: 'medium' })],
  })
  await plugin.definition.setup(harness.ctx)
}

const routed = { agents: [{ agentId }] }
const overridesOf = async (id: string) => (await harness.ctx.issues.get(id, companyId))?.assigneeAdapterOverrides
const stateOf = (id: string) =>
  harness.getState({ scopeKind: 'issue', scopeId: id, stateKey: 'routing' }) as IssueRouting | undefined
const emitIssue = (type: 'issue.created' | 'issue.updated', id: string) =>
  harness.emit(type, {}, { companyId, entityId: id, entityType: 'issue' })

describe('worker', () => {
  let id: string
  beforeEach(() => {
    id = randomUUID()
  })

  test('the manifest is valid', () => {
    expect(pluginManifestV1Schema.parse(manifest).id).toBe('btl00.model-router')
  })

  test('a hard task on a routed agent gets the deep model as an issue override, with a comment', async () => {
    await setup(routed, [issue({ id, ...DEEP_TASK })])
    await emitIssue('issue.created', id)

    expect(await overridesOf(id)).toEqual({ adapterConfig: { model: 'opus', effort: 'high' } })
    const comments = await harness.ctx.issues.listComments(id, companyId)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('`model` opus')
    expect(stateOf(id)?.written).toEqual({ model: 'opus', effort: 'high' })
  })

  test('codex agents get their own effort key', async () => {
    await setup(
      { ...routed, ladders: { codex_local: { fast: 'gpt-mini', balanced: 'gpt', deep: 'gpt-max' } } },
      [issue({ id, ...DEEP_TASK })],
      [agent(agentId, 'codex_local', { model: 'gpt', modelReasoningEffort: 'medium' })],
    )
    await emitIssue('issue.created', id)
    expect(await overridesOf(id)).toEqual({ adapterConfig: { model: 'gpt-max', modelReasoningEffort: 'high' } })
  })

  test('agents not listed, and excluded agents, are never touched', async () => {
    await setup({}, [issue({ id, ...DEEP_TASK })])
    await emitIssue('issue.created', id)
    expect(await overridesOf(id)).toBeNull()

    const id2 = randomUUID()
    await setup({ ...routed, excludedAgentIds: [agentId] }, [issue({ id: id2, ...DEEP_TASK })])
    await emitIssue('issue.created', id2)
    expect(await overridesOf(id2)).toBeNull()
  })

  test('our own update does not trigger a second decision or comment', async () => {
    await setup(routed, [issue({ id, ...DEEP_TASK })])
    await emitIssue('issue.created', id)
    await emitIssue('issue.updated', id)
    expect(await harness.ctx.issues.listComments(id, companyId)).toHaveLength(1)
  })

  test('a model a person set on the issue is kept; only effort is routed', async () => {
    await setup(routed, [
      issue({ id, ...DEEP_TASK, assigneeAdapterOverrides: { adapterConfig: { model: 'haiku', other: 1 }, useProjectWorkspace: true } }),
    ])
    await emitIssue('issue.created', id)
    expect(await overridesOf(id)).toEqual({
      adapterConfig: { model: 'haiku', other: 1, effort: 'high' },
      useProjectWorkspace: true,
    })
  })

  test('reassigning to an agent that is not routed removes our keys', async () => {
    await setup(routed, [issue({ id, ...DEEP_TASK })], [
      agent(agentId, 'claude_local', { model: 'sonnet' }),
      agent(otherAgentId, 'codex_local', { model: 'gpt' }),
    ])
    await emitIssue('issue.created', id)
    await harness.ctx.issues.update(id, { assigneeAgentId: otherAgentId }, companyId)
    await emitIssue('issue.updated', id)
    expect(await overridesOf(id)).toEqual({ adapterConfig: {} })
  })

  test('without a key the heuristic never routes down', async () => {
    await setup(routed, [issue({ id, title: 'Fix typo in README' })])
    await emitIssue('issue.created', id)
    expect(await overridesOf(id)).toBeNull()
    expect(stateOf(id)?.written).toEqual({})
  })

  describe('adopt mode', () => {
    const label = (name: string) =>
      ({ id: randomUUID(), companyId, name, color: '#000000', createdAt: new Date(), updatedAt: new Date() }) as IssueLabel
    const adoptLabel = label('auto-route')
    const other = label('video')

    test('an adopted backlog issue is routed first, then released to todo and woken', async () => {
      await setup(routed, [issue({ id, ...DEEP_TASK, status: 'backlog', labels: [adoptLabel, other] })])
      const order: string[] = []
      const update = harness.ctx.issues.update.bind(harness.ctx.issues)
      vi.spyOn(harness.ctx.issues, 'update').mockImplementation(async (issueId, patch, cid) => {
        order.push('status' in patch ? `status:${patch.status}` : 'override')
        return update(issueId, patch, cid)
      })
      const wake = vi.spyOn(harness.ctx.issues, 'requestWakeup').mockImplementation(async () => {
        order.push('wake')
        return { queued: true, runId: 'r1' } as Awaited<ReturnType<typeof harness.ctx.issues.requestWakeup>>
      })

      await emitIssue('issue.created', id)

      expect(order).toEqual(['override', 'status:todo', 'wake'])
      const after = await harness.ctx.issues.get(id, companyId)
      expect(after?.status).toBe('todo')
      expect((after as Issue & { labelIds?: string[] }).labelIds).toEqual([other.id])
      expect(after?.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: 'opus', effort: 'high' } })
      expect(wake).toHaveBeenCalledTimes(1)
    })

    test('an adopted issue is released even when its agent is not routed', async () => {
      await setup({}, [issue({ id, ...DEEP_TASK, status: 'backlog', labels: [adoptLabel] })])
      const wake = vi.spyOn(harness.ctx.issues, 'requestWakeup')
      await emitIssue('issue.created', id)
      expect((await harness.ctx.issues.get(id, companyId))?.status).toBe('todo')
      expect(await overridesOf(id)).toBeNull()
      expect(wake).toHaveBeenCalledTimes(1)
    })

    test('a refused wake still leaves the issue released', async () => {
      await setup(routed, [issue({ id, ...DEEP_TASK, status: 'backlog', labels: [adoptLabel] })])
      vi.spyOn(harness.ctx.issues, 'requestWakeup').mockRejectedValue(new Error('budget hard stop'))
      await emitIssue('issue.created', id)
      expect((await harness.ctx.issues.get(id, companyId))?.status).toBe('todo')
      expect(harness.logs.some((l) => l.message.includes('could not wake'))).toBe(true)
    })

    test('a backlog issue without the label is planning, not a request: it is not released', async () => {
      await setup(routed, [issue({ id, ...DEEP_TASK, status: 'backlog', labels: [other] })])
      const wake = vi.spyOn(harness.ctx.issues, 'requestWakeup')
      await emitIssue('issue.created', id)
      expect((await harness.ctx.issues.get(id, companyId))?.status).toBe('backlog')
      expect(wake).not.toHaveBeenCalled()
    })
  })

  test('closed issues are ignored', async () => {
    await setup(routed, [issue({ id, ...DEEP_TASK, status: 'done' })])
    await emitIssue('issue.created', id)
    expect(stateOf(id)).toBeUndefined()
  })

  test('a run that starts after the decision counts as routed before the run', async () => {
    await setup(routed, [issue({ id, ...DEEP_TASK })])
    await emitIssue('issue.created', id)
    await harness.emit('agent.run.started', { issueId: id, runId: 'r1', agentId }, {
      companyId,
      occurredAt: new Date(Date.now() + 1000).toISOString(),
    })
    expect(stateOf(id)?.race).toBe('before-run')
    expect(harness.getState({ scopeKind: 'instance', stateKey: 'race-stats' })).toEqual({ beforeRun: 1, afterRun: 0 })
  })

  test('a run that started before the decision counts as routed after the run', async () => {
    await setup(routed, [issue({ id, ...DEEP_TASK })])
    await harness.emit('agent.run.started', { issueId: id, runId: 'r1', agentId }, {
      companyId,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    })
    await emitIssue('issue.created', id)
    expect(stateOf(id)?.race).toBe('after-run')
    expect(harness.getState({ scopeKind: 'instance', stateKey: 'race-stats' })).toEqual({ beforeRun: 0, afterRun: 1 })
  })
})
