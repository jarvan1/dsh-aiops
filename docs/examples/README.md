# Routing-policy JSON examples

Use [`routing-policy.example.json`](routing-policy.example.json) as the complete version 1 policy reference. In the Portal, copy the values of `severityMap`, `modelBudgets`, and `stormControl` into their matching JSON editors. Enter `routingPolicy.ignoredAlertnames` one item per line and choose `routingPolicy.defaultSeverity` from the selector.

Use [`routing-policy-labels.example.json`](routing-policy-labels.example.json) in the dry-run labels editor. Replace the sample labels with one normalized Alertmanager alert; dry-run validates and evaluates the candidate policy without queueing work or creating a Session.

The reservation values are limits, not usage targets. Each `modelBudgets` value must fit both its matching `severityReservedTokens` limit and `globalReservedTokens`; each severity concurrency value must not exceed `globalConcurrency`.
