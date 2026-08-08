# KubeMan Future Features

This document is the working backlog for capabilities that extend KubeMan beyond
cluster access and day-to-day Kubernetes operations. Items are intentionally
described as product outcomes and security constraints before implementation
details are chosen.

## Guiding principles

- Every signal, query, and action is scoped to an explicit cluster and user.
- Read access and mutation access remain separate permissions.
- Credentials and integration secrets never appear in the browser after setup.
- External notifications contain useful context without leaking Kubernetes
  secrets, tokens, environment values, or sensitive logs.
- All automated and human actions produce an auditable event.

## Monitoring

### Cluster and workload health

- Discover Prometheus, Amazon Managed Service for Prometheus, and OpenTelemetry
  endpoints per cluster.
- Track node readiness, pod health, deployment availability, pending workloads,
  restart loops, scheduling failures, API server reachability, and certificate
  expiry.
- Add namespace, workload, label, environment, AWS account, and cluster filters.
- Show current state, recent trend, and the event or deployment that most likely
  caused a change.
- Retain the AWS role used to collect each signal.

### Infrastructure monitoring

- Monitor EKS control-plane status, node groups, Fargate profiles, load balancers,
  NAT gateways, VPC endpoints, subnet IP exhaustion, and security-group drift.
- Correlate Kubernetes services and ingresses with AWS load balancers, target
  groups, addresses, subnets, and security groups.
- Flag private endpoint, bastion, DNS, or network path failures separately from
  Kubernetes workload failures.

### Monitoring tile

- Add a configurable monitoring tile with compact health summaries, time ranges,
  and drill-down charts.
- Allow saved personal and shared views.
- Support global overview, selected-cluster, namespace, and workload modes.

## Alerting

### Alert rules

- Create rules from Kubernetes events, Prometheus expressions, AWS metrics,
  resource state, or audit activity.
- Support warning, critical, and informational severity.
- Include evaluation duration, cooldown, maintenance windows, and environment
  scope.
- Provide rule templates for common EKS and Kubernetes failures.

### Alert lifecycle

- Group duplicate alerts and correlate related symptoms into one incident.
- Track open, acknowledged, silenced, resolved, and expired states.
- Record who acknowledged or silenced an alert and from which interface.
- Preserve a timeline of notifications, state changes, related deployments, and
  cluster events.
- Add escalation policies and delivery retries with visible failure status.

## Slack integration

Slack support has two distinct operating modes. They must be configured and
permissioned independently.

### One-way notifications

- Send new, escalated, acknowledged, and resolved alert notifications.
- Route by workspace, channel, cluster, namespace, severity, or team ownership.
- Use Block Kit messages with cluster, workload, role, severity, age, and a deep
  link back to KubeMan.
- Redact secrets and limit log excerpts.
- Support webhook delivery initially, followed by bot-token delivery for richer
  messages and thread updates.
- Verify delivery and expose retry or dead-letter status to administrators.

### Query bot

- Accept Slack mentions and slash commands such as:
  - `@kubeman status production-us-east-1`
  - `@kubeman pods failing in payments`
  - `@kubeman why is checkout unavailable?`
  - `/kubeman alerts critical`
- Resolve the Slack user to a KubeMan user and enforce that user’s cluster,
  namespace, and role permissions.
- Begin read-only. Any future mutation must use an explicit confirmation flow in
  KubeMan and must never execute directly from an unverified message.
- Verify Slack request signatures, timestamps, workspace identity, channel
  allowlists, and replay protection.
- Return concise answers in-channel and place sensitive or long results in an
  ephemeral response or a KubeMan deep link.
- Audit the original query, resolved identity, cluster context, commands or APIs
  used, and response outcome.

### Slack administration

- Add a separate administration section for Slack application credentials,
  signing secret, bot token, approved workspaces, channel routing, and test
  delivery.
- Provide least-privilege OAuth scope guidance.
- Show connection health, last event received, last notification delivered,
  token age, and rotation status.

## Suggested delivery phases

1. **Signal foundation:** cluster health collectors, normalized events, storage,
   and a monitoring tile.
2. **Alert engine:** rules, deduplication, lifecycle, history, and audit records.
3. **Slack notifications:** one-way webhook delivery, routing, retries, and test
   messages.
4. **Slack application:** signed event receiver, identity mapping, channel
   allowlists, and read-only query bot.
5. **Operational intelligence:** cross-signal correlation, natural-language
   explanations, suggested remediation, and approval-gated actions.

## Open decisions

- Metrics retention duration and expected cluster count.
- Prometheus-compatible storage choice for local and team deployments.
- Whether alert ownership follows Kubernetes labels, KubeMan teams, or both.
- Slack Enterprise Grid and multi-workspace requirements.
- Which bot queries may include logs and how log redaction is configured.
- Whether acknowledgements from Slack are allowed before mutation workflows are
  introduced.
