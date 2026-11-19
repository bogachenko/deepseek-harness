import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialBrokerClient } from '../src/broker.ts'

async function withBroker(
  response: (request: unknown) => unknown,
  run: (socketPath: string, requests: unknown[]) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-credential-broker-'))
  const socketPath = join(directory, 'broker.sock')
  const requests: unknown[] = []
  const server = createServer((socket) => {
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      const newline = input.indexOf('\n')
      if (newline < 0) return
      let request: unknown
      try {
        request = JSON.parse(input.slice(0, newline))
      } catch {
        socket.end(JSON.stringify({ version: 1, error: 'INVALID_REQUEST' }) + '\n')
        return
      }
      requests.push(request)
      socket.end(JSON.stringify(response(request)) + '\n')
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await run(socketPath, requests)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('CredentialBrokerClient', () => {
  it('uses the fixed protocol and audience and caches a short-lived token in memory', async () => {
    await withBroker(
      () => ({
        version: 1,
        token: 'dsh1.test.payload.signature',
        expiresAt: Math.floor(Date.now() / 1_000) + 300,
      }),
      async (socketPath, requests) => {
        const client = new CredentialBrokerClient(socketPath)
        expect(await client.getToken()).toBe('dsh1.test.payload.signature')
        expect(await client.getToken()).toBe('dsh1.test.payload.signature')
        expect(requests).toEqual([{
          version: 1,
          operation: 'get_workload_token',
          audience: 'dsh-model-gateway',
        }])
      },
    )
  })

  it('does not accept a token outside the broker lifetime bound', async () => {
    await withBroker(
      () => ({
        version: 1,
        token: 'dsh1.test.payload.signature',
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
      }),
      async (socketPath) => {
        const client = new CredentialBrokerClient(socketPath)
        await expect(client.getToken()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      },
    )
  })

  it('maps a broker authorization refusal without exposing protocol data', async () => {
    await withBroker(
      () => ({ version: 1, error: 'FORBIDDEN' }),
      async (socketPath) => {
        const client = new CredentialBrokerClient(socketPath)
        await expect(client.getToken()).rejects.toMatchObject({ code: 'AUTH' })
      },
    )
  })
})
