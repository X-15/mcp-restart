import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { LateServerRow, LateView, ModelCall, PaneView, ServerRow } from '../types'

// The work is done by the CLI beside this mod (cli.mjs, lib.mjs, proxy.mjs). Started through
// $.process.run it is a descendant of this session's claude.exe, so "this session" is the one it acts on.
// A wrapped server (its config runs proxy.mjs) is swapped by its proxy: the new version starts, takes over
// once it answers, and the session reads its tools again; a broken new version leaves the old one serving.
// A server that is not wrapped is stopped; Claude Code starts it on its next call, tool list unchanged.
const PANE = 'mcp-servers'
const TITLE = 'MCP servers'
const HUNG_MS = 60000 // a model's MCP call running this long gets a restart offer above the prompt
const FORCE_OFFER_MS = 10000 // a server call running this long gets a Force restart button in the pane

// Change a tag when its value's fields change: it declines what an earlier version stored.
const view = atom(
  { plugin: 'mcp-restart', key: 'view' } as const,
  { servers: [], stopped: [], session: null, checkedAt: null, busy: null, message: null } as PaneView,
  { shape: 'view-2' },
)
const calls = atom({ plugin: 'mcp-restart', key: 'calls' } as const, [] as ModelCall[], { shape: 'calls-1' })
const tick = atom({ plugin: 'mcp-restart', key: 'tick' } as const, 0)
const lateView = atom(
  { plugin: 'mcp-restart', key: 'late' } as const,
  { baseline: null, reason: null, servers: [], hostError: null } as LateView,
  { shape: 'late-1' },
)

type CliList = { sessions: { pid: number; version: string | null; isOwn: boolean; servers: ServerRow[] }[] }
type CliRestart = { results: (ServerRow & { mode: 'swap' | 'stop'; ok: boolean })[]; missing: string[]; text: string }
type CliRewrap = { changes: { name: string; where: string; ok: boolean; error?: string; skipped?: string }[]; backups: string[] }

async function cli<T>($: EngineInterface, args: string[], timeoutMs = 60000): Promise<T> {
  const { exitCode, stdout, stderr } = await $.process.run(['node', `${$.plugin.root}\\cli.mjs`, ...args, '--json'], { timeoutMs })
  if (stdout.trim() === '') throw new Error(stderr.trim() || `mcp-restart exited with ${exitCode}`)
  return JSON.parse(stdout) as T
}

// the CLI's text output, for the model's tools
async function cliText($: EngineInterface, args: string[], timeoutMs = 60000): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(['node', `${$.plugin.root}\\cli.mjs`, ...args], { timeoutMs })
  return stdout.trim() || stderr.trim() || `mcp-restart exited with ${exitCode}`
}

// ------------------------------------------------------------------ servers added mid-session
//
// A session reads its MCP config once, at its start. late-host.mjs, started here for the session's life,
// runs every user- or local-scope server added after that, and reports each one's tools; this mod declares
// them as its own tools (mcp__mcp-restart__<server>__<tool>, usable from the next prompt on, or at once
// through call_tool) and forwards the model's calls to the host's loopback HTTP endpoint.
const PREFIX = 'mcp__mcp-restart__'
const MAX_TOOL_NAME = 64
const WAIT_MS = 25000 // one HTTP answer waits this long for a call; a longer call is fetched again by id

// renamed: the argument names offered to the model in place of reserved ones, to the server's own names
type LateTool = { server: string; tool: string; renamed: Record<string, string> }
type HostTool = { name: string; description: string; inputSchema: Record<string, unknown> }
type HostEvent =
  | { type: 'ready'; url: string; token: string }
  | { type: 'baseline'; names: string[]; reason: string }
  | { type: 'tools'; server: string; scope: string; generation: number; tools: HostTool[] }
  | { type: 'state'; server: string; state: string; error: string | null }
  | { type: 'error'; server: string; message: string; kept: boolean }
  | { type: 'gone'; server: string }
