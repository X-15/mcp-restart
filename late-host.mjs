#!/usr/bin/env node
// mcp-restart late host: runs the MCP servers added to Claude Code's config after a session started, for
// that session, so their tools are usable without a new session.
//
// Why (Claude Code 2.1.317): a session reads its MCP config once, at its start; a server added later
// (`claude mcp add`) reaches only sessions started after it, and the desktop app has no reconnect. A mod
// can declare tools at any time ($.tool.register, from the next prompt on) but cannot speak stdio MCP
// itself ($.process.spawn writes its child's stdin once). So the mod starts this host for the session's
// life (register.tsx) and serves each late server's tools through it:
// - this host watches ~/.claude.json and runs every user- or local-scope server the session did not start
//   (the baseline), as an MCP client: initialize, tools/list, tools/call. Project .mcp.json servers wait
//   for the person's approval in a session, so they are never started here.
// - it reports on stdout, one JSON line per event, and the mod registers each tool as
//   mcp__mcp-restart__<server>__<tool>;
// - the mod forwards the model's calls to its loopback HTTP endpoint (127.0.0.1, a random port, a token).
//
// stdin (the mod's one string): {"baseline": [names] | null, "visible": [tool-name prefixes of MCP servers
//   the session has tools from]}. No baseline yet: it is worked out here and reported (event `baseline`).
// stdout events: ready {url, token}, baseline {names, reason}, tools {server, scope, generation, tools},
//   state {server, state, error}, gone {server}, error {server, message, kept}
// HTTP, every request with `Authorization: Bearer <token>`:
//   GET /status | GET /tools?server= | POST /refresh {waitMs} | POST /call {server, tool, arguments, waitMs} -> {done, result |
//   error} or {done: false, id}, then GET /result?id=&waitMs= | POST /restart {names: [..] | "all"}
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { discover, expand, innerOf, SELF_NAME } from './lib.mjs'

const VERSION = '1.0.0'
const IS_WINDOWS = process.platform === 'win32'
const CLAUDE_JSON = process.env.MCP_RESTART_CLAUDE_JSON || join(homedir(), '.claude.json')
const CWD = process.cwd()
const POLL_MS = Number(process.env.MCP_RESTART_LATE_POLL_MS) || 2000
const START_TIMEOUT_MS = 120000
const LIST_TIMEOUT_MS = 30000
const FRESH_SESSION_MS = 60000 // a session younger than this is still connecting what it was configured with
const WAIT_MS = 25000 // how long one HTTP answer waits for a call before saying "not done yet"
const PROTOCOL = '2025-06-18'

const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)
const log = (...parts) => process.stderr.write(`[mcp-restart late] ${parts.join(' ')}\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const describeExit = exit => (exit.error ? exit.error.message : exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`)
const rpcFailure = error => Object.assign(new Error(error?.message || 'error'), { rpc: error })
const fingerprint = def => JSON.stringify(def)
// the server-name part of an MCP tool's name, as Claude Code writes it (`claude.ai Gmail` -> `claude_ai_Gmail`)
const toolPrefix = name => String(name).replace(/[^a-zA-Z0-9_-]/g, '_')
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ configured servers

function readClaudeJson() {
  try {
    return JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'))
  } catch {
    return undefined // missing, or caught mid-write: the next poll reads it again
  }
}

// What a session in this folder is configured with: user scope, local scope for the folder over it (Claude
// Code's precedence), less the servers turned off for the folder, less mcp-restart itself.
function configuredServers(json, cwd = CWD) {
  const servers = new Map()
  const off = new Set()
  for (const [name, def] of Object.entries(json?.mcpServers ?? {})) if (def && typeof def === 'object') servers.set(name, { name, scope: 'user', def })
  const here = resolve(cwd).toLowerCase()
  for (const [project, settings] of Object.entries(json?.projects ?? {})) {
    if (resolve(project).toLowerCase() !== here) continue // ~/.claude.json keys a folder once per spelling of its path
    for (const [name, def] of Object.entries(settings?.mcpServers ?? {})) if (def && typeof def === 'object') servers.set(name, { name, scope: 'local', def })
    for (const name of settings?.disabledMcpServers ?? []) off.add(name)
  }
  for (const name of [...off, SELF_NAME]) servers.delete(name)
  return servers
}

