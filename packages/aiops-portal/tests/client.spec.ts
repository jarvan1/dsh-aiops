// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionSettings } from '../src/client/ConnectionSettings.tsx'
import { apply, inject } from '../src/client/index.ts'

describe('AIOps Portal client registration', () => {
  it('contributes localized AIOps conversation and persistent sidebar entries', () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const settingsScope = {
      getSnapshot: () => ({ status: 'ready', value: { baseUrl: '' }, revision: 0, writable: true, mode: 'host' }),
      subscribe: () => vi.fn(),
      mutate: vi.fn(() => Promise.resolve()),
      set: vi.fn(() => Promise.resolve()),
      unset: vi.fn(() => Promise.resolve()),
    }
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      locale: {
        register: vi.fn(() => vi.fn()),
        bind: vi.fn(() => (key: string) => key === 'view.portal' || key === 'entry' ? 'AIOps' : key),
      },
      settingsScope: {
        bind: vi.fn(() => settingsScope),
      },
      slots: {
        inject: vi.fn((name: string, setup: () => unknown) => {
          expect(['conversation.view', 'sidebar.footer.action']).toContain(name)
          return setup()
        }),
        register: vi.fn((options: Record<string, unknown>, view: unknown) => {
          registrations.push({ options, component: view })
          return vi.fn()
        }),
      },
    }

    apply(ctx as never)

    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
    expect(ctx.settingsScope.bind).toHaveBeenCalledTimes(3)
    expect(registrations[0]?.options).toMatchObject({
      name: 'conversation.view',
      id: 'aiops',
      order: 20,
      locale: 'aiops-portal',
    })
    expect(registrations[1]?.options).toMatchObject({
      name: 'sidebar.footer.action',
      id: 'aiops',
      order: 10,
      locale: 'aiops-portal',
    })
    expect((registrations[0]?.options.label as () => string)()).toBe('AIOps')
    expect((registrations[1]?.options.label as () => string)()).toBe('AIOps')
    expect(registrations.map(row => row.component)).toEqual([
      expect.any(Function),
      expect.any(Function),
    ])
  })

  it('requires successful tests for all three data sources before enabling save', async () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    const scope = () => {
      const snapshot = { status: 'ready', value: { baseUrl: '' }, revision: 0, writable: true, mode: 'host' } as const
      return {
        getSnapshot: () => snapshot,
        subscribe: () => vi.fn(),
        mutate: vi.fn(() => Promise.resolve()),
        set: vi.fn(() => Promise.resolve()),
        unset: vi.fn(() => Promise.resolve()),
      }
    }
    const prometheusSettings = scope()
    const alertmanagerSettings = scope()
    const kubernetesSnapshot = { status: 'ready', value: { kubeconfig: '', context: '' }, revision: 0, writable: true, mode: 'host' } as const
    const kubernetesSettings = {
      ...scope(),
      getSnapshot: () => kubernetesSnapshot,
    }
    const testConnection = vi.fn(async (request: { target: string }) => request.target === 'kubernetes'
      ? { ok: true, latencyMs: 3, kubernetes: { context: 'prod', cluster: 'prod', namespace: 'default', server: 'https://cluster' } } as const
      : { ok: true, latencyMs: 3 } as const)
    const loadWebhookConfiguration = vi.fn(async (revealSecret: boolean) => ({
      version: 1 as const,
      url: 'http://dsh-host:3081/alertmanager',
      secretConfigured: true,
      ...(revealSecret ? { secret: 'test-secret' } : {}),
    }))
    const t = (key: string, params?: Record<string, unknown>) => params === undefined
      ? key : `${key}:${Object.values(params).join(',')}`
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ConnectionSettings, {
        prometheusSettings: prometheusSettings as never,
        alertmanagerSettings: alertmanagerSettings as never,
        kubernetesSettings: kubernetesSettings as never,
        loadWebhookConfiguration,
        testConnection,
        t: t as never,
      }))
    })

    const inputs = [...container.querySelectorAll('input')]
    const setInput = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => {
      setInput(inputs[0] as HTMLInputElement, 'http://prometheus:9090')
      setInput(inputs[1] as HTMLInputElement, 'http://alertmanager:9093')
    })
    const button = (label: string) => [...container.querySelectorAll('button')]
      .find(value => value.textContent === label) as HTMLButtonElement
    expect(button('save').disabled).toBe(true)
    expect(loadWebhookConfiguration).toHaveBeenCalledWith(false, expect.any(AbortSignal))
    expect((container.querySelector('#aiops-webhook-url') as HTMLInputElement).value).toBe('http://dsh-host:3081/alertmanager')

    await act(async () => { button('showSecret').click() })
    expect(loadWebhookConfiguration).toHaveBeenCalledWith(true)
    expect((container.querySelector('#aiops-webhook-secret') as HTMLInputElement).value).toBe('test-secret')
    await act(async () => { button('hideSecret').click() })
    expect((container.querySelector('#aiops-webhook-secret') as HTMLInputElement).value).toBe('')

    await act(async () => {
      const tests = [...container.querySelectorAll('button')].filter(value => value.textContent === 'testConnection')
      tests[0]?.click()
      tests[1]?.click()
      tests[2]?.click()
    })
    expect(testConnection).toHaveBeenCalledTimes(3)
    expect(button('save').disabled).toBe(false)

    await act(async () => { root.unmount() })
  })
})