type McpBlock = { type: string; text?: string; mimeType?: string; uri?: string; resource?: { uri?: string; text?: string } }
type McpResult = { content?: McpBlock[]; isError?: boolean; structuredContent?: unknown }
type CallAnswer = { done: true; result?: McpResult; error?: string } | { done: false; id: string }
type HostRestart = { ok: boolean; results: { name: string; ok: boolean; error?: string; kept?: boolean; tools?: number; generation?: number; ms?: number }[] }

// the host of this module's life; a reload starts a new one
let host: { url: string; token: string } | undefined
const lateTools = new Map<string, LateTool>() // full tool name -> the server's tool

const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')
const shortHash = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(36).padStart(7, '0').slice(-7)
}
// <server>__<tool>, cut with a hash of the whole when mcp__mcp-restart__ and it pass 64 characters
const lateToolName = (server: string, tool: string): string => {
  const short = `${clean(server)}__${clean(tool)}`
  const room = MAX_TOOL_NAME - PREFIX.length
  return short.length <= room ? short : `${short.slice(0, room - 8)}_${shortHash(short)}`
}

// A tool call reaches a hook as { tool, tool_use_id, consent, ...arguments }: an argument of one of those
// names would be overwritten by the call's own. Such an argument is offered as <name>_arg and renamed back.
const RESERVED = ['tool', 'tool_use_id', 'consent']

function declaredSchema(schema: Record<string, unknown>): { schema: Record<string, unknown>; renamed: Record<string, string> } {
  const properties = schema.properties
  if (properties === null || typeof properties !== 'object') return { schema, renamed: {} }
  const props: Record<string, unknown> = { ...(properties as Record<string, unknown>) }
  const renamed: Record<string, string> = {}
  for (const key of RESERVED) {
    if (!(key in props)) continue
    let alias = `${key}_arg`
    while (alias in props) alias += '_'
    props[alias] = props[key]
    delete props[key]
    renamed[alias] = key
  }
  if (Object.keys(renamed).length === 0) return { schema, renamed }
  const aliasOf = (name: unknown) => Object.entries(renamed).find(([, original]) => original === name)?.[0] ?? name
  const required = Array.isArray(schema.required) ? { required: schema.required.map(aliasOf) } : {}
  return { schema: { ...schema, properties: props, ...required }, renamed }
}

const restoreNames = (args: Record<string, unknown>, renamed: Record<string, string>): Record<string, unknown> => {
  const out = { ...args }
  for (const [alias, original] of Object.entries(renamed)) {
    if (!(alias in out)) continue
    out[original] = out[alias]
    delete out[alias]
  }
  return out
}