// The servers this session started itself. A young session started all it was configured with. One the mod
// loaded into later (an install or /reload-plugins mid-session) started those it has tools from or runs a
// process for; anything else configured was added after it started, or failed then, and runs here.
async function workOutBaseline(configured, visible) {
  const names = [...configured.keys()]
  let found
  try {
    found = await discover()
  } catch (error) {
    return { names, reason: `the session could not be inspected (${error.message}): everything configured counts as its own` }
  }
  const own = found.own
  if (!own?.started) return { names, reason: 'no Claude Code session above this process: everything configured counts as its own' }
  const age = Date.now() - own.started.getTime()
  if (age < FRESH_SESSION_MS) return { names, sessionPid: own.pid, reason: `the session started ${Math.round(age / 1000)} s ago and connects everything configured itself` }
  const running = new Set((found.sessions.find(s => s.session.pid === own.pid)?.servers ?? []).flatMap(s => s.names))
  const seen = new Set(visible)
  const kept = names.filter(name => running.has(name) || seen.has(toolPrefix(name)))
  return { names: kept, sessionPid: own.pid, reason: `loaded ${Math.round(age / 60000)} min into the session: its own are the servers it has tools from or runs` }
}

// ------------------------------------------------------------------ stdio servers

// As Claude Code starts a stdio server on Windows: the command looked up on PATH with PATHEXT, and a .cmd or
// .bat run through cmd.exe (Node refuses to start one directly). The same as proxy.mjs, which stays one file.
function resolveCommand(command) {
  if (!IS_WINDOWS) return command
  const extensions = extname(command) ? [''] : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const dirs = isAbsolute(command) || /[\\/]/.test(command) ? [''] : ['', ...(process.env.PATH || '').split(delimiter).filter(Boolean)]
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = dir ? join(dir, command + extension) : command + extension
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // not there: the next candidate
      }
    }
  }
  return command
}

const quoteForCmd = arg => (/[\s"&|<>^()%!,;=]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

function spawnServer(command, args, env, cwd) {
  const file = resolveCommand(command)
  const options = { stdio: ['pipe', 'pipe', 'pipe'], env, cwd, windowsHide: true }
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(' ')
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true })
  }
  return spawn(file, args, options)
}

// the whole tree: npx, uvx, uv run and cmd /c start the real server as a grandchild
function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return
  if (!IS_WINDOWS) return void proc.kill('SIGKILL')
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true })
  } catch {
    // already gone
  }
}

class StdioConnection {
  constructor(def, onNotification) {
    const run = innerOf(def) // a config wrapped in the restart proxy: the server behind it
    const env = { ...process.env, ...Object.fromEntries(Object.entries(def.env ?? {}).map(([key, value]) => [key, expand(value)])) }
    this.proc = spawnServer(expand(run.command), (run.args ?? []).map(arg => expand(arg)), env, def.cwd ? resolve(CWD, expand(def.cwd)) : CWD)
    this.pid = this.proc.pid
    this.onNotification = onNotification
    this.pending = new Map()
    this.nextId = 0
    this.stderrTail = ''
    this.exit = null
    this.exited = new Promise(done => {
      const settle = exit => {
        if (this.exit) return
        this.exit = exit
        for (const waiter of this.pending.values()) waiter.reject(new Error(`the server exited (${describeExit(exit)})`))
        this.pending.clear()
        done(exit)
      }
      this.proc.once('close', (code, signal) => settle({ code, signal }))
      this.proc.once('error', error => settle({ error }))
    })
    createInterface({ input: this.proc.stdout }).on('line', line => this.onLine(line))
    this.proc.stderr.on('data', chunk => (this.stderrTail = (this.stderrTail + chunk).slice(-4000)))
    this.proc.stdin.on('error', () => {}) // a write after the server died
  }

