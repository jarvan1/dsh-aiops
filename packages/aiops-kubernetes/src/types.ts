/** Pure public types for the read-only Kubernetes query seam. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Shared execution fields for one Kubernetes read. */
export interface KubernetesExecutionTarget {
  /** Working directory used for kubectl execution and relative kubeconfig resolution. */
  readonly cwd: string
  /** Optional namespace; omission uses the selected kubectl context default. */
  readonly namespace?: string
}

/** Shared target fields for one Kubernetes object read. */
export interface KubernetesTarget extends KubernetesExecutionTarget {
  /** Kubernetes resource name or plural resource type, such as `pod` or `deployments`. */
  readonly resource: string
}

/** Read one named Kubernetes object. */
export interface KubernetesGetRequest extends KubernetesTarget {
  /** Exact object name. */
  readonly name: string
}

/** List Kubernetes objects with optional server-side selectors. */
export interface KubernetesListRequest extends KubernetesTarget {
  /** Kubernetes label selector. */
  readonly labelSelector?: string
  /** Kubernetes field selector. */
  readonly fieldSelector?: string
}

/** List Kubernetes Event objects in chronological order. */
export interface KubernetesEventsRequest extends KubernetesExecutionTarget {
  /** Kubernetes label selector. */
  readonly labelSelector?: string
  /** Kubernetes field selector, such as `involvedObject.name=api-1`. */
  readonly fieldSelector?: string
  /** Inclusive absolute lower bound applied to Event occurrence timestamps. */
  readonly sinceTime?: string
  /** Inclusive absolute upper bound applied to Event occurrence timestamps. */
  readonly untilTime?: string
}

/** Request a bounded snapshot of one Pod container's logs. */
export interface KubernetesLogsRequest extends KubernetesExecutionTarget {
  /** Exact Pod name. */
  readonly pod: string
  /** Container name; omission lets kubectl select the Pod's only/default container. */
  readonly container?: string
  /** Read the previous terminated container instance. */
  readonly previous?: boolean
  /** Requested recent line count; omission uses the Provider default and excess is capped. */
  readonly tailLines?: number
  /** Relative Kubernetes duration, such as `15m`. */
  readonly since?: string
  /** Absolute RFC3339 lower bound; mutually exclusive with `since`. */
  readonly sinceTime?: string
  /** Absolute RFC3339 upper bound applied after kubectl returns timestamped lines. */
  readonly untilTime?: string
  /** Include the Kubernetes timestamp prefix on each line. */
  readonly timestamps?: boolean
}

/** Fully resolved bounded Pod-log request accepted by a Kubernetes Provider. */
export interface KubernetesLogsSpec extends KubernetesExecutionTarget {
  /** Exact Pod name. */
  readonly pod: string
  /** Container name when explicitly selected. */
  readonly container?: string
  /** Whether to read the previous terminated container instance. */
  readonly previous: boolean
  /** Provider-capped recent line count. */
  readonly tailLines: number
  /** Relative Kubernetes duration when supplied. */
  readonly since?: string
  /** Normalized absolute lower bound when supplied. */
  readonly sinceTime?: string
  /** Normalized absolute upper bound when supplied. */
  readonly untilTime?: string
  /** Whether each returned line includes a timestamp. */
  readonly timestamps: boolean
}

/** Lossless JSON returned by the Kubernetes API through the selected provider. */
export type KubernetesReadResult = JsonValue

/** Exact bounded stdout returned by `kubectl logs`. */
export type KubernetesLogsResult = string
