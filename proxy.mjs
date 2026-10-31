#!/usr/bin/env node
// mcp-restart proxy: stands between Claude Code and one stdio MCP server, so the server can be restarted
// without the session losing it.
//
// Why (Claude Code 2.1.309, read from its code and verified 2026-10-31): a session connects to a stdio
// server once. When the server's process dies, the next call starts it again, but the session never reads
// its tool list again; a start that fails leaves the server unusable for the rest of the session (the
// desktop app has no reconnect); and notifications/tools/list_changed is honoured only on the connection
// the session made itself, from a server that said at initialize that it sends it.
//
// So the session talks to this proxy, which never goes away, and the proxy runs the server as its child:
// - restart: start the new server and replay the session's initialize to it; only once it answered, send
//   new calls to it, let the old one finish its calls, stop it, and send tools/list_changed so the session
//   reads the tools again. A new server that fails to start is stopped and the old one keeps serving.
// - crash: calls in flight get an error; the next call starts the server again (again after a fix).
// - every message passes through unchanged, both ways. Requests the server sends the session get ids of
//   the proxy's own, so two generations of the server never mix up their answers.
// - the initialize answer the session gets says tools.listChanged: true, so the session listens.
//
// Control: a named pipe \\.\pipe\mcp-restart-<proxy pid> takes one JSON line, {"op":"status"} or
// {"op":"restart","force":false,"drainMs":30000}, and answers one JSON line (lib.mjs is its client).
//
// Usage (what `node cli.mjs wrap` writes into a server's config):
//   node proxy.mjs --name <server> [--start-timeout <ms>] [--drain-timeout <ms>] -- <command> [args...]
import { execFileSync, spawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

const VERSION = '1.0.0'
const IS_WINDOWS = process.platform === 'win32'

// ------------------------------------------------------------------ arguments

function parseArguments(argv) {
  const split = argv.indexOf('--')
  if (split < 0 || split === argv.length - 1) {
    process.stderr.write('usage: node proxy.mjs --name <server> [--start-timeout <ms>] [--drain-timeout <ms>] -- <command> [args...]\n')
    process.exit(2)
  }
  const options = { name: 'server', startTimeoutMs: 120000, drainTimeoutMs: 30000 }
  const own = argv.slice(0, split)
  for (let i = 0; i < own.length; i += 2) {
    if (own[i] === '--name') options.name = own[i + 1]
    else if (own[i] === '--start-timeout') options.startTimeoutMs = Number(own[i + 1]) || options.startTimeoutMs
    else if (own[i] === '--drain-timeout') options.drainTimeoutMs = Number(own[i + 1]) || options.drainTimeoutMs
  }
  return { ...options, command: argv[split + 1], args: argv.slice(split + 2) }
}

const OPTIONS = parseArguments(process.argv.slice(2))
const log = (...parts) => process.stderr.write(`[mcp-restart ${OPTIONS.name}] ${parts.join(' ')}\n`)

// ------------------------------------------------------------------ the server process

// As Claude Code starts a stdio server on Windows: the command looked up on PATH with PATHEXT, and a
// .cmd or .bat run through cmd.exe (Node refuses to start one directly).
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

function spawnServer() {
  const file = resolveCommand(OPTIONS.command)
  // the server can ask its own proxy for a restart (mcp-restart restarting itself)
  const env = { ...process.env, MCP_RESTART_PROXY_PID: String(process.pid) }
  const options = { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: process.cwd(), windowsHide: true }
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...OPTIONS.args].map(quoteForCmd).join(' ')
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true })
  }
  return spawn(file, OPTIONS.args, options)
}

// the whole tree: npx, uvx, uv run and cmd /c start the real server as a grandchild
function killTree(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return
  if (!IS_WINDOWS) return void proc.kill('SIGKILL')
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true })
  } catch {
    // already gone
  }
}

