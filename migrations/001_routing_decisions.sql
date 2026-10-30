CREATE TABLE plugin_model_router_cf2ed186cd.routing_decisions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  baseline_model text NOT NULL,
  routed_model text,
  routed_effort text,
  direction text NOT NULL,
  classifier text NOT NULL,
  summary text NOT NULL
);
