import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The host (late-host.mjs) as the mod sees it: its stdout events through $.process.spawn, its HTTP API
// through $.http.fetch. The fakes below stand in for both.
const READY = { type: 'ready', url: 'http://127.0.0.1:5555', token: 't0k' }
const TOOLS = {
  type: 'tools',
  server: 'zcode-bridge',
  scope: 'user',
  generation: 1,
  tools: [
    { name: 'zcode_models', description: 'List models.', inputSchema: { type: 'object', properties: {} } },
    { name: 'zcode_agent', description: 'Run an agent turn.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  ],
}
const lines = (...events: object[]) => `${events.map(e => JSON.stringify(e)).join('\n')}\n`
const ok = (body: object) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })

type Fetched = { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }
type Registered = { name: string; description: string; inputSchema?: unknown }

// a session started with a host that reports `events` and answers HTTP with `answer`
async function startSession($: any, on: On, events: object[], answer: (f: Fetched) => ReturnType<typeof ok>) {
  const clock = mock.clock(on)
  const registered: Registered[] = []
  const spawned: { argv: string[]; input?: string }[] = []
  const fetched: Fetched[] = []
  const toasts: string[] = []
  on('process.spawn', async function* (_, e) {
    spawned.push({ argv: [...e.argv], input: e.input })
    yield { stream: 'stdout' as const, text: lines(...events) }
    await clock.sleep(3_600_000) // the host stays up for the test
    return { value: { code: 0, signal: null } }
  })
  on('tool.register', (_, e) => {
    registered.push(e as Registered)
    return { value: { tool: `mcp__mcp-restart__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.list', () => ({ value: [{ name: 'mcp__rea__trace_feature', description: 'x', mcp: true }] }))
  on('http.fetch', (_, e) => {
    fetched.push(e as Fetched)
    return answer(e as Fetched)
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text: string }).text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await clock.settle()
  return { clock, registered, spawned, fetched, toasts }
}

test('a server added mid-session: its tools are declared as the mod\'s, and a call reaches the host', async ($, on) => {
  const s = await startSession($, on, [READY, { type: 'baseline', names: ['rea'], reason: 'test' }, TOOLS], f =>
    f.url.endsWith('/call') ? ok({ done: true, result: { content: [{ type: 'text', text: 'GLM-5.3, deepseek-v4-pro' }] } }) : ok({}),
  )

  expect(s.spawned[0]?.argv[1]?.endsWith('late-host.mjs')).toBe(true)
  // the first host of the session works out the baseline itself, told which servers the session has tools from
  expect(JSON.parse(s.spawned[0]?.input ?? '{}')).toEqual({ baseline: null, visible: ['rea'] })
  const names = s.registered.map(r => r.name)
  expect(names).toContain('call_tool')
  expect(names).toContain('zcode-bridge__zcode_models')
  expect(names).toContain('zcode-bridge__zcode_agent')
  expect(s.registered.find(r => r.name === 'zcode-bridge__zcode_agent')?.inputSchema).toEqual(TOOLS.tools[1]?.inputSchema)
  expect(s.registered.find(r => r.name === 'zcode-bridge__zcode_models')?.description).toContain('added after this session started')
  expect(s.toasts.some(t => t.includes('zcode-bridge') && t.includes('2 tools'))).toBe(true)

  const result = await $.tool.call({ tool: 'mcp__mcp-restart__zcode-bridge__zcode_agent', tool_use_id: 'u1', prompt: 'hi' } as never)
  expect(JSON.stringify(result)).toContain('deepseek-v4-pro')
  const call = s.fetched.find(f => f.url === 'http://127.0.0.1:5555/call')
  expect(call?.init?.method).toBe('POST')
  expect(call?.init?.headers?.authorization).toBe('Bearer t0k')
  expect(JSON.parse(call?.init?.body ?? '{}')).toMatchObject({ server: 'zcode-bridge', tool: 'zcode_agent', arguments: { prompt: 'hi' } })
})

test('a call longer than one answer is fetched again by id; an error result reaches the model as an error', async ($, on) => {
  let polls = 0
  await startSession($, on, [READY, TOOLS], f => {
    if (f.url.endsWith('/call')) {
      const body = JSON.parse(f.init?.body ?? '{}')
      return body.tool === 'zcode_models' ? ok({ done: false, id: '7' }) : ok({ done: true, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } })
    }
    if (f.url.includes('/result?id=7')) return ok(++polls < 2 ? { done: false, id: '7' } : { done: true, result: { content: [{ type: 'text', text: 'late answer' }] } })
    return ok({})
  })

  const slow = await $.tool.call({ tool: 'mcp__mcp-restart__zcode-bridge__zcode_models', tool_use_id: 'u2' } as never)
  expect(JSON.stringify(slow)).toContain('late answer')
  expect(polls).toBe(2)

  const failed = await $.tool.call({ tool: 'mcp__mcp-restart__zcode-bridge__zcode_agent', tool_use_id: 'u3', prompt: 'x' } as never)
  expect(JSON.stringify(failed)).toContain('boom')
  expect((failed as { deny?: string }).deny).toBeDefined()
})

test('call_tool lists a late server\'s tools with schemas, and calls one at once', async ($, on) => {
  await startSession($, on, [READY, TOOLS], f =>
    f.url.includes('/tools?server=zcode-bridge')
      ? ok({ ok: true, state: 'running', error: null, tools: TOOLS.tools })
      : f.url.endsWith('/call')
        ? ok({ done: true, result: { content: [{ type: 'text', text: 'called' }] } })
        : ok({}),
  )

  const listed = await $.tool.call({ tool: 'mcp__mcp-restart__call_tool', tool_use_id: 'u4', server: 'zcode-bridge' } as never)
  const text = (listed as { result: string }).result
  expect(text).toContain('zcode_agent (mcp__mcp-restart__zcode-bridge__zcode_agent)')
  expect(text).toContain('"required":["prompt"]')

  const called = await $.tool.call({ tool: 'mcp__mcp-restart__call_tool', tool_use_id: 'u5', server: 'zcode-bridge', tool_name: 'zcode_models', arguments: {} } as never)
  expect(JSON.stringify(called)).toContain('called')
})

test('an argument named like a reserved key (tool) is offered renamed and reaches the server under its own name', async ($, on) => {
  const odd = {
    ...TOOLS,
    server: 'odd',
    tools: [{ name: 'run', description: 'Runs a tool.', inputSchema: { type: 'object', properties: { tool: { type: 'string' }, consent: { type: 'boolean' } }, required: ['tool'] } }],
  }
  const s = await startSession($, on, [READY, odd], () => ok({ done: true, result: { content: [{ type: 'text', text: 'ran' }] } }))

  const declared = s.registered.find(r => r.name === 'odd__run')
  expect(declared?.inputSchema).toEqual({ type: 'object', properties: { tool_arg: { type: 'string' }, consent_arg: { type: 'boolean' } }, required: ['tool_arg'] })
  expect(declared?.description).toContain('tool_arg is its "tool"')

  await $.tool.call({ tool: 'mcp__mcp-restart__odd__run', tool_use_id: 'u9', tool_arg: 'grep', consent_arg: true } as never)
  const body = JSON.parse(s.fetched.find(f => f.url.endsWith('/call'))?.init?.body ?? '{}')
  expect(body.arguments).toEqual({ tool: 'grep', consent: true })
})

test('restart_server sends a late server to the host and the others to the CLI', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'Restarted rea (generation 4, 0.3 s): 229 tools, unchanged. Available to the model now.\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const s = await startSession($, on, [READY, TOOLS], f =>
    f.url.endsWith('/restart') ? ok({ ok: true, results: [{ name: 'zcode-bridge', ok: true, tools: 2, generation: 2, ms: 900 }] }) : ok({}),
  )

  const result = await $.tool.call({ tool: 'mcp__mcp-restart__restart_server', tool_use_id: 'u6', name: 'zcode-bridge,rea' } as never)
  const text = JSON.stringify(result)
  expect(text).toContain('Restarted rea')
  expect(text).toContain('Restarted zcode-bridge (added mid-session, generation 2')
  expect(runs[0]?.slice(2)).toEqual(['restart', 'rea'])
  expect(JSON.parse(s.fetched.find(f => f.url.endsWith('/restart'))?.init?.body ?? '{}')).toEqual({ names: ['zcode-bridge'] })
})

test('list_servers adds the servers added mid-session after the CLI\'s list', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Session pid 9: 1 stdio servers running\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await startSession($, on, [READY, TOOLS, { type: 'error', server: 'broken', message: 'it exited while starting (code 1)\ntrace', kept: false }], () => ok({}))

  const result = JSON.stringify(await $.tool.call({ tool: 'mcp__mcp-restart__list_servers', tool_use_id: 'u7' } as never))
  expect(result).toContain('Session pid 9')
  expect(result).toContain('Added after this session started')
  expect(result).toMatch(/zcode-bridge +user +running, 2 tools, generation 1/)
  expect(result).toContain('broken')
  expect(result).toContain('failed: it exited while starting (code 1)')
})

test('a tool name past 64 characters in all is cut and made unique with a hash', async ($, on) => {
  const long = { ...TOOLS, server: 'a-server-with-a-rather-long-name', tools: [{ name: 'and_a_tool_whose_name_is_long_as_well', description: 'x', inputSchema: { type: 'object' } }] }
  const s = await startSession($, on, [READY, long], () => ok({ done: true, result: { content: [{ type: 'text', text: 'reached' }] } }))

  const name = s.registered.find(r => r.description.includes('a-server-with'))?.name ?? ''
  expect(`mcp__mcp-restart__${name}`.length).toBe(64)
  expect(name).toMatch(/^a-server-with-a-rather-long-name__[a-z0-9_]*_[0-9a-z]{7}$/)
  expect(JSON.stringify(await $.tool.call({ tool: `mcp__mcp-restart__${name}`, tool_use_id: 'u8' } as never))).toContain('reached')
})

test('a tool of a server removed from the config says so instead of failing unanswered', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Session pid 9\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await startSession($, on, [READY, TOOLS, { type: 'gone', server: 'zcode-bridge' }], () => ok({ done: true, result: { content: [] } }))

  const result = (await $.tool.call({ tool: 'mcp__mcp-restart__zcode-bridge__zcode_models', tool_use_id: 'u10' } as never)) as { deny?: string }
  expect(result.deny).toContain('is no longer offered')
  // mcp-restart's own tools are not taken for late ones
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__mcp-restart__list_servers', tool_use_id: 'u11' } as never))).toContain('Session pid 9')
})

test('the pane lists servers added mid-session with a Restart each', async ($, on) => {
  const PANE = { plugin: 'mcp-restart', component: 'Pane', requestId: 'mcp-servers', props: { title: 'MCP servers', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
  const late = { baseline: ['rea'], reason: 'test', hostError: null, servers: [{ name: 'zcode-bridge', scope: 'user', state: 'running', tools: ['zcode_models', 'zcode_agent'], generation: 1, error: null }] }
  on('state.get', (_, e, next) => (e.key === 'late' ? { value: { value: { shape: 'late-1', value: late }, version: 1 } } : next(e)))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'restart-late-zcode-bridge' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^user, running/ }))?.text).toBe('user, running, 2 tools as mcp__mcp-restart__zcode-bridge__<tool>, generation 1')
    await ui.unmount()
  }
})
