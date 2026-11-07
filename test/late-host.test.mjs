#!/usr/bin/env node
// Drives late-host.mjs as the mod does: its stdin once, its stdout events, its loopback HTTP API. The
// config is a temporary ~/.claude.json (MCP_RESTART_CLAUDE_JSON) that the test edits the way `claude mcp
// add` would; the servers are fixture-server.mjs. Each step prints PASS or FAIL; the exit code is the
// number of failures.
//   node test/late-host.test.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = mkdtempSync(join(tmpdir(), 'mcp-restart-late-'))
const WORK = join(DIR, 'work')
const CLAUDE_JSON = join(DIR, 'claude.json')
const STATE = join(DIR, 'fixture-state.json')
const FIXTURE = join(HERE, 'fixture-server.mjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const setFixture = state => writeFileSync(STATE, JSON.stringify({ slowStartMs: 0, crashOnStart: false, ...state }))
const fixture = (extra = {}) => ({ type: 'stdio', command: 'node', args: [FIXTURE], env: { MCP_FIXTURE_STATE: STATE }, ...extra })
const writeConfig = config => writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2))

let failures = 0
async function step(name, fn) {
  try {
    const detail = await fn()
    console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${error.message}`)
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

// a host with its events collected; waitFor resolves on the first matching event from `from` on
function startHost(input) {
  rmSync(WORK, { recursive: true, force: true })
  writeFileSync(join(DIR, '.keep'), '')
  const proc = spawn(process.execPath, [join(HERE, '..', 'late-host.mjs')], {
    cwd: DIR,
    env: { ...process.env, MCP_RESTART_CLAUDE_JSON: CLAUDE_JSON, MCP_RESTART_LATE_POLL_MS: '150' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const host = { proc, events: [], stderr: '', url: undefined, token: undefined }
  proc.stderr.on('data', chunk => (host.stderr += chunk))
  createInterface({ input: proc.stdout }).on('line', line => {
    const event = JSON.parse(line)
    host.events.push(event)
    if (event.type === 'ready') Object.assign(host, { url: event.url, token: event.token })
  })
  proc.stdin.end(input === undefined ? '' : JSON.stringify(input))
  host.waitFor = async (match, from = 0, ms = 20000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
      const found = host.events.slice(from).find(match)
      if (found) return found
    }
    throw new Error(`no matching event within ${ms} ms; events: ${JSON.stringify(host.events.slice(from)).slice(0, 600)}; stderr: ${host.stderr.slice(-600)}`)
  }
  host.api = async (method, path, body, token = host.token) => {
    const response = await fetch(`${host.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { code: response.status, ...(await response.json()) }
  }
  host.call = async (server, tool, args = {}, waitMs) => {
    let answer = await host.api('POST', '/call', { server, tool, arguments: args, ...(waitMs !== undefined ? { waitMs } : {}) })
    while (answer.done === false) answer = await host.api('GET', `/result?id=${answer.id}&waitMs=5000`)
    return answer
  }
  host.stop = () => proc.kill()
  return host
}
const textOf = answer => answer.result?.content?.[0]?.text ?? JSON.stringify(answer)

// ------------------------------------------------------------------ steps

setFixture({ version: 1 })
writeConfig({ mcpServers: { native: fixture() }, projects: {} })
let host = startHost({ baseline: ['native'], visible: ['native'] })

await step('ready: a loopback URL and a token', async () => {
  const ready = await host.waitFor(e => e.type === 'ready')
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url) && ready.token.length >= 32, JSON.stringify(ready))
  return ready.url
})

await step('a server the session started (the baseline) is left alone', async () => {
  await sleep(600)
  assert(!host.events.some(e => e.server === 'native'), JSON.stringify(host.events))
  const status = await host.api('GET', '/status')
  assert(status.servers.length === 0 && status.baseline.includes('native'), JSON.stringify(status))
})

await step('a request without the token is refused', async () => {
  const answer = await host.api('GET', '/status', undefined, 'wrong')
  assert(answer.code === 401, JSON.stringify(answer))
})

let mark = host.events.length
writeConfig({ mcpServers: { native: fixture(), fx: fixture() }, projects: {} })
await step('a user-scope server added to the config starts and reports its tools', async () => {
  const tools = await host.waitFor(e => e.type === 'tools' && e.server === 'fx', mark)
  const names = tools.tools.map(t => t.name)
  assert(names.includes('whoami') && names.includes('v1_marker') && tools.scope === 'user' && tools.generation === 1, JSON.stringify(tools))
  assert(tools.tools.every(t => t.inputSchema && typeof t.description === 'string'), 'schemas and descriptions')
  return `${names.length} tools`
})

let firstPid
await step('a call reaches it and answers', async () => {
  const who = JSON.parse(textOf(await host.call('fx', 'whoami')))
  firstPid = who.pid
  assert(who.version === 1 && who.pid > 0, JSON.stringify(who))
  return `pid ${who.pid}`
})

await step('a call longer than one answer is fetched again by id', async () => {
  const first = await host.api('POST', '/call', { server: 'fx', tool: 'sleep', arguments: { ms: 1200 }, waitMs: 200 })
  assert(first.done === false && first.id, JSON.stringify(first))
  const answer = await host.call('fx', 'sleep', { ms: 10 }) // other calls go on meanwhile
  assert(textOf(answer) === 'slept 10 ms', textOf(answer))
  const later = await host.api('GET', `/result?id=${first.id}&waitMs=5000`)
  assert(later.done === true && textOf(later) === 'slept 1200 ms', JSON.stringify(later))
})

