import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  upgradeFromGitHub,
  waitForServiceHealth,
} from './remote-upgrade.js'

describe('remote release versions', () => {
  it('compares stable semantic versions', () => {
    expect(compareVersions('0.3.0', '0.2.1')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
  })

  it('rejects ambiguous versions', () => {
    expect(() => compareVersions('latest', '0.3.0')).toThrow(
      'Unsupported release version'
    )
  })

  it('reads the static latest-release manifest without changing an up-to-date installation', async () => {
    let requested = ''
    let stopped = false
    const result = await upgradeFromGitHub({
      currentVersion: '0.4.0',
      fetcher: (async (url: string | URL | Request) => {
        requested = String(url)
        return new Response(
          JSON.stringify({
            version: '0.4.0',
            package: 'qiushui-airadar-cli-0.4.0.tgz',
            checksum: 'qiushui-airadar-cli-0.4.0.tgz.sha256',
          })
        )
      }) as typeof fetch,
      serviceManager: {
        async execute() {
          stopped = true
          return {}
        },
      },
      stdout: { write() {} },
    })
    expect(requested).toBe(
      'https://github.com/benjamin-qhy/qiushui-airadar/releases/latest/download/qiushui-airadar-release.json'
    )
    expect(result.changed).toBe(false)
    expect(stopped).toBe(false)
  })

  it('waits until the upgraded service health endpoint is ready', async () => {
    let attempts = 0
    await waitForServiceHealth(
      (async () => {
        attempts += 1
        if (attempts < 3) throw new Error('service is starting')
        return Response.json({ status: 'ready' })
      }) as typeof fetch,
      async () => undefined
    )
    expect(attempts).toBe(3)
  })
})
