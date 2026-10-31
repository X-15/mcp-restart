#!/usr/bin/env node
// A stdio MCP server for testing restarts. Its behaviour comes from fixture-state.json beside it
// (or MCP_FIXTURE_STATE), read at start, so "updating" it is editing that file:
//   { "version": 1, "slowStartMs": 0, "crashOnStart": false }
// Tools: whoami (version, pid, start time), sleep {ms} (a hang), exit {code} (a crash after answering),
// v<version>_marker (a tool whose name changes with the version), notify_list_changed (re-reads the
// state and sends notifications/tools/list_changed when the tool set changed).
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const STATE = process.env.MCP_FIXTURE_STATE || join(dirname(fileURLToPath(import.meta.url)), 'fixture-state.json')
const readState = () => ({ version: 1, slowStartMs: 0, crashOnStart: false, ...JSON.parse(readFileSync(STATE, 'utf8')) })
const log = (...parts) => process.stderr.write(`[mcp-fixture ${process.pid}] ${parts.join(' ')}\n`)

let state = readState()
const startedAt = new Date().toISOString()
if (state.crashOnStart) {
  log('crashOnStart: exiting 5')
  process.exit(5)
}

const toolsFor = s => [
  { name: 'whoami', description: 'Report this fixture process: version, pid, start time.', inputSchema: { type: 'object', properties: {} } },
  { name: 'sleep', description: 'Wait ms milliseconds, then answer (a hang when large).', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'exit', description: 'Answer, then exit the process with code (a crash).', inputSchema: { type: 'object', properties: { code: { type: 'number' } } } },
  { name: `v${s.version}_marker`, description: `Exists only in fixture version ${s.version}.`, inputSchema: { type: 'object', properties: {} } },
  { name: 'notify_list_changed', description: 'Re-read the state file; send tools/list_changed when the tool set changed.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask_roots', description: 'Ask the client for its roots (a server-to-client request) and return its answer.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cancelled', description: 'List the request ids the client cancelled.', inputSchema: { type: 'object', properties: {} } },
  { name: 'restart_self', description: 'Ask this server\'s own proxy (MCP_RESTART_PROXY_PID) to restart it, and return its answer.', inputSchema: { type: 'object', properties: {} } },
]

const askOwnProxy = request =>
  new Promise(resolve => {
    const socket = connect(`\\\\.\\pipe\\mcp-restart-${process.env.MCP_RESTART_PROXY_PID}`)
    let data = ''
    socket.on('data', chunk => (data += chunk))
    socket.on('end', () => resolve(data.trim()))
    socket.on('error', error => resolve(`no proxy: ${error.message}`))
    socket.write(`${JSON.stringify(request)}\n`)
  })

// requests this server sends the client, and the client's cancellations
let ownId = 0
const awaiting = new Map()
const cancelled = []
const askClient = (method, params) =>
  new Promise(resolve => {
    const id = `fixture-${++ownId}`
    awaiting.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const text = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function callTool(name, args = {}, meta = {}) {
  if (name === 'whoami') return text({ version: state.version, pid: process.pid, startedAt })
  if (name === 'sleep') {
    if (meta.progressToken !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: meta.progressToken, progress: 0, message: 'sleeping' } })
    await sleep(Number(args.ms) || 0)
    return text(`slept ${args.ms} ms`)
  }
  if (name === 'ask_roots') return text({ answer: await askClient('roots/list', {}) })
  if (name === 'cancelled') return text({ cancelled })
  if (name === 'restart_self') return text(await askOwnProxy({ op: 'restart' }))
  if (name === 'exit') {
    setTimeout(() => process.exit(Number(args.code) || 3), 50)
    return text(`exiting with ${Number(args.code) || 3}`)
  }
  if (name === `v${state.version}_marker`) return text(`marker of version ${state.version}`)
  if (name === 'notify_list_changed') {
    const before = toolsFor(state).map(t => t.name).join(',')
    state = readState()
    const changed = toolsFor(state).map(t => t.name).join(',') !== before
    if (changed) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    return text({ changed, version: state.version })
  }
  return text(`unknown tool: ${name}`, true)
}

async function handle(message) {
  const { id, method, params } = message
  if (method === undefined && id !== undefined) return awaiting.get(id)?.(message.result ?? message.error) // the client's answer
  if (method === 'notifications/cancelled') return void cancelled.push(params?.requestId)
  if (id === undefined) return
  if (method === 'initialize') {
    if (state.slowStartMs) await sleep(state.slowStartMs)
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mcp-fixture', version: String(state.version) },
      },
    })
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: toolsFor(state) } })
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments, params?._meta) })
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
}

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim()) void handle(JSON.parse(line))
})
process.stdin.on('end', () => process.exit(0))
log(`started, version ${state.version}`)
