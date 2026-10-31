import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ModelCall, PaneView, ServerRow } from '../types'

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
  let message: string
  try {
    // a swap lasts as long as the new version takes to start
    const outcome = await cli<CliRestart>($, ['restart', spec, ...(force ? ['--force'] : [])], 600000)
    message = outcome.text
    const stopped = outcome.results.filter(r => r.mode === 'stop' && r.ok).map(r => r.name)
    await update($, view, v => ({ ...v, stopped: [...new Set([...v.stopped, ...stopped])] }))
    await refresh($)
  } catch (error) {
    message = `mcp-restart failed: ${(error as Error).message}`
  }
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
  const args = ['restart', input.name.trim(), ...(input.force === true ? ['--force'] : []), ...(input.all_sessions === true ? ['--all'] : [])]
  return cliText($, args, 600000)
}

async function listTool($: EngineInterface, input: ToolInput): Promise<string> {
  return cliText($, ['list', ...(input.all_sessions === true ? ['--all'] : [])])
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
        'calls in flight, and whether their files changed since they started ("STALE": an update waits for a restart).',
      inputSchema: { type: 'object', properties: { all_sessions: ALL_SESSIONS } },
      isDeferred: false,
    })

    return next(e)
  })

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

  // the hang watchdog: the model cannot restart a server while it waits on that server's call
  on('tool.call', async ($, e, next) => {
    const server = serverOf(e.tool)
    if (server === null || server === 'mcp-restart') return next(e)
    const call: ModelCall = { id: e.tool_use_id, tool: e.tool, server, since: Date.now() }
    await update($, calls, list => [...list.filter(c => c.id !== call.id), call].slice(-50))
    beating ??= $.clock.every(5000, () => void beat($))
    try {
      return await next(e)
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
        {v.stopped.length > 0 && <Text dimColor>Stopped, starting on the next call: {v.stopped.join(', ')}</Text>}
        {v.busy !== null && <Text>Restarting {v.busy}...</Text>}
        {v.busy === null && v.message !== null && <Text dimColor>{v.message}</Text>}
        <Text dimColor size="caption">
          Hot-swap servers restart safely and their new tools reach the model at once. Stop-only servers start again on their next call, with
          the tool list of the session start.
          {unwrapped.length > 0 ? ` To hot-swap them from the next session on: /mcp-restart wrap ${unwrapped.join(',')}` : ''}
        </Text>
      </Box>
    )
  })
}