  get alive() {
    return !this.exit
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return // not JSON-RPC: a server's stray print
    }
    if (message.method === undefined && message.id !== undefined) {
      const key = JSON.stringify(message.id)
      const waiter = this.pending.get(key)
      if (!waiter) return
      this.pending.delete(key)
      return message.error ? waiter.reject(rpcFailure(message.error)) : waiter.resolve(message.result)
    }
    if (message.method !== undefined && message.id !== undefined && message.id !== null) return this.answer(message)
    if (message.method !== undefined) this.onNotification(message)
  }

  // the server's requests to its client: roots (the session's folder) and ping; nothing to sample or elicit with
  answer(message) {
    if (message.method === 'roots/list') return this.write({ jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: pathToFileURL(CWD).href, name: basename(CWD) }] } })
    if (message.method === 'ping') return this.write({ jsonrpc: '2.0', id: message.id, result: {} })
    this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `mcp-restart does not answer ${message.method} for a server added mid-session` } })
  }

  write(message) {
    if (!this.exit) this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params, timeoutMs) {
    const id = ++this.nextId
    const key = JSON.stringify(id)
    return new Promise((resolvePromise, reject) => {
      if (this.exit) return reject(new Error(`the server is not running (${describeExit(this.exit)})`))
      const timer = timeoutMs ? setTimeout(() => this.pending.delete(key) && reject(new Error(`${method}: no answer within ${timeoutMs} ms`)), timeoutMs) : undefined
      this.pending.set(key, {
        resolve: value => (clearTimeout(timer), resolvePromise(value)),
        reject: error => (clearTimeout(timer), reject(error)),
      })
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  close() {
    killTree(this.proc)
  }
}

// ------------------------------------------------------------------ HTTP servers (streamable HTTP)

// Request and answer in one POST; the server may answer in JSON or as an event stream. No OAuth (signing in
// needs the session's own client) and no stream the server opens by itself (its list_changed is not heard).
class HttpConnection {
  constructor(def) {
    if (def.type === 'sse') throw new Error('the legacy SSE transport is not served for a server added mid-session; a new session connects it')
    this.url = expand(def.url)
    this.headers = Object.fromEntries(Object.entries(def.headers ?? {}).map(([key, value]) => [key, expand(value)]))
    this.sessionId = undefined
    this.protocol = undefined
    this.nextId = 0
    this.closed = false
    this.stderrTail = ''
    this.exited = new Promise(() => {}) // a connection, not a process
  }

  get alive() {
    return !this.closed
  }

  async post(message, timeoutMs) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.protocol ? { 'mcp-protocol-version': this.protocol } : {}),
        ...this.headers,
      },
      body: JSON.stringify(message),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId
    if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}: the server needs a sign-in, which a new session does`)
    if (!response.ok && response.status !== 202) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    if (message.id === undefined || response.status === 202) return undefined
    const text = await response.text()
    const messages = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split(/\r?\n\r?\n/)
          .map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
          .filter(Boolean)
          .flatMap(data => {
            try {
              return [JSON.parse(data)]
            } catch {
              return []
            }
          })
      : [JSON.parse(text)]
    const answer = messages.find(m => m.id === message.id)
    if (!answer) throw new Error(`the server sent no answer to ${message.method}`)
    if (answer.error) throw rpcFailure(answer.error)
    return answer.result
  }

  request(method, params, timeoutMs) {
    return this.post({ jsonrpc: '2.0', id: ++this.nextId, method, ...(params === undefined ? {} : { params }) }, timeoutMs)
  }

  notify(method, params) {
    return this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }).catch(() => {})
  }

  close() {
    this.closed = true
    if (this.sessionId) fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...this.headers } }).catch(() => {})
  }
}

// ------------------------------------------------------------------ one late server

async function listTools(connection) {
  const tools = []
  let cursor
  do {
    const result = await connection.request('tools/list', cursor === undefined ? {} : { cursor }, LIST_TIMEOUT_MS)
    tools.push(...(result?.tools ?? []))
    cursor = result?.nextCursor
  } while (cursor)
  return tools
}

const toolsEvent = server => ({
  type: 'tools',
  server: server.name,
  scope: server.scope,
  generation: server.generation,
  tools: server.tools.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object' } })),
})

class LateServer {
  constructor({ name, scope, def }) {
    this.name = name
    this.scope = scope
    this.def = def
    this.fingerprint = fingerprint(def)
    this.state = 'stopped'
    this.tools = []
    this.error = null
    this.connection = null
    this.generation = 0
    this.startedAt = null
    this.serverInfo = null
    this.starting = null
  }

  get transport() {
    return this.def.type === 'http' || this.def.type === 'sse' || (!this.def.command && this.def.url) ? 'http' : 'stdio'
  }

  async open() {
    const onNotification = message => {
      if (message.method === 'notifications/tools/list_changed') void this.relist()
    }
    const connection = this.transport === 'http' ? new HttpConnection(this.def) : new StdioConnection(this.def, onNotification)
    try {
      const init = await Promise.race([
        connection.request('initialize', { protocolVersion: PROTOCOL, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'mcp-restart', version: VERSION } }, START_TIMEOUT_MS),
        connection.exited.then(exit => {
          throw new Error(`it exited while starting (${describeExit(exit)})`)
        }),
      ])
      connection.protocol = init?.protocolVersion
      await connection.notify('notifications/initialized')
      return { connection, init, tools: await listTools(connection) }
    } catch (error) {
      connection.close()
      throw Object.assign(error, { stderr: connection.stderrTail.trim().slice(-1500) })
    }
  }

  // A start, or a restart: the new one takes over once it answered; one that fails leaves the old one serving.
  start() {
    this.starting ??= (async () => {
      const previous = this.connection
      this.state = previous ? 'restarting' : 'starting'
      emit({ type: 'state', server: this.name, state: this.state, error: null })
      try {
        const { connection, init, tools } = await this.open()
        this.connection = connection
        this.tools = tools
        this.serverInfo = init?.serverInfo ?? null
        this.generation++
        this.startedAt = new Date()
        this.state = 'running'
        this.error = null
        void connection.exited.then(exit => {
          if (this.connection !== connection) return
          this.connection = null
          this.state = 'down'
          this.error = `the process exited (${describeExit(exit)}); the next call starts it again`
          emit({ type: 'state', server: this.name, state: this.state, error: this.error })
        })
        previous?.close()
        emit(toolsEvent(this))
        return { ok: true, tools: tools.length }
      } catch (error) {
        this.error = `${error.message}${error.stderr ? `\n${error.stderr}` : ''}`
        const kept = previous?.alive === true
        this.state = kept ? 'running' : 'failed'
        emit({ type: 'error', server: this.name, message: this.error, kept })
        return { ok: false, error: this.error, kept }
      } finally {
        this.starting = null
      }
    })()
    return this.starting
  }

  async relist() {
    if (!this.connection?.alive) return
    try {
      this.tools = await listTools(this.connection)
      emit(toolsEvent(this))
    } catch (error) {
      log(`${this.name}: tools/list after list_changed failed: ${error.message}`)
    }
  }

  async call(tool, args) {
    if (this.starting) await this.starting
    if (!this.connection?.alive) {
      const started = await this.start() // crashed, or failed before: try again, as the proxy does
      if (!started.ok) throw new Error(`${this.name} did not start: ${started.error}`)
    }
    return this.connection.request('tools/call', { name: tool, arguments: args ?? {} })
  }

  stop() {
    this.connection?.close()
    this.connection = null
    this.state = 'stopped'
  }

  row() {
    return {
      name: this.name,
      scope: this.scope,
      transport: this.transport,
      state: this.state,
      tools: this.tools.map(tool => tool.name),
      generation: this.generation,
      startedAt: this.startedAt?.toISOString() ?? null,
      pid: this.connection?.pid ?? null,
      serverInfo: this.serverInfo,
      error: this.error,
    }
  }
}

// ------------------------------------------------------------------ the host

const late = new Map() // server name -> LateServer
let baseline = new Set()
let sessionPid
let lastStamp = ''
let refreshing = Promise.resolve()

function stampOf(file) {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

// read the config, start what is new, restart what changed, stop what was removed; one at a time
function refresh() {
  refreshing = refreshing.then(applyConfig, applyConfig)
  return refreshing
}

async function applyConfig() {
  const stamp = stampOf(CLAUDE_JSON)
  const json = readClaudeJson()
  if (!json) return
  lastStamp = stamp
  const configured = configuredServers(json)
  const starts = []
  for (const [name, entry] of configured) {
    if (baseline.has(name)) continue
    const current = late.get(name)
    if (!current) {
      const server = new LateServer(entry)
      late.set(name, server)
      log(`${name} (${entry.scope}) was added after the session started: starting it`)
      starts.push(server.start())
    } else if (current.fingerprint !== fingerprint(entry.def)) {
      Object.assign(current, { def: entry.def, scope: entry.scope, fingerprint: fingerprint(entry.def) })
      log(`${name}: its config changed: restarting it`)
      starts.push(current.start())
    }
  }
  for (const [name, server] of late) {
    if (configured.has(name)) continue
    server.stop()
    late.delete(name)
    emit({ type: 'gone', server: name })
  }
  await Promise.all(starts)
}

const status = () => ({
  ok: true,
  version: VERSION,
  cwd: CWD,
  sessionPid: sessionPid ?? null,
  baseline: [...baseline],
  servers: [...late.values()].map(server => server.row()),
})

async function restartLate(names) {
  const wanted = names === 'all' ? [...late.keys()] : [].concat(names ?? []).map(String)
  const results = []
  for (const name of wanted) {
    const server = late.get(name)
    if (!server) {
      results.push({ name, ok: false, error: 'not a server added after this session started' })
      continue
    }
    const t0 = Date.now()
    results.push({ name, ...(await server.start()), generation: server.generation, ms: Date.now() - t0 })
  }
  return { ok: results.every(r => r.ok), results }
}

// calls: answered within WAIT_MS, or left running and fetched again by id
const jobs = new Map()
let jobIds = 0

async function waitForJob(id, waitMs) {
  const job = jobs.get(String(id))
  if (!job) return { done: true, error: `no call ${id} (the host restarted, or it was fetched already)` }
  if (!job.done) await Promise.race([job.promise, sleep(Math.min(Math.max(Number(waitMs) || WAIT_MS, 0), 120000))])
  if (!job.done) return { done: false, id: String(id) }
  jobs.delete(String(id))
  return job.error ? { done: true, error: job.error } : { done: true, result: job.result }
}

async function startCall({ server: name, tool, arguments: args, waitMs }) {
  if (!late.has(name)) await refresh() // added a moment ago
  const server = late.get(name)
  if (!server) {
    const known = [...late.keys()]
    return { done: true, error: `${name} is not a server added after this session started (${known.length ? `those are: ${known.join(', ')}` : 'there are none'})` }
  }
  if (typeof tool !== 'string' || tool === '') return { done: true, error: 'tool is required' }
  const id = String(++jobIds)
  const job = { done: false, at: Date.now() }
  job.promise = server.call(tool, args).then(
    result => Object.assign(job, { done: true, result }),
    error => Object.assign(job, { done: true, error: error.message }),
  )
  jobs.set(id, job)
  return waitForJob(id, waitMs)
}

const token = randomBytes(24).toString('hex')
const http = createServer(async (request, response) => {
  const send = (code, body) => {
    response.writeHead(code, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (request.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' })
  const url = new URL(request.url ?? '/', 'http://late')
  let body = {}
  if (request.method === 'POST') {
    let text = ''
    for await (const chunk of request) text += chunk
    try {
      body = JSON.parse(text || '{}')
    } catch {
      return send(400, { ok: false, error: 'the body is not JSON' })
    }
  }
  try {
    if (url.pathname === '/status') return send(200, status())
    if (url.pathname === '/tools') {
      const name = url.searchParams.get('server') ?? ''
      if (!late.has(name)) await refresh() // added a moment ago
      const server = late.get(name)
      return server ? send(200, { ok: true, ...server.row(), tools: toolsEvent(server).tools }) : send(404, { ok: false, error: `${name} is not a server added after this session started` })
    }
    if (url.pathname === '/refresh') {
      await Promise.race([refresh(), sleep(Number(body.waitMs ?? 10000))])
      return send(200, status())
    }
    if (url.pathname === '/call') return send(200, await startCall(body))
    if (url.pathname === '/result') return send(200, await waitForJob(url.searchParams.get('id'), url.searchParams.get('waitMs')))
    if (url.pathname === '/restart') return send(200, await restartLate(body.names))
    send(404, { ok: false, error: `unknown path ${url.pathname}` })
  } catch (error) {
    send(500, { ok: false, error: error.message })
  }
})

function shutdown() {
  for (const server of late.values()) server.stop()
  process.exit(0)
}

async function readInput() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

const input = await readInput()
if (Array.isArray(input.baseline)) {
  baseline = new Set(input.baseline)
} else {
  const worked = await workOutBaseline(configuredServers(readClaudeJson()), input.visible ?? [])
  baseline = new Set(worked.names)
  sessionPid = worked.sessionPid
  emit({ type: 'baseline', names: worked.names, reason: worked.reason })
}
await new Promise(done => http.listen(0, '127.0.0.1', done))
emit({ type: 'ready', url: `http://127.0.0.1:${http.address().port}`, token, version: VERSION })
log(`host ${VERSION} for ${CWD}: ${baseline.size} servers started by the session, watching ${CLAUDE_JSON}`)
await refresh()

setInterval(() => {
  if (stampOf(CLAUDE_JSON) !== lastStamp) void refresh()
}, POLL_MS).unref()
// the mod ends this host with the session; should it be killed without that, end with the session anyway
setInterval(() => {
  if (!alive(process.ppid) || (sessionPid !== undefined && !alive(sessionPid))) shutdown()
  const now = Date.now()
  for (const [id, job] of jobs) if (job.done && now - job.at > 3600000) jobs.delete(id) // fetched by nobody
}, 5000)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdout.on('error', shutdown)
