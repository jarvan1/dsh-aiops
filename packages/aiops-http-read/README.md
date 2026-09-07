---
description: "Shared bounded GET and UTF-8 response collection for read-only DSH AIOps HTTP providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-http-read

English | [中文](README.zh.md)

## Summary

`dsh-aiops-http-read` gives the Alertmanager and Prometheus Providers one implementation for deadline propagation, non-redirecting JSON GET requests, and complete byte-bounded UTF-8 response collection. It is a stateless library, not a Cordis plugin or capability seam.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call `readAiopsHttp()` only after the owning Provider has validated and resolved its URL, deadline, and byte limit. Translate `AiopsHttpReadError` into the capability's public error type so Consumers do not depend on this transport helper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The helper issues a fixed `GET` with `Accept: application/json`, rejects redirects, and composes caller cancellation with the Provider deadline. It rejects an oversized declared body before reading and cancels a streamed body as soon as the observed bytes exceed the configured limit. Successful output contains the `Response` metadata and the complete decoded body.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Fixed HTTP acquisition, deadline classification, and bounded UTF-8 body collection |
| — | No runtime invariant companion is published because each call owns all state and returns one immutable result. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Alertmanager Provider](../aiops-alertmanager/README.md) — current-alert Consumer of this helper.
- [Prometheus Provider](../aiops-prometheus/README.md) — PromQL Consumer of this helper.
- [AIOps subsystem](../../docs/aiops.md) — capability ownership and read-only limits.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Complete bodies only** — the helper does not expose streaming output; crossing the byte limit fails the whole request.
- **JSON-oriented headers only** — it always requests JSON, while each Provider remains responsible for parsing and validating its own response fields.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
