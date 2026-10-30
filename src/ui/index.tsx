import { MetricCard, Spinner, usePluginData, type PluginWidgetProps } from '@paperclipai/plugin-sdk/ui'
import type { DashboardData } from '../worker.js'

function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : 'n/a'
}

/**
 * Dashboard widget: what the router decided over the last month and what it
 * saved, estimated against each agent's own default model.
 */
export function SavingsWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<DashboardData>('dashboard', { companyId: context.companyId })

  if (loading) return <Spinner />
  if (error || !data) return <p>Model router: no data yet.</p>

  const { decisions, savings, race } = data
  const total = decisions.down + decisions.up + decisions.effort + decisions.kept + decisions.changed
  const raced = race.beforeRun + race.afterRun

  return (
    <section aria-label="Model router savings" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        <MetricCard label={`Estimated saved, ${data.days} days`} value={dollars(savings.savedCents)} />
        <MetricCard label="Spent on routed issues" value={dollars(savings.actualCents)} />
        <MetricCard label="Decisions" value={total} />
        <MetricCard label="Decided before the first run" value={percent(race.beforeRun, raced)} />
      </div>
      <p style={{ margin: 0, fontSize: 12, opacity: 0.75 }}>
        Down {decisions.down} · up {decisions.up} · effort only {decisions.effort} · kept {decisions.kept}
        {decisions.changed > 0 ? ` · other ${decisions.changed}` : ''}
      </p>
      <details style={{ fontSize: 12, opacity: 0.75 }}>
        <summary style={{ cursor: 'pointer' }}>How the saving is estimated</summary>
        <p style={{ margin: '4px 0 0' }}>
          Each routed issue's tokens are priced at its agent's default model, using this instance's own cost history,
          minus what the issue cost. A change of effort alone counts as no saving.
        </p>
        <p style={{ margin: '4px 0 0' }}>
          Issues priced: {savings.pricedIssues}
          {savings.unpricedIssues > 0
            ? ` · left out: ${savings.unpricedIssues} (no price for the default model, or a run billed at $0)`
            : ''}
        </p>
      </details>
    </section>
  )
}
