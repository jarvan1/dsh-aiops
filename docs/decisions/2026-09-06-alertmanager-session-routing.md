# Alertmanager notifications use durable deterministic Session routing

English | [中文](2026-09-06-alertmanager-session-routing.zh.md)

Date: 2026-09-06

Status: implemented

## Decision

The Alertmanager adapter owns HTTP method, media type, bearer authentication, byte and batch limits, provider-field validation, and normalized delivery construction. It dispatches only authenticated `alertmanager` events through the generic DSH webhook runtime.

The AIOps incident router owns high-signal policy and one SQLite coordination database. `(source, fingerprint)` identifies the current alert round. A SHA-256 of source, fingerprint, and round produces the DSH Session ID, so a crash after routing but before Session publication can be repaired without allocating another identity. SQLite immediate transactions serialize state changes; an in-process Promise table coalesces competing Agent creation for the same identity.

The first firing notification creates round 1. Later firing and resolved notifications append to that Session. Firing after resolution increments the round and creates a new Session. The router resumes a persisted Session after process restart. Exact delivery retries retain their first per-alert outcome even if routing policy changes later; delivery-id reuse with different authenticated bytes fails.

Every accepted route is appended to Session JSONL as `aiops/alert-routed` before its model-visible follow-up. The event carries the normalized alert and decision. Filtered alerts remain audit rows without starting an Agent. The router database is authoritative only for replay and routing coordination; it is not an incident database and cannot replace Session history.

## Consequences

- Alertmanager retries cannot create duplicate diagnostic Sessions.
- Expression recovery and incident closure remain different facts.
- The bundle can run beside the Web application because its ingress WebServer is isolated.
- A configured all-interface listener still requires deployment TLS, network policy, and secret rotation.
- A future multi-process router must replace the local SQLite writer assumption with a shared transactional coordinator before horizontal scaling.
