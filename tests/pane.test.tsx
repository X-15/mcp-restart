import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'mcp-restart',
  component: 'Pane',
  requestId: 'mcp-servers',
  props: {
    title: 'MCP servers',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const base = { scope: 'user', started: '2026-10-31T02:00:00.000Z', self: false, state: 'running', lastError: null }
const rea = { ...base, name: 'rea', pid: 101, stale: true, changed: 'rea.mjs', wrapped: true, live: true, generation: 3, inflight: [{ method: 'tools/call', tool: 'trace_feature', ms: 45000, generation: 3 }] }
const reddit = { ...base, name: 'reddit', pid: 102, started: '2026-10-31T01:00:00.000Z', stale: false, changed: 'uv.lock', wrapped: false, live: false, generation: null, state: null, inflight: [] }
const listOf = (servers: object[]) => JSON.stringify({ sessions: [{ pid: 9, version: '2.1.309', isOwn: true, servers }] })

const seeded = (servers: object[]) => ({
  value: {
    value: {
      shape: 'view-2',
      value: { servers, stopped: [], session: 'Claude Code 2.1.309, session pid 9', checkedAt: '2026-10-31T02:05:00.000Z', busy: null, message: null },
    },
    version: 1,
  },
})

test('the pane shows the mode, calls in flight and a Force restart for a slow call, on every surface', async ($, on) => {
  on('state.get', (_, e, next) => (e.key === 'view' ? seeded([rea, reddit]) : next(e)))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'restart-rea' })).toBeDefined()
    expect(await ui.find({ key: 'force-rea' })).toBeDefined()
    expect(await ui.find({ key: 'force-reddit' })).toBeUndefined()
    expect(await ui.find({ key: 'restart-stale' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^user, hot-swap/ }))?.text).toBe('user, hot-swap, generation 3, up 5m 0s')
    expect((await ui.find({ type: 'Text', text: /^running trace_feature/ }))?.text).toBe('running trace_feature for 45s')
    expect((await ui.find({ type: 'Text', text: /^user, stop only/ }))?.text).toBe('user, stop only, up 65m 0s')
    await ui.unmount()
  }
})

test('/mcp-restart rea --force runs the CLI with --force, then lists again', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const stdout = e.argv.includes('restart')
      ? JSON.stringify({ results: [{ ...rea, session: 9, mode: 'swap', ok: true }], missing: [], text: 'Restarted rea (generation 4, 0.3 s): 229 tools; new: x. Available to the model now.' })
      : listOf([rea])
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))

  const result = await $.command.run({ command: 'mcp-restart', args: 'rea --force' } as never)

  expect(JSON.stringify(result)).toContain('Restarted rea (generation 4')
  expect(runs[0]?.slice(2)).toEqual(['restart', 'rea', '--force', '--json'])
  expect(runs[1]?.slice(2)).toEqual(['list', '--json'])
})

test('the restart_server tool runs the CLI with the name and force, and returns its text to the model', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'Restarted rea (generation 4, 0.3 s): 229 tools; new: x. Available to the model now.\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__mcp-restart__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)

  const result = await $.tool.call({ tool: 'mcp__mcp-restart__restart_server', name: 'rea', force: true } as never)

  expect(JSON.stringify(result)).toContain('Restarted rea (generation 4')
  expect(runs[0]?.slice(2)).toEqual(['restart', 'rea', '--force'])
  expect(runs[0]?.[1]?.endsWith('cli.mjs')).toBe(true)
})

test('/mcp-restart wrap reddit runs cli wrap', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify({ changes: [{ name: 'reddit', where: 'user', ok: true }], backups: ['x.bak'] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const result = await $.command.run({ command: 'mcp-restart', args: 'wrap reddit' } as never)

  expect(JSON.stringify(result)).toContain('Wrapped reddit (user)')
  expect(runs[0]?.slice(2)).toEqual(['wrap', 'reddit', '--json'])
})

test('the band stays out of the way while the call is younger than 60 s', async ($, on) => {
  const BAND = { plugin: 'mcp-restart', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 60, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as const
  const since = Date.now() - 30000
  on('state.get', (_, e, next) => (e.key === 'calls' ? { value: { value: { shape: 'calls-1', value: [{ id: 't1', tool: 'mcp__rea__trace_feature', server: 'rea', since }] }, version: 1 } } : next(e)))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'restart-hung' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('the band offers a restart once a model MCP call has run 60 s', async ($, on) => {
  const BAND = { plugin: 'mcp-restart', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 60, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as const
  const since = Date.now() - 75000
  on('state.get', (_, e, next) => (e.key === 'calls' ? { value: { value: { shape: 'calls-1', value: [{ id: 't1', tool: 'mcp__rea__trace_feature', server: 'rea', since }] }, version: 1 } } : next(e)))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'restart-hung' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /has been running/ }))?.text).toContain('mcp__rea__trace_feature has been running 75s')
    await ui.unmount()
  }
})