async function hostApi<T>($: EngineInterface, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  if (host === undefined) throw new Error('the host for servers added mid-session is not running')
  const { ok, status, text } = await $.http.fetch(`${host.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = JSON.parse(text) as T & { error?: string }
  if (!ok) throw new Error(parsed.error ?? `the host answered HTTP ${status}`)
  return parsed
}

// what the model reads of an MCP result: its text; other blocks named, not shown
const blockText = (block: McpBlock): string =>
  block.type === 'text'
    ? (block.text ?? '')
    : block.type === 'resource'
      ? (block.resource?.text ?? `[resource ${block.resource?.uri ?? ''}]`)
      : block.type === 'resource_link'
        ? `[resource link ${block.uri ?? ''}]`
        : `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ''}: not shown through mcp-restart; a new session connects this server and shows it]`

const resultText = (result: McpResult | undefined): string => {
  const parts = (result?.content ?? []).map(blockText).filter(text => text !== '')
  if (parts.length === 0 && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  return parts.length > 0 ? parts.join('\n') : '(the tool returned no content)'
}

async function callLate($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  try {
    let answer = await hostApi<CallAnswer>($, 'POST', '/call', { server, tool, arguments: args, waitMs: WAIT_MS })
    while (!answer.done) answer = await hostApi<CallAnswer>($, 'GET', `/result?id=${encodeURIComponent(answer.id)}&waitMs=${WAIT_MS}`)
    if (answer.error !== undefined) return { deny: `${server}: ${answer.error}` }
    const text = resultText(answer.result)
    return answer.result?.isError === true ? { deny: text } : { result: text }
  } catch (error) {
    return { deny: `mcp-restart could not reach ${server}: ${(error as Error).message}` }
  }
}

// the tool.call input less the keys the engine adds: the tool's own arguments
const argsOf = (e: ToolInput): Record<string, unknown> => {
  const { tool: _tool, tool_use_id: _id, consent: _consent, ...args } = e as Record<string, unknown>
  return args
}

const upsertRow = (rows: LateServerRow[], name: string, change: Partial<LateServerRow>): LateServerRow[] => {
  const row = rows.find(r => r.name === name) ?? { name, scope: '?', state: 'starting', tools: [], generation: 0, error: null }
  return [...rows.filter(r => r.name !== name), { ...row, ...change }].sort((a, b) => a.name.localeCompare(b.name))
}

async function onHostEvent($: EngineInterface, event: HostEvent): Promise<void> {
  switch (event.type) {
    case 'ready':
      host = { url: event.url, token: event.token }
      await update($, lateView, v => ({ ...v, hostError: null }))
      return
    case 'baseline':
      await update($, lateView, v => (v.baseline === null ? { ...v, baseline: event.names, reason: event.reason } : v))
      return
    case 'tools': {
      for (const tool of event.tools) {
        const name = lateToolName(event.server, tool.name)
        const { schema, renamed } = declaredSchema(tool.inputSchema)
        const aliases = Object.entries(renamed).map(([alias, original]) => `${alias} is its "${original}"`)
        await $.tool.register({
          name,
          description:
            `[${event.server}, an MCP server added after this session started; mcp-restart runs it] ${tool.description}` +
            (aliases.length > 0 ? ` (argument ${aliases.join(', ')})` : ''),
          inputSchema: schema,
        })
        lateTools.set(`${PREFIX}${name}`, { server: event.server, tool: tool.name, renamed })
      }
      const offered = new Set(event.tools.map(t => t.name))
      for (const [full, late] of lateTools) if (late.server === event.server && !offered.has(late.tool)) lateTools.delete(full)
      await update($, lateView, v => ({
        ...v,
        servers: upsertRow(v.servers, event.server, { scope: event.scope, state: 'running', tools: [...offered], generation: event.generation, error: null }),
      }))
      if (event.generation === 1)
        $.ui.toast(`${event.server} (added after this session started): ${event.tools.length} tools, as ${PREFIX}${clean(event.server)}__<tool> from the next prompt on`)
      return
    }
    case 'state':
      await update($, lateView, v => ({ ...v, servers: upsertRow(v.servers, event.server, { state: event.state, error: event.error }) }))
      return
    case 'error':
      await update($, lateView, v => ({ ...v, servers: upsertRow(v.servers, event.server, { state: event.kept ? 'running' : 'failed', error: event.message }) }))
      $.ui.toast(`${event.server} did not start${event.kept ? ' (the running version keeps serving)' : ''}: ${event.message.split('\n')[0]}`)
      return
    case 'gone':
      for (const [full, late] of lateTools) if (late.server === event.server) lateTools.delete(full)
      await update($, lateView, v => ({ ...v, servers: v.servers.filter(r => r.name !== event.server) }))
      return
  }
}

// the late tool a full tool name stands for: the module's map, or, after a reload before the new host has
// reported, the rows the session kept
async function lateToolOf($: EngineInterface, full: string): Promise<LateTool | undefined> {
  if (!full.startsWith(PREFIX)) return undefined
  const known = lateTools.get(full)
  if (known !== undefined) return known
  for (const row of (await read($, lateView)).servers) {
    for (const tool of row.tools) if (`${PREFIX}${lateToolName(row.name, tool)}` === full) return { server: row.name, tool, renamed: {} }
  }
  return undefined
}

// The host, for the module's life: the loop is the child's life (a reload or the session's end ends both).
async function runLateHost($: EngineInterface): Promise<void> {
  const stored = await read($, lateView)
  let visible: string[] = []
  try {
    const seen = (await $.tool.list()).filter(t => t.mcp).map(t => serverOf(t.name))
    visible = [...new Set(seen.filter((s): s is string => s !== null && s !== 'mcp-restart'))]
  } catch {
    // no list: a session this young started everything configured anyway
  }
  let buffer = ''
  try {
    const child = $.process.spawn({ argv: ['node', `${$.plugin.root}\\late-host.mjs`], input: JSON.stringify({ baseline: stored.baseline, visible }) })
    for await (const piece of child) {
      if (piece.stream !== 'stdout') {
        $.ui.log(piece.text.trimEnd(), { to: 'debug' })
        continue
      }
      buffer += piece.text
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line !== '') await onHostEvent($, JSON.parse(line) as HostEvent).catch(error => $.ui.log(`mcp-restart: ${(error as Error).message}`, { to: 'debug' }))
      }
    }
    await update($, lateView, v => ({ ...v, hostError: 'the host exited' }))
  } catch (error) {
    // the session (or this module) is ending: its state may be gone already
    await update($, lateView, v => ({ ...v, hostError: (error as Error).message })).catch(() => undefined)
  } finally {
    host = undefined
  }
}

const lateNames = async ($: EngineInterface): Promise<string[]> => (await read($, lateView)).servers.map(r => r.name)

// the names in a restart spec that are late servers, and the rest for the CLI ("all" goes to both)
async function splitSpec($: EngineInterface, spec: string): Promise<{ late: string[]; rest: string[] }> {
  const names = spec.split(',').map(s => s.trim()).filter(Boolean)
  const known = await lateNames($)
  const isLate = (n: string) => known.some(k => k.toLowerCase() === n.toLowerCase())
  const late = names.some(n => n.toLowerCase() === 'all') ? known : known.filter(isLate).filter(k => names.some(n => n.toLowerCase() === k.toLowerCase()))
  return { late, rest: names.filter(n => !isLate(n)) }
}

async function restartLate($: EngineInterface, names: string[]): Promise<string> {
  try {
    const outcome = await hostApi<HostRestart>($, 'POST', '/restart', { names })
    return outcome.results
      .map(r =>
        r.ok
          ? `Restarted ${r.name} (added mid-session, generation ${r.generation ?? '?'}, ${((r.ms ?? 0) / 1000).toFixed(1)} s): ${r.tools ?? '?'} tools, offered again from the next prompt on.`
          : `${r.name} did NOT restart: ${(r.error ?? 'failed').split('\n')[0]}.${r.kept ? ' The running version keeps serving.' : ''}`,
      )
      .join('\n')
  } catch (error) {
    return `mcp-restart could not restart ${names.join(', ')}: ${(error as Error).message}`
  }
}

async function lateText($: EngineInterface): Promise<string> {
  const v = await read($, lateView)
  if (v.servers.length === 0) return v.hostError !== null ? `\n\nServers added mid-session are not served: ${v.hostError}` : ''
  const rows = v.servers.map(
    s => `  ${s.name.padEnd(22)} ${s.scope.padEnd(13)} ${s.state}${s.state === 'running' ? `, ${s.tools.length} tools, generation ${s.generation}` : ''}${s.error !== null ? `: ${s.error.split('\n')[0]}` : ''}`,
  )
  return [
    '',
    '',
    `Added after this session started, run by mcp-restart for it: tools ${PREFIX}<server>__<tool> from the next prompt on, or call_tool {server, tool_name, arguments} at once:`,
    ...rows,
  ].join('\n')
}

async function refresh($: EngineInterface): Promise<void> {
  const list = await cli<CliList>($, ['list'])
  const own = list.sessions.find(s => s.isOwn) ?? list.sessions[0]
  const servers = own?.servers ?? []
  const running = new Set(servers.map(s => s.name))
  await update($, view, v => ({
    ...v,
    servers,
    stopped: v.stopped.filter(name => !running.has(name)),
    session: own ? `Claude Code ${own.version ?? '?'}, session pid ${own.pid}` : 'No Claude Code session found above this mod',
    checkedAt: new Date().toISOString(),
  }))
}

async function restartServers($: EngineInterface, spec: string, force: boolean): Promise<string> {
  if ((await read($, view)).busy !== null) return 'A restart is already running.'
  await update($, view, v => ({ ...v, busy: spec, message: `Restarting ${spec}${force ? ' (interrupting its calls)' : ''}...` }))
  const messages: string[] = []
  try {
    const { late, rest } = await splitSpec($, spec)
    if (rest.length > 0) {
      // a swap lasts as long as the new version takes to start
      const outcome = await cli<CliRestart>($, ['restart', rest.join(','), ...(force ? ['--force'] : [])], 600000)
      messages.push(outcome.text)
      const stopped = outcome.results.filter(r => r.mode === 'stop' && r.ok).map(r => r.name)
      await update($, view, v => ({ ...v, stopped: [...new Set([...v.stopped, ...stopped])] }))
    }
    if (late.length > 0) messages.push(await restartLate($, late))
    await refresh($)
  } catch (error) {
    messages.push(`mcp-restart failed: ${(error as Error).message}`)
  }
  const message = messages.join('\n') || `Nothing matched "${spec}": no server was restarted.`
  await update($, view, v => ({ ...v, busy: null, message }))
  $.ui.toast(message.split('\n')[0] ?? message)
  return message
}

async function rewrapServers($: EngineInterface, verb: 'wrap' | 'unwrap', spec: string): Promise<string> {
  try {
    const outcome = await cli<CliRewrap>($, [verb, spec], 300000)
    const done = outcome.changes.filter(c => c.ok && !c.skipped).map(c => `${c.name} (${c.where})`)
    const left = outcome.changes.filter(c => c.skipped).map(c => `${c.name}: ${c.skipped}`)
    const failed = outcome.changes.filter(c => !c.ok).map(c => `${c.name}: ${c.error ?? 'failed'}`)
    return [
      done.length > 0 ? `${verb === 'wrap' ? 'Wrapped' : 'Unwrapped'} ${done.join(', ')}. New sessions start them this way.` : `Nothing to ${verb} for "${spec}".`,
      left.length > 0 ? `Left alone: ${left.join('; ')}` : '',
      failed.length > 0 ? `Failed: ${failed.join('; ')}` : '',
      outcome.backups.length > 0 ? `Backups: ${outcome.backups.join(', ')}` : '',
    ].filter(Boolean).join('\n')
  } catch (error) {
    return `mcp-restart ${verb} failed: ${(error as Error).message}`
  }
}

// the model's tools: the CLI's text, so the model reads what a person reads
type ToolInput = { readonly [field: string]: unknown }

async function restartTool($: EngineInterface, input: ToolInput): Promise<string> {
  if (typeof input.name !== 'string' || input.name.trim() === '') return 'name is required: a server name, several separated by commas, "stale" or "all".'
  const { late, rest } = await splitSpec($, input.name.trim())
  const parts: string[] = []
  if (rest.length > 0) parts.push(await cliText($, ['restart', rest.join(','), ...(input.force === true ? ['--force'] : []), ...(input.all_sessions === true ? ['--all'] : [])], 600000))
  if (late.length > 0) parts.push(await restartLate($, late))
  return parts.join('\n')
}

async function listTool($: EngineInterface, input: ToolInput): Promise<string> {
  return (await cliText($, ['list', ...(input.all_sessions === true ? ['--all'] : [])])) + (await lateText($))
}

// call_tool: a late server's tool by name, at once (its own tool name is offered from the next prompt on)
async function callTool($: EngineInterface, input: ToolInput): Promise<{ result: string } | { deny: string }> {
  const server = typeof input.server === 'string' ? input.server.trim() : ''
  if (server === '') return { deny: 'server is required: the name of an MCP server added after this session started.' }
  // tool_name, not tool: `tool` on a call's input is the name of the tool called (call_tool itself)
  if (typeof input.tool_name === 'string' && input.tool_name.trim() !== '') {
    const args = input.arguments !== null && typeof input.arguments === 'object' ? (input.arguments as Record<string, unknown>) : {}
    return callLate($, server, input.tool_name.trim(), args)
  }
  try {
    const found = await hostApi<{ tools: HostTool[]; state: string; error: string | null }>($, 'GET', `/tools?server=${encodeURIComponent(server)}`)
    const rows = found.tools.map(t => `- ${t.name} (${PREFIX}${lateToolName(server, t.name)}): ${t.description}\n  input: ${JSON.stringify(t.inputSchema)}`)
    return { result: [`${server} (${found.state}${found.error !== null ? `: ${found.error.split('\n')[0]}` : ''}): ${found.tools.length} tools`, ...rows].join('\n') }
  } catch (error) {
    return { deny: `${server}: ${(error as Error).message}` }
  }
}

// mcp__<server>__<tool>: the server's config name
const serverOf = (tool: string): string | null => tool.match(/^mcp__(.+?)__/)?.[1] ?? null

// keeps the band's durations moving while the model waits on an MCP call
async function beat($: EngineInterface): Promise<void> {
  await update($, tick, n => n + 1)
}

const press = (work: () => Promise<unknown>) => () => {
  void work().catch(() => undefined)
}

const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(s / 3600).toFixed(1)}h`
}

