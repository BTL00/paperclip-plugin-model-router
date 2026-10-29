import { createHash } from 'node:crypto'
import { definePlugin, runWorker, type PluginContext, type PluginEvent } from '@paperclipai/plugin-sdk'
import type { Issue, IssueAssigneeAdapterOverrides } from '@paperclipai/shared'
import { classifyHeuristically, classifyWithJev, type Classification } from './classify.js'
import { parseConfig, type RouterConfig } from './config.js'
import {
  ADAPTER_KEYS,
  describeDecision,
  isAdapterType,
  route,
  toOverrides,
  type AdapterType,
  type Bounds,
  type Ladder,
} from './policy.js'

/** What the router remembers about one issue. */
export interface IssueRouting {
  /** Fingerprint of everything the last decision depended on. */
  hash: string
  agentId: string | null
  /** Override keys this router wrote, with their values, to tell them from a human's. */
  written: Record<string, string>
  decidedAt: string | null
  summary?: string
  /** When the first run on this issue started, for the race measurement. */
  firstRunAt?: string
  firstRunId?: string
  race?: RaceOutcome
}

export type RaceOutcome = 'before-run' | 'after-run'

export interface RaceStats {
  beforeRun: number
  afterRun: number
}

const ROUTING_KEY = 'routing'
const RACE_KEY = 'race-stats'
const CLOSED = new Set(['done', 'cancelled'])

function issueScope(issueId: string) {
  return { scopeKind: 'issue' as const, scopeId: issueId, stateKey: ROUTING_KEY }
}

