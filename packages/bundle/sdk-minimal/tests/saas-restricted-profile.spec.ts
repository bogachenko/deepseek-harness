/** Capability-restricted overlay applied to the standalone sdk-minimal profile. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'

interface Row {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Row[]
}

const basePatchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const overlayPath = fileURLToPath(new URL('../../../../deploy/profiles/saas-restricted/cordis.patch.yml', import.meta.url))

function rowsFromBase(): Map<string, Row> {
  const patches = parseEntryYaml(readFileSync(basePatchPath, 'utf8')) as Row[]
  return new Map(patches.flatMap(patch => patch.insert ?? []).flatMap(row =>
    row.id === undefined ? [] : [[row.id, row] as const],
  ))
}

describe('SaaS Restricted profile overlay', () => {
  it('disables every local execution and general file tool in sdk-minimal', () => {
    const base = rowsFromBase()
    const overlay = parseEntryYaml(readFileSync(overlayPath, 'utf8')) as Row[]
    const effective = new Map(base)

    for (const patch of overlay) {
      if (patch.id === undefined) throw new Error('overlay entries must target an existing row')
      const previous = effective.get(patch.id)
      if (previous === undefined) throw new Error(`overlay targets missing sdk-minimal row: ${patch.id}`)
      effective.set(patch.id, { ...previous, ...patch })
    }

    for (const id of [
      'session-log-deepseek',
      'tool-fs',
      'tool-working-directory',
      'terminal-bash',
      'terminal-pwsh',
      'persistent-bash',
      'persistent-pwsh',
      'mcp-resources',
    ]) {
      expect(effective.get(id)?.disabled, `${id} must be disabled`).toBe(true)
    }

    expect(effective.get('sandbox-policy')?.config).toMatchObject({ mode: 'read-only' })
    expect(effective.get('sdk-jsonrpc-server')?.disabled).not.toBe(true)
    expect(effective.get('agent-loop')?.disabled).not.toBe(true)
    expect(effective.get('tool-executor-native')?.disabled).not.toBe(true)
  })

  it('contains only the reviewed overlay rows', () => {
    const overlay = parseEntryYaml(readFileSync(overlayPath, 'utf8')) as Row[]
    expect(overlay.map(row => row.id)).toEqual([
      'session-log-deepseek',
      'tool-fs',
      'tool-working-directory',
      'terminal-bash',
      'terminal-pwsh',
      'persistent-bash',
      'persistent-pwsh',
      'mcp-resources',
      'sandbox-policy',
    ])
  })
})