const uptime = (started: string | null, checkedAt: string | null): string =>
  started && checkedAt ? duration(Date.parse(checkedAt) - Date.parse(started)) : '?'

const mode = (s: ServerRow): string => (s.live ? `hot-swap, generation ${s.generation ?? '?'}` : s.wrapped ? 'wrapped from the next session on' : 'stop only')

const ALL_SESSIONS = { type: 'boolean', description: 'Act on every running Claude Code session instead of only this one. Default false.' }

export const register: Register = on => {
  let beating: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mcp-restart',
      description: 'Restart MCP servers of this session (no argument: open the MCP servers pane); wrap/unwrap servers in the restart proxy',
      argumentHint: '[name[,name...] | stale | all] [--force] | wrap <names|all> | unwrap <names|all>',
    })
    await $.tool.register({
      name: 'restart_server',
      description:
        'Restart stdio MCP servers of this Claude Code session so they run their current code. Call it on your own, without asking: ' +
        'after installing, updating or rebuilding anything an MCP server runs (name "stale"), and when a server\'s calls fail or hang ' +
        '(that server by name, force true for a hang; then retry the call once). A wrapped ("hot-swap") server is swapped safely: the ' +
        'new version starts, takes over once it answers, and its new or changed tools are available to you right after this returns; ' +
        'if the new version does not start, the old one keeps serving: report the error instead of retrying. A server that is not ' +
        'wrapped ("stop only") is stopped and starts again on its next call, with the tool list of the session start. Wait for this ' +
        'result before calling the restarted server, never in the same parallel batch.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Server name as configured (e.g. "github"), several separated by commas, "stale" (files changed after it started) or "all".' },
          force: { type: 'boolean', description: 'Interrupt the calls the server is running (they fail with an error) instead of letting the old version finish them. For a hung server. Default false.' },
          all_sessions: ALL_SESSIONS,
        },
        required: ['name'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list_servers',
      description:
        'List the stdio MCP servers this Claude Code session runs: name, config scope, uptime, hot-swap (wrapped) or stop only, ' +
        'calls in flight, and whether their files changed since they started ("STALE": an update waits for a restart). Also lists ' +
        'the servers added to the config after this session started, which mcp-restart runs for it: their tools are ' +
        'mcp__mcp-restart__<server>__<tool> from the next prompt on, and call_tool reaches them at once.',
      inputSchema: { type: 'object', properties: { all_sessions: ALL_SESSIONS } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'call_tool',
      description:
        'Call a tool of an MCP server added to the config (claude mcp add) after this session started, which mcp-restart runs ' +
        'for this session. Works in the same turn the server was added; from the next prompt on its tools are also offered by name, ' +
        'mcp__mcp-restart__<server>__<tool>. Leave out tool_name to list the server\'s tools with their input schemas.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'The server name as configured.' },
          tool_name: { type: 'string', description: "The tool's name on that server. Leave out to list its tools." },
          arguments: { type: 'object', description: "The tool's arguments, as its input schema names them." },
        },
        required: ['server'],
      },
    })

    const started = await next(e)
    void runLateHost($).catch(() => undefined)
    return started
  })

  on('tool.call', { tool: 'mcp__mcp-restart__call_tool' }, async ($, e) => callTool($, e)).catch(() => ({
    deny: 'mcp-restart: the call failed to run',
  }))

  on('tool.call', { tool: 'mcp__mcp-restart__restart_server' }, async ($, e) => ({ result: await restartTool($, e) })).catch(() => ({
    deny: 'mcp-restart: the restart failed to run',
  }))

  on('tool.call', { tool: 'mcp__mcp-restart__list_servers' }, async ($, e) => ({ result: await listTool($, e) })).catch(() => ({
    deny: 'mcp-restart: listing the servers failed',
  }))

  on('command.run', { command: 'mcp-restart' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      await refresh($).catch(error => update($, view, v => ({ ...v, message: `mcp-restart failed: ${(error as Error).message}` })))
      await $.ui.open({ id: PANE, title: TITLE })

      return { text: 'MCP servers pane opened.' }
    }
    if (words[0] === 'wrap' || words[0] === 'unwrap') return { text: await rewrapServers($, words[0], words[1] ?? '') }
    const force = words.includes('--force')
    const spec = words.filter(w => w !== '--force').join(',')

    return { text: await restartServers($, spec, force) }
  })

  // A late server's tool, served through the host; and the hang watchdog over every MCP call (the model
  // cannot restart a server while it waits on that server's call).
  on('tool.call', async ($, e, next) => {
    const late = await lateToolOf($, e.tool)
    // a tool name stays registered for the session (there is no unregister): say why it no longer answers
    if (late === undefined && e.tool.startsWith(PREFIX) && e.tool.slice(PREFIX.length).includes('__'))
      return {
        deny:
          `${e.tool} is no longer offered: its server, added after this session started, was removed from the config or restarted ` +
          'without this tool. list_servers shows what runs now; call_tool {server} lists its tools.',
      }
    const server = late?.server ?? serverOf(e.tool)
    if (server === null || (server === 'mcp-restart' && late === undefined)) return next(e)
    const call: ModelCall = { id: e.tool_use_id, tool: e.tool, server, since: Date.now() }
    await update($, calls, list => [...list.filter(c => c.id !== call.id), call].slice(-50))
    beating ??= $.clock.every(5000, () => void beat($))
    try {
      return late !== undefined ? await callLate($, late.server, late.tool, restoreNames(argsOf(e), late.renamed)) : await next(e)
    } finally {
      const left = await update($, calls, list => list.filter(c => c.id !== call.id))
      if (left.length === 0) {
        beating?.cancel()
        beating = undefined
      }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)
    const hung = (await read($, calls)).filter(c => Date.now() - c.since >= HUNG_MS)
    const first = hung[0]
    if (first === undefined || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text color="warning">
          {first.tool} has been running {duration(Date.now() - first.since)}
          {hung.length > 1 ? ` (and ${hung.length - 1} more)` : ''}
        </Text>
        <Button key="restart-hung" label={`Restart ${first.server} (interrupts the call)`} onPress={press(() => restartServers($, first.server, true))} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const added = await read($, lateView)
    const staleCount = v.servers.filter(s => s.stale === true).length
    const unwrapped = v.servers.filter(s => !s.wrapped).map(s => s.name)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="refresh" label="Refresh" onPress={press(() => refresh($))} />
          {staleCount > 0 && (
            <Button key="restart-stale" variant="primary" label={`Restart stale (${staleCount})`} onPress={press(() => restartServers($, 'stale', false))} />
          )}
          <Button key="restart-all" label="Restart all" onPress={press(() => restartServers($, 'all', false))} />
        </Box>
        {v.session !== null && <Text dimColor size="caption">{v.session}</Text>}
        {v.servers.map(s => {
          const slow = s.inflight.filter(c => c.ms >= FORCE_OFFER_MS)
          return (
            <Box key={`row-${s.name}`} flexDirection="row" justifyContent="space-between" gap={1}>
              <Box flexDirection="column" flexShrink={1}>
                <Text weight="semibold">{s.name}</Text>
                <Text dimColor size="caption">
                  {s.scope}, {mode(s)}, up {uptime(s.started, v.checkedAt)}
                </Text>
                {s.stale === true && (
                  <Text color="warning" size="caption">
                    stale: {s.changed} changed after it started
                  </Text>
                )}
                {s.inflight.map(c => (
                  <Text size="caption">
                    running {c.tool ?? c.method} for {duration(c.ms)}
                  </Text>
                ))}
                {s.state !== null && s.state !== 'running' && (
                  <Text color="warning" size="caption">
                    {s.state}
                    {s.lastError !== null ? `: ${s.lastError}` : ''}
                  </Text>
                )}
              </Box>
              <Box flexDirection="column" gap={1}>
                <Button key={`restart-${s.name}`} label="Restart" onPress={press(() => restartServers($, s.name, false))} />
                {slow.length > 0 && <Button key={`force-${s.name}`} label="Force restart" onPress={press(() => restartServers($, s.name, true))} />}
              </Box>
            </Box>
          )
        })}
        {added.servers.length > 0 && <Text weight="semibold">Added after this session started (mcp-restart runs them)</Text>}
        {added.servers.map(s => (
          <Box key={`late-row-${s.name}`} flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexDirection="column" flexShrink={1}>
              <Text weight="semibold">{s.name}</Text>
              <Text dimColor size="caption">
                {s.scope}, {s.state}
                {s.state === 'running' ? `, ${s.tools.length} tools as ${PREFIX}${clean(s.name)}__<tool>, generation ${s.generation}` : ''}
              </Text>
              {s.error !== null && (
                <Text color="warning" size="caption">
                  {s.error.split('\n')[0]}
                </Text>
              )}
            </Box>
            <Button key={`restart-late-${s.name}`} label="Restart" onPress={press(() => restartServers($, s.name, false))} />
          </Box>
        ))}
        {added.hostError !== null && (
          <Text color="warning" size="caption">
            Servers added mid-session are not served: {added.hostError}
          </Text>
        )}
        {v.stopped.length > 0 && <Text dimColor>Stopped, starting on the next call: {v.stopped.join(', ')}</Text>}
        {v.busy !== null && <Text>Restarting {v.busy}...</Text>}
        {v.busy === null && v.message !== null && <Text dimColor>{v.message}</Text>}
        <Text dimColor size="caption">
          Hot-swap servers restart safely and their new tools reach the model at once. Stop-only servers start again on their next call, with
          the tool list of the session start. A server added to the config after the session started runs here too, its tools offered from the
          next prompt on.
          {unwrapped.length > 0 ? ` To hot-swap them from the next session on: /mcp-restart wrap ${unwrapped.join(',')}` : ''}
        </Text>
      </Box>
    )
  })
}