const describeExit = exit => (exit.error ? exit.error.message : exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`)

const servers = new Set() // every generation still running
let generation = 0
let internalIds = 0

class Server {
  constructor() {
    this.generation = ++generation
    this.startedAt = new Date()
    this.ready = false
    this.retiring = false
    this.exit = null
    this.serverInfo = null
    this.stderrTail = ''
    this.internal = new Map() // the proxy's own requests to this server
    this.proc = spawnServer()
    this.pid = this.proc.pid
    servers.add(this)
    this.exited = new Promise(resolve => {
      const settle = exit => {
        if (this.exit) return
        this.exit = exit
        servers.delete(this)
        clearTimeout(this.drainTimer)
        onServerExit(this, exit)
        resolve(exit)
      }
      this.proc.once('close', (code, signal) => settle({ code, signal }))
      this.proc.once('error', error => settle({ error }))
    })
    createInterface({ input: this.proc.stdout }).on('line', line => fromServer(this, line))
    this.proc.stderr.on('data', chunk => {
      process.stderr.write(chunk) // the session logs a server's stderr: keep it reaching there
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    this.proc.stdin.on('error', () => {}) // a write after the server died
  }

  send(message) {
    if (!this.exit) this.proc.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
  }

  request(method, params, timeoutMs) {
    const id = `mcp-restart:${++internalIds}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internal.delete(id)
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`))
      }, timeoutMs)
      const done = fn => value => {
        clearTimeout(timer)
        fn(value)
      }
      this.internal.set(id, { resolve: done(resolve), reject: done(reject) })
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  inflight() {
    return [...fromClient.values()].filter(request => request.server === this)
  }
}

// ------------------------------------------------------------------ the session's side

const session = {
  initialize: undefined, // the session's initialize request, replayed to every new server
  initialized: false, // it sent notifications/initialized
  logLevel: undefined, // logging/setLevel, replayed
  subscriptions: new Set(), // resources/subscribe, replayed
}
let active // the server new requests go to
let starting // a start after a crash, in progress
let restarting = false
let lastStartFailure = 0
let lastTools // the tool list the session last read
const queue = [] // the session's messages waiting for a server
const fromClient = new Map() // the session's requests in flight, by id
const toClientRequests = new Map() // the servers' requests to the session, by the proxy's id
let proxyIds = 0
const stats = { restarts: 0, crashes: 0, recoveries: 0, lastRestart: null, lastError: null }

const toClient = message => process.stdout.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
const idKey = id => JSON.stringify(id)
const isRequest = m => m.method !== undefined && m.id !== undefined && m.id !== null
const isResponse = m => m.method === undefined && m.id !== undefined
const rpcError = (id, message, data) => ({ jsonrpc: '2.0', id, error: { code: -32000, message, ...(data ? { data } : {}) } })

// The session listens for list_changed only from a server that said, at initialize, that it sends it.
function advertiseListChanged(result) {
  const capabilities = (result.capabilities ??= {})
  capabilities.tools = { ...(capabilities.tools ?? {}), listChanged: true }
  for (const kind of ['prompts', 'resources']) if (capabilities[kind]) capabilities[kind].listChanged = true
}

function fromServer(server, line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return toClient(line) // not JSON-RPC: as the server wrote it
  }
  if (isResponse(message)) {
    const internal = server.internal.get(message.id)
    if (internal) {
      server.internal.delete(message.id)
      return message.error ? internal.reject(Object.assign(new Error(message.error.message || 'error'), { rpc: message.error })) : internal.resolve(message.result)
    }
    const key = idKey(message.id)
    const request = fromClient.get(key)
    if (request?.server !== server) return // an answer nobody waits for any more
    fromClient.delete(key)
    if (request.method === 'initialize' && message.result) {
      server.serverInfo = message.result.serverInfo ?? null
      advertiseListChanged(message.result)
    }
    if (request.method === 'tools/list' && message.result && request.cursor === undefined && message.result.nextCursor === undefined) lastTools = message.result.tools
    toClient(message)
    if (server.retiring && server.inflight().length === 0) stopServer(server)
    return
  }
  if (isRequest(message)) {
    const id = `mcp-restart:${server.generation}:${++proxyIds}`
    toClientRequests.set(id, { server, id: message.id })
    return toClient({ ...message, id })
  }
  toClient(message) // a notification: progress, logging, the server's own list_changed
}

function fromClientLine(line) {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return active?.send(line)
  }
  if (isResponse(message)) {
    // the session answers a request a server sent it
    const origin = toClientRequests.get(message.id)
    if (!origin) return
    toClientRequests.delete(message.id)
    return origin.server.send({ ...message, id: origin.id })
  }
  switch (message.method) {
    case 'initialize':
      session.initialize = message
      if (!active) {
        active = new Server() // the first one: the session's own initialize goes straight to it
        active.ready = true
      }
      break
    case 'notifications/initialized':
      session.initialized = true
      break
    case 'logging/setLevel':
      session.logLevel = message.params
      break
    case 'resources/subscribe':
      session.subscriptions.add(message.params?.uri)
      break
    case 'resources/unsubscribe':
      session.subscriptions.delete(message.params?.uri)
      break
    case 'notifications/cancelled': {
      const request = fromClient.get(idKey(message.params?.requestId))
      if (request) return request.server.send(message)
      break
    }
  }
  if (!active?.ready) return waitForServer(message)
  dispatch(message)
}

function dispatch(message) {
  if (isRequest(message)) {
    fromClient.set(idKey(message.id), {
      server: active,
      id: message.id,
      method: message.method,
      tool: message.params?.name,
      cursor: message.params?.cursor,
      since: Date.now(),
    })
  }
  active.send(message)
}

// No server (it crashed): start one, then send what waited. One that keeps failing to start answers each
// call with the reason, at most one start a second, and is tried again on the next call.
function waitForServer(message) {
  queue.push(message)
  if (starting || restarting || !session.initialize) return
  if (Date.now() - lastStartFailure < 1000) return failQueue(`${OPTIONS.name}: the MCP server failed to start a moment ago: ${stats.lastError?.message ?? 'unknown'}`)
  starting = (async () => {
    try {
      const server = await startServer()
      const before = lastTools
      active = server
      stats.recoveries++
      flushQueue()
      const after = await listTools(server).catch(() => undefined)
      if (after && before && toolsDiffer(diffTools(before, after))) announceTools(after)
    } catch (error) {
      lastStartFailure = Date.now()
      stats.lastError = { at: new Date().toISOString(), message: error.message, stderr: error.stderr }
      failQueue(`${OPTIONS.name}: the MCP server did not start: ${error.message}${error.stderr ? `\n${error.stderr}` : ''}`)
    } finally {
      starting = undefined
    }
  })()
}

function flushQueue() {
  while (queue.length > 0 && active?.ready) dispatch(queue.shift())
}

function failQueue(text) {
  for (const message of queue.splice(0)) if (isRequest(message)) toClient(rpcError(message.id, text))
}

function onServerExit(server, exit) {
  for (const internal of server.internal.values()) internal.reject(new Error(`the server exited (${describeExit(exit)})`))
  server.internal.clear()
  for (const [key, request] of fromClient) {
    if (request.server !== server) continue
    fromClient.delete(key)
    toClient(
      rpcError(
        request.id,
        server.retiring
          ? `${OPTIONS.name}: this call was interrupted by a restart of the MCP server`
          : `${OPTIONS.name}: the MCP server process exited (${describeExit(exit)}) during this call; the next call starts it again`,
      ),
    )
  }
  for (const [id, origin] of toClientRequests) if (origin.server === server) toClientRequests.delete(id)
  if (server === active && !server.retiring) {
    active = undefined
    stats.crashes++
    log(`server exited (${describeExit(exit)}); the next call starts it again`)
  }
}

function stopServer(server) {
  server.retiring = true
  killTree(server.proc)
}

function retire(server, drainMs) {
  server.retiring = true
  if (server.inflight().length === 0 || drainMs <= 0) return stopServer(server)
  server.drainTimer = setTimeout(() => stopServer(server), drainMs)
}

// a new server, initialized as the session initialized the first one
async function startServer() {
  const server = new Server()
  try {
    const result = await Promise.race([
      server.request('initialize', session.initialize.params, OPTIONS.startTimeoutMs),
      server.exited.then(exit => {
        throw new Error(`it exited while starting (${describeExit(exit)})`)
      }),
    ])
    server.serverInfo = result?.serverInfo ?? null
    if (session.initialized) server.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    if (session.logLevel) await server.request('logging/setLevel', session.logLevel, 10000).catch(() => {})
    for (const uri of session.subscriptions) await server.request('resources/subscribe', { uri }, 10000).catch(() => {})
    server.ready = true
    return server
  } catch (error) {
    stopServer(server)
    await server.exited
    throw Object.assign(error, { stderr: server.stderrTail.trim().slice(-1500) })
  }
}

async function listTools(server) {
  const tools = []
  let cursor
  do {
    const result = await server.request('tools/list', cursor === undefined ? {} : { cursor }, 30000)
    tools.push(...(result?.tools ?? []))
    cursor = result?.nextCursor
  } while (cursor)
  return tools
}

const signature = tool => JSON.stringify([tool.description ?? '', tool.inputSchema ?? {}])
function diffTools(before = [], after = []) {
  const old = new Map(before.map(tool => [tool.name, signature(tool)]))
  const now = new Map(after.map(tool => [tool.name, signature(tool)]))
  return {
    added: [...now.keys()].filter(name => !old.has(name)),
    removed: [...old.keys()].filter(name => !now.has(name)),
    changed: [...now.keys()].filter(name => old.has(name) && old.get(name) !== now.get(name)),
  }
}
const toolsDiffer = diff => diff.added.length + diff.removed.length + diff.changed.length > 0

function announceTools(tools) {
  lastTools = tools
  if (session.initialized) toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
}

// ------------------------------------------------------------------ restart

async function restart({ force = false, drainMs = OPTIONS.drainTimeoutMs } = {}) {
  if (!session.initialize) return { ok: false, name: OPTIONS.name, error: 'the session has not started this server yet' }
  if (restarting) return { ok: false, name: OPTIONS.name, error: 'a restart is already running' }
  restarting = true
  const t0 = Date.now()
  try {
    if (starting) await starting
    const old = active
    const before = old?.ready ? await listTools(old).catch(() => lastTools) : lastTools
    let server
    try {
      server = await startServer()
    } catch (error) {
      stats.lastError = { at: new Date().toISOString(), message: error.message, stderr: error.stderr }
      return {
        ok: false,
        name: OPTIONS.name,
        error: `the new server did not start: ${error.message}`,
        stderr: error.stderr,
        kept: old ? { generation: old.generation, pid: old.pid, note: 'the running server keeps serving' } : null,
        ms: Date.now() - t0,
      }
    }
    const after = await listTools(server).catch(() => [])
    const interrupted = force && old ? old.inflight().length : 0
    active = server
    flushQueue()
    if (old) retire(old, force ? 0 : drainMs)
    const diff = diffTools(before, after)
    announceTools(after) // always: the session reads the tools again, changed or not
    stats.restarts++
    stats.lastRestart = { at: new Date().toISOString(), ms: Date.now() - t0, generation: server.generation }
    return {
      ok: true,
      name: OPTIONS.name,
      generation: server.generation,
      pid: server.pid,
      previous: old ? { generation: old.generation, pid: old.pid, draining: old.exit ? 0 : old.inflight().length } : null,
      serverInfo: server.serverInfo,
      tools: { count: after.length, ...diff },
      interrupted,
      ms: Date.now() - t0,
    }
  } finally {
    restarting = false
  }
}

function status() {
  return {
    ok: true,
    proxy: VERSION,
    name: OPTIONS.name,
    proxyPid: process.pid,
    command: OPTIONS.command,
    args: OPTIONS.args,
    state: restarting ? 'restarting' : active?.ready ? 'running' : starting ? 'starting' : session.initialize ? 'down' : 'waiting for the session',
    generation: active?.generation ?? null,
    serverPid: active?.pid ?? null,
    serverStartedAt: active?.startedAt.toISOString() ?? null,
    serverInfo: active?.serverInfo ?? null,
    tools: lastTools?.length ?? null,
    inflight: [...fromClient.values()].map(r => ({ method: r.method, tool: r.tool ?? null, ms: Date.now() - r.since, generation: r.server.generation })),
    ...stats,
  }
}

// ------------------------------------------------------------------ control pipe

const PIPE = IS_WINDOWS ? `\\\\.\\pipe\\mcp-restart-${process.pid}` : join(tmpdir(), `mcp-restart-${process.pid}.sock`)
if (!IS_WINDOWS) rmSync(PIPE, { force: true })
const control = createServer(socket => {
  socket.on('error', () => {})
  createInterface({ input: socket }).once('line', async line => {
    let answer
    try {
      const request = JSON.parse(line)
      answer = request.op === 'restart' ? await restart(request) : request.op === 'status' ? status() : { ok: false, error: `unknown op ${request.op}` }
    } catch (error) {
      answer = { ok: false, error: error.message }
    }
    socket.end(`${JSON.stringify(answer)}\n`)
  })
})
control.on('error', error => log('control pipe:', error.message))
control.listen(PIPE)

// ------------------------------------------------------------------ life

function shutdown() {
  for (const server of servers) killTree(server.proc)
  control.close()
  process.exit(0)
}

createInterface({ input: process.stdin }).on('line', fromClientLine)
process.stdin.on('end', shutdown) // the session went away
process.stdout.on('error', shutdown)
process.on('exit', () => {
  for (const server of servers) killTree(server.proc)
})
log(`proxy ${VERSION} for ${OPTIONS.command} ${OPTIONS.args.join(' ')}`)