function fingerprint(issue: Issue, bounds: Bounds | null, ladder: Ladder | null): string {
  return createHash('sha256')
    .update(JSON.stringify([issue.title, issue.description ?? '', issue.assigneeAgentId, bounds, ladder]))
    .digest('hex')
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/**
 * Runs one task per key at a time. `issue.created` and the `issue.updated`
 * that follows an assignment can arrive together; without this both would
 * classify the same issue and race each other's write.
 */
function serialise() {
  const tails = new Map<string, Promise<void>>()
  return (key: string, task: () => Promise<void>): Promise<void> => {
    const next = (tails.get(key) ?? Promise.resolve()).then(task, task)
    const tail = next.catch(() => {})
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return next
  }
}

async function classify(ctx: PluginContext, config: RouterConfig, companyId: string, issue: Issue): Promise<Classification> {
  const task = { title: issue.title, description: issue.description }
  if (!config.typesafeApiKey) return classifyHeuristically(task)
  let apiKey: string
  try {
    apiKey = await ctx.secrets.resolve(config.typesafeApiKey, { companyId, configPath: 'typesafeApiKey' })
  } catch {
    // A key that is configured but unreadable is a fault, not a reason to
    // fall back: the operator chose the classifier, so leave the agent alone.
    return { decision: null, classifier: 'jev', ms: 0, error: 'could not resolve the TypeSafe secret' }
  }
  return classifyWithJev(task, apiKey, (url, init) => ctx.http.fetch(url, init))
}

async function recordRace(ctx: PluginContext, outcome: RaceOutcome): Promise<void> {
  const stats = record(await ctx.state.get({ scopeKind: 'instance', stateKey: RACE_KEY }))
  const next: RaceStats = {
    beforeRun: (typeof stats.beforeRun === 'number' ? stats.beforeRun : 0) + (outcome === 'before-run' ? 1 : 0),
    afterRun: (typeof stats.afterRun === 'number' ? stats.afterRun : 0) + (outcome === 'after-run' ? 1 : 0),
  }
  await ctx.state.set({ scopeKind: 'instance', stateKey: RACE_KEY }, next)
}

/**
 * Decides the model and effort for an issue's assignee and writes them as
 * per-issue adapter overrides, which Paperclip merges into the adapter config
 * when it prepares a run. Overrides belong to the issue, not to the agent, so
 * when the assignee changes the keys this router wrote are removed.
 */
async function routeIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<void> {
  const issue = await ctx.issues.get(issueId, companyId)
  if (!issue || CLOSED.has(issue.status)) return

  const config = parseConfig(await ctx.config.get(companyId))
  const previous = (await ctx.state.get(issueScope(issueId))) as IssueRouting | null
  const agentId = issue.assigneeAgentId
  const bounds = agentId && !config.excludedAgentIds.has(agentId) ? config.agents.get(agentId) ?? null : null
  const agent = bounds && agentId ? await ctx.agents.get(agentId, companyId) : null
  const adapterType: AdapterType | null = agent && isAdapterType(agent.adapterType) ? agent.adapterType : null
  const ladder = adapterType ? config.ladders[adapterType] ?? null : null

  const hash = fingerprint(issue, bounds, ladder)
  const adopted = isAdopted(issue, config.adoptLabel)
  // An adopted issue is held until released, so it is handled whatever the hash says.
  if (previous?.hash === hash && !adopted) return

  const overrides: IssueAssigneeAdapterOverrides = issue.assigneeAdapterOverrides ?? {}
  const adapterConfig = record(overrides.adapterConfig)
  const written = previous?.written ?? {}
  // Our keys are the ones still holding the value we wrote; anything else
  // was set by a person and is left alone.
  const ours = Object.keys(adapterConfig).filter((key) => key in written && adapterConfig[key] === written[key])
  const base = Object.fromEntries(Object.entries(adapterConfig).filter(([key]) => !ours.includes(key)))

  let next: Record<string, string> = {}
  let summary: string | undefined
  if (agent && adapterType && ladder && bounds) {
    const keys = ADAPTER_KEYS[adapterType]
    const locked = new Set([keys.model, keys.effort].filter((key) => key in base))
    if (locked.size < 2) {
      const own = record(agent.adapterConfig)
      const current = {
        model: String(base[keys.model] ?? own[keys.model] ?? ''),
        effort: base[keys.effort] ?? own[keys.effort],
      }
      const classification = await classify(ctx, config, companyId, issue)
      const routing = route(classification.decision, current, ladder, bounds, config.policy)
      next = Object.fromEntries(
        Object.entries(toOverrides(adapterType, routing) ?? {}).filter(([key]) => !locked.has(key)),
      )
      summary = `${describeDecision(classification.decision, classification.ms)} · ${classification.classifier} · ${routing.reason}`
      ctx.logger.info('model-router decision', {
        issueId,
        agentId,
        classifier: classification.classifier,
        decision: describeDecision(classification.decision, classification.ms),
        reason: routing.reason,
        overrides: next,
        ...(classification.error ? { error: classification.error } : {}),
      })
    }
  }

  const nextAdapterConfig = { ...base, ...next }
  if (!sameRecord(nextAdapterConfig, adapterConfig)) {
    const patch = { assigneeAdapterOverrides: { ...overrides, adapterConfig: nextAdapterConfig } }
    // The SDK's update type leaves this field out, but the host passes the
    // patch through to the issue service, which accepts it.
    await ctx.issues.update(issueId, patch as Parameters<PluginContext['issues']['update']>[1], companyId)
  }

  const decidedAt = Object.keys(next).length > 0 ? new Date().toISOString() : previous?.decidedAt ?? null
  const state: IssueRouting = {
    ...previous,
    hash,
    agentId,
    written: next,
    decidedAt,
    ...(summary ? { summary } : {}),
  }
  // A run that started before this first decision ran without it.
  if (state.firstRunAt && !state.race && Object.keys(next).length > 0) {
    state.race = 'after-run'
    await recordRace(ctx, 'after-run')
  }
  await ctx.state.set(issueScope(issueId), state)

  if (Object.keys(next).length > 0 && config.comment) {
    const target = Object.entries(next)
      .map(([key, value]) => `\`${key}\` ${value}`)
      .join(', ')
    await ctx.issues.createComment(issueId, `Model router: ${target}.\n\n${summary ?? ''}`, companyId)
  }

  if (adopted) await release(ctx, issue, config.adoptLabel, hash)
}

function isAdopted(issue: Issue, label: string): boolean {
  if (!label || issue.status !== 'backlog' || !issue.assigneeAgentId) return false
  return (issue.labels ?? []).some((l) => l.name.toLowerCase() === label.toLowerCase())
}

/**
 * Hands an adopted issue back once its override is written: drops the label,
 * moves it to `todo` and wakes the assignee. Paperclip does not wake a
 * backlog issue, and a plugin's status change does not queue a run, so the
 * wake is explicit. Runs whether or not routing changed anything, so the
 * label can never strand an issue.
 */
async function release(ctx: PluginContext, issue: Issue, label: string, hash: string): Promise<void> {
  const labelIds = (issue.labels ?? []).filter((l) => l.name.toLowerCase() !== label.toLowerCase()).map((l) => l.id)
  await ctx.issues.update(issue.id, { status: 'todo', labelIds }, issue.companyId)
  try {
    await ctx.issues.requestWakeup(issue.id, issue.companyId, {
      reason: 'model_router_routed',
      contextSource: 'model-router',
      idempotencyKey: `model-router:${issue.id}:${hash}`,
    })
  } catch (error) {
    // Budget stops and unresolved blockers refuse the wake; the issue is in
    // `todo` either way, so Paperclip picks it up when that clears.
    ctx.logger.warn('model-router could not wake the adopted issue', {
      issueId: issue.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Notes the first run on an issue against the decision time. A decision
 * made before the run is in its config; one made after is not, and only
 * later runs on the issue get it.
 */
async function noteRunStarted(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const payload = record(event.payload)
  const issueId = typeof payload.issueId === 'string' ? payload.issueId : null
  if (!issueId) return
  const previous = (await ctx.state.get(issueScope(issueId))) as IssueRouting | null
  if (previous?.firstRunAt) return
  const state: IssueRouting = {
    hash: '',
    agentId: null,
    written: {},
    decidedAt: null,
    ...previous,
    firstRunAt: event.occurredAt,
    firstRunId: typeof payload.runId === 'string' ? payload.runId : undefined,
  }
  if (state.decidedAt && !state.race && Object.keys(state.written).length > 0) {
    state.race = state.decidedAt <= event.occurredAt ? 'before-run' : 'after-run'
    await recordRace(ctx, state.race)
  }
  await ctx.state.set(issueScope(issueId), state)
}

const plugin = definePlugin({
  async setup(ctx) {
    const queue = serialise()
    const onIssue = async (event: PluginEvent) => {
      const issueId = event.entityId
      if (!issueId) return
      await queue(issueId, async () => {
        try {
          await routeIssue(ctx, event.companyId, issueId)
        } catch (error) {
          // Routing is an optimisation: a failure must never block the work.
          ctx.logger.warn('model-router failed; issue left as it was', {
            issueId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    }
    ctx.events.on('issue.created', onIssue)
    ctx.events.on('issue.updated', onIssue)
    ctx.events.on('agent.run.started', async (event) => {
      const issueId = record(event.payload).issueId
      if (typeof issueId !== 'string') return
      await queue(issueId, () => noteRunStarted(ctx, event))
    })
  },

  async onHealth() {
    return { status: 'ok', message: 'Model router is running' }
  },
})

export default plugin
runWorker(plugin, import.meta.url)