await step('the server is answered roots/list with the session folder', async () => {
  const answer = JSON.parse(textOf(await host.call('fx', 'ask_roots')))
  assert(answer.answer?.roots?.[0]?.uri === pathToFileURL(DIR).href, JSON.stringify(answer))
})

await step('an unknown server is an error naming the late ones', async () => {
  const answer = await host.call('nope', 'whoami')
  assert(answer.done && /not a server added after this session started.*fx/.test(answer.error), JSON.stringify(answer))
})

mark = host.events.length
await step('restart: the new version takes over and its new tool set is reported', async () => {
  setFixture({ version: 2 })
  const result = await host.api('POST', '/restart', { names: ['fx'] })
  assert(result.ok && result.results[0].generation === 2, JSON.stringify(result))
  const tools = await host.waitFor(e => e.type === 'tools' && e.server === 'fx' && e.generation === 2, mark)
  assert(tools.tools.some(t => t.name === 'v2_marker') && !tools.tools.some(t => t.name === 'v1_marker'), JSON.stringify(tools.tools.map(t => t.name)))
  const who = JSON.parse(textOf(await host.call('fx', 'whoami')))
  assert(who.version === 2 && who.pid !== firstPid, JSON.stringify(who))
})

await step('a restart that fails keeps the running version serving', async () => {
  setFixture({ version: 3, crashOnStart: true })
  const result = await host.api('POST', '/restart', { names: ['fx'] })
  assert(!result.ok && result.results[0].kept === true, JSON.stringify(result))
  const who = JSON.parse(textOf(await host.call('fx', 'whoami')))
  setFixture({ version: 2 })
  assert(who.version === 2, JSON.stringify(who))
})

mark = host.events.length
await step('a crash is reported, and the next call starts it again', async () => {
  await host.call('fx', 'exit', { code: 7 })
  const down = await host.waitFor(e => e.type === 'state' && e.server === 'fx' && e.state === 'down', mark)
  assert(/code 7/.test(down.error), JSON.stringify(down))
  const who = JSON.parse(textOf(await host.call('fx', 'whoami')))
  assert(who.version === 2, JSON.stringify(who))
})

mark = host.events.length
writeConfig({
  mcpServers: { native: fixture(), fx: fixture() },
  projects: { [DIR.replace(/\\/g, '/')]: { mcpServers: { loc: fixture(), off: fixture() }, disabledMcpServers: ['off'] }, 'C:/elsewhere': { mcpServers: { other: fixture() } } },
})
await step("local scope for the session's folder starts; another folder's and a disabled one do not", async () => {
  await host.waitFor(e => e.type === 'tools' && e.server === 'loc', mark)
  await sleep(500)
  const names = (await host.api('GET', '/status')).servers.map(s => s.name).sort()
  assert(JSON.stringify(names) === '["fx","loc"]', JSON.stringify(names))
  return names.join(', ')
})

mark = host.events.length
writeConfig({ mcpServers: { native: fixture() }, projects: {} })
await step('a server removed from the config is stopped and reported gone', async () => {
  await host.waitFor(e => e.type === 'gone' && e.server === 'fx', mark)
  await host.waitFor(e => e.type === 'gone' && e.server === 'loc', mark)
  const answer = await host.call('fx', 'whoami')
  assert(answer.error, JSON.stringify(answer))
})
host.stop()

// ------------------------------------------------------------------ the baseline, worked out by the host

// This test runs inside a Claude Code session started long ago: the host is "loaded mid-session", so a
// configured server counts as the session's own only when the session has tools from it or runs it.
writeConfig({ mcpServers: { seen: fixture(), unseen: fixture() }, projects: {} })
host = startHost({ visible: ['seen'] })
await step('loaded mid-session: a configured server the session has no tools from runs here', async () => {
  const event = await host.waitFor(e => e.type === 'baseline', 0, 30000)
  if (/no Claude Code session above|could not be inspected|started \d+ s ago/.test(event.reason)) return `skipped (${event.reason})`
  assert(JSON.stringify(event.names) === '["seen"]', JSON.stringify(event))
  await host.waitFor(e => e.type === 'tools' && e.server === 'unseen')
  return event.reason
})

// The engine ends the host with the session by killing it (no shutdown handler runs on Windows): its
// servers lose their stdin and end themselves, as MCP stdio servers do.
await step('a host killed outright leaves no server running', async () => {
  await host.waitFor(e => e.type === 'tools' && e.server === 'unseen')
  const pids = (await host.api('GET', '/status')).servers.map(s => s.pid).filter(Boolean)
  assert(pids.length === 1, JSON.stringify(pids))
  host.stop()
  const alive = pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (const t0 = Date.now(); Date.now() - t0 < 5000 && pids.some(alive); ) await sleep(100)
  assert(!pids.some(alive), `still running: ${pids.filter(alive).join(', ')}`)
  return `pid ${pids[0]} ended`
})
host.stop()

for (let tries = 0; tries < 20; tries++) {
  try {
    rmSync(DIR, { recursive: true, force: true })
    break
  } catch {
    await sleep(250) // a server process still closing in the folder
  }
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures)
