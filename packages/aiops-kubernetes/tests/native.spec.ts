import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import NativeKubernetesRuntime, { KubernetesQueryError } from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

describe('NativeKubernetesRuntime', () => {
  it('loads kubeconfig and reads the Kubernetes API without kubectl', async () => {
    const requests: Array<{ method?: string; url?: string }> = []
    const server = createServer((req, res) => serve(req, res, requests))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise(resolve => server.close(() => resolve())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-aiops-kube-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const kubeconfig = join(directory, 'config')
    await writeFile(kubeconfig, `apiVersion: v1\nkind: Config\nclusters:\n- name: test-cluster\n  cluster:\n    server: http://127.0.0.1:${address.port}\n    insecure-skip-tls-verify: true\ncontexts:\n- name: test-context\n  context:\n    cluster: test-cluster\n    user: test-user\n    namespace: payments\ncurrent-context: test-context\nusers:\n- name: test-user\n  user:\n    token: test-token\n`)

    const runtime = new NativeKubernetesRuntime(new Context(), { kubeconfig, timeoutMs: 2_000 })
    await expect(runtime.list({ cwd: '/workspace', resource: 'pods', labelSelector: 'app=api' }))
      .resolves.toMatchObject({ kind: 'PodList', items: [] })
    await expect(runtime.get({ cwd: '/workspace', resource: 'deployment', name: 'api' }))
      .resolves.toMatchObject({ kind: 'Deployment', metadata: { name: 'api' } })
    const logSpec = runtime.resolveLogs({
      cwd: '/workspace', pod: 'api-1', container: 'api',
      sinceTime: '2026-09-07T00:00:00Z', untilTime: '2026-09-07T00:10:00Z',
    })
    await expect(runtime.logs(logSpec)).resolves.toBe('2026-09-07T00:05:00Z ready\n')
    await expect(runtime.testConnection({ kubeconfig })).resolves.toMatchObject({
      context: 'test-context', cluster: 'test-cluster', namespace: 'payments',
      capabilities: { pods: true, events: true, podLogs: true },
    })
    expect(requests.some(request => request.url?.startsWith('/api/v1/namespaces/payments/pods?labelSelector=app%3Dapi'))).toBe(true)
    expect(requests.some(request => request.url === '/apis/apps/v1/namespaces/payments/deployments/api')).toBe(true)
    const logRequest = requests.find(request => request.url?.startsWith('/api/v1/namespaces/payments/pods/api-1/log?'))
    expect(new URL(`http://test${logRequest?.url}`).searchParams.get('sinceTime')).toBe('2026-09-07T00:00:00.000Z')
    expect(requests.filter(request => request.url === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews')).toHaveLength(3)
  })

  it('rejects relative kubeconfig paths and unsupported resource names before I/O', async () => {
    expect(() => new NativeKubernetesRuntime(new Context(), { kubeconfig: './config' })).toThrow(KubernetesQueryError)
    const runtime = new NativeKubernetesRuntime(new Context(), {})
    await expect(runtime.list({ cwd: '/workspace', resource: 'customwidgets' })).rejects.toMatchObject({ code: 'unsupported_resource' })
  })
})

function serve(req: IncomingMessage, res: ServerResponse, requests: Array<{ method?: string; url?: string }>): void {
  requests.push({ method: req.method, url: req.url })
  res.setHeader('content-type', 'application/json')
  if (req.url === '/version') { res.end(JSON.stringify({ major: '1', minor: '34', gitVersion: 'v1.34.0', gitCommit: 'test', gitTreeState: 'clean', buildDate: '2026-01-01T00:00:00Z', goVersion: 'go1.24', compiler: 'gc', platform: 'test' })); return }
  if (req.url === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews') { res.end(JSON.stringify({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', status: { allowed: true } })); return }
  if (req.url?.startsWith('/api/v1/namespaces/payments/pods?')) { res.end(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: {}, items: [] })); return }
  if (req.url === '/apis/apps/v1/namespaces/payments/deployments/api') { res.end(JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'api', namespace: 'payments' }, spec: { selector: {}, template: { metadata: {}, spec: { containers: [] } } } })); return }
  if (req.url?.startsWith('/api/v1/namespaces/payments/pods/api-1/log?')) { res.setHeader('content-type', 'text/plain'); res.end('2026-09-07T00:05:00Z ready\n2026-09-07T00:11:00Z later\n'); return }
  res.statusCode = 404; res.end(JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404 }))
}
