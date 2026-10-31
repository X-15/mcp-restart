#!/usr/bin/env node
// Drives proxy.mjs as Claude Code does (stdio JSON-RPC) with fixture-server.mjs behind it, and its control
// pipe as lib.mjs does. Each step prints PASS or FAIL; the exit code is the number of failures.
//   node test/proxy.test.mjs
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE = join(HERE, 'state-proxy-test.json')
const setState = state => writeFileSync(STATE, JSON.stringify({ slowStartMs: 0, crashOnStart: false, ...state }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

setState({ version: 1 })
const proxy = spawn(process.execPath, [join(HERE, '..', 'proxy.mjs'), '--name', 'fx', '--start-timeout', '15000', '--drain-timeout', '5000', '--', 'node', join(HERE, 'fixture-server.mjs')], {
  env: { ...process.env, MCP_FIXTURE_STATE: STATE },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
proxy.stderr.on('data', chunk => (stderr += chunk))

// ------------------------------------------------------------------ the client side

const waiting = new Map()
const notifications = []
const serverRequests = []
let nextId = 0
createInterface({ input: proxy.stdout }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === undefined) return waiting.get(JSON.stringify(message.id))?.(message)
  if (message.id !== undefined) {
    // a request from the server: answer roots/list as a client with one root
    serverRequests.push(message)
    if (message.method === 'roots/list') proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: 'file:///C:/test', name: 'test' }] } })}\n`)
    return
  }
  notifications.push(message)
})
const send = message => proxy.stdin.write(`${JSON.stringify(message)}\n`)
const request = (method, params, id = ++nextId) =>
  new Promise(resolve => {
    waiting.set(JSON.stringify(id), resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
const call = (name, args = {}, meta) => request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })
const textOf = response => response.result?.content?.[0]?.text ?? JSON.stringify(response.error ?? response)
const whoami = async () => JSON.parse(textOf(await call('whoami')))

const pipe = op =>
  new Promise((resolve, reject) => {
    const socket = connect(`\\\\.\\pipe\\mcp-restart-${proxy.pid}`)
    let data = ''
    socket.on('data', chunk => (data += chunk))
    socket.on('end', () => resolve(JSON.parse(data)))
    socket.on('error', reject)
    socket.write(`${JSON.stringify(op)}\n`)
  })

// ------------------------------------------------------------------ steps

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
const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}
const listChangedCount = () => notifications.filter(n => n.method === 'notifications/tools/list_changed').length

await step('initialize passes through and advertises tools.listChanged', async () => {
  const response = await request('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'test', version: '1' } })
  expect(response.result?.capabilities?.tools?.listChanged === true, JSON.stringify(response))
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return `serverInfo ${JSON.stringify(response.result.serverInfo)}`
})

let firstPid
await step('tools/list and a call reach the server', async () => {
  const tools = (await request('tools/list', {})).result.tools.map(t => t.name)
  expect(tools.includes('v1_marker'), tools.join(','))
  const me = await whoami()
  expect(me.version === 1, JSON.stringify(me))
  firstPid = me.pid
  return `pid ${me.pid}`
})

await step('progress notifications pass through', async () => {
  await call('sleep', { ms: 50 }, { progressToken: 'p1' })
  expect(notifications.some(n => n.method === 'notifications/progress' && n.params?.progressToken === 'p1'), 'no progress')
})

await step('a request from the server reaches the client and the answer goes back', async () => {
  const text = textOf(await call('ask_roots'))
  expect(text.includes('file:///C:/test'), text)
  expect(serverRequests.at(-1)?.id?.startsWith('mcp-restart:'), `server request id ${serverRequests.at(-1)?.id}`)
})

await step('a cancellation reaches the server that runs the request', async () => {
  void request('tools/call', { name: 'sleep', arguments: { ms: 300 } }, 'c1')
  await sleep(50)
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'c1', reason: 'test' } })
  await sleep(50)
  const text = textOf(await call('cancelled'))
  expect(text.includes('c1'), text)
})

await step('restart: verified swap, tool diff, list_changed, new code answers', async () => {
  setState({ version: 2 })
  const before = listChangedCount()
  const result = await pipe({ op: 'restart' })
  expect(result.ok, JSON.stringify(result))
  expect(result.tools.added.includes('v2_marker') && result.tools.removed.includes('v1_marker'), JSON.stringify(result.tools))
  await sleep(50)
  expect(listChangedCount() === before + 1, 'no list_changed')
  const me = await whoami()
  expect(me.version === 2 && me.pid !== firstPid, JSON.stringify(me))
  const tools = (await request('tools/list', {})).result.tools.map(t => t.name)
  expect(tools.includes('v2_marker') && !tools.includes('v1_marker'), tools.join(','))
  return `${result.ms} ms, generation ${result.generation}`
})

await step('restart drains: a call in flight finishes on the old server', async () => {
  const inflight = call('sleep', { ms: 1500 })
  await sleep(100)
  setState({ version: 3 })
  const result = await pipe({ op: 'restart' })
  expect(result.ok && result.previous?.draining === 1, JSON.stringify(result))
  const text = textOf(await inflight)
  expect(text === 'slept 1500 ms', text)
  expect((await whoami()).version === 3, 'not version 3')
})

await step('a broken update keeps the running server', async () => {
  setState({ version: 4, crashOnStart: true })
  const result = await pipe({ op: 'restart' })
  expect(!result.ok && result.kept, JSON.stringify(result))
  const me = await whoami()
  expect(me.version === 3, JSON.stringify(me))
  return result.error
})

await step('a crash: the next call starts the server again, and the session hears of new tools', async () => {
  setState({ version: 5 })
  const before = listChangedCount()
  textOf(await call('exit', { code: 3 }))
  await sleep(300)
  const me = await whoami()
  expect(me.version === 5, JSON.stringify(me))
  await sleep(100)
  expect(listChangedCount() === before + 1, 'no list_changed after the recovery')
})

await step('a start that fails after a crash is not final: after the fix the next call works', async () => {
  setState({ version: 6, crashOnStart: true })
  await call('exit', { code: 3 })
  await sleep(300)
  const failed = await call('whoami')
  expect(failed.error?.message?.includes('did not start'), JSON.stringify(failed))
  setState({ version: 6 })
  await sleep(1100)
  const me = await whoami()
  expect(me.version === 6, JSON.stringify(me))
  return failed.error.message.split('\n')[0]
})

await step('force restart interrupts a hung call', async () => {
  const hung = call('sleep', { ms: 60000 })
  await sleep(100)
  const result = await pipe({ op: 'restart', force: true })
  expect(result.ok && result.interrupted === 1, JSON.stringify(result))
  const answer = await hung
  expect(answer.error?.message?.includes('interrupted by a restart'), JSON.stringify(answer))
  expect((await whoami()).version === 6, 'no answer after the forced restart')
})

await step('a slow start does not hold up calls: the old server answers meanwhile', async () => {
  setState({ version: 7, slowStartMs: 2000 })
  const restarting = pipe({ op: 'restart' })
  await sleep(200)
  const t0 = Date.now()
  const me = await whoami()
  const ms = Date.now() - t0
  expect(me.version === 6 && ms < 500, `version ${me.version} after ${ms} ms`)
  const result = await restarting
  expect(result.ok && (await whoami()).version === 7, JSON.stringify(result))
  return `old answered in ${ms} ms; restart took ${result.ms} ms`
})

await step('a server restarts itself through its own proxy; the call that asked is answered by the old one', async () => {
  setState({ version: 8 })
  const answer = JSON.parse(textOf(await call('restart_self')))
  expect(answer.ok && answer.previous?.draining === 1, JSON.stringify(answer))
  const me = await whoami()
  expect(me.version === 8, JSON.stringify(me))
  return `generation ${answer.generation}`
})

await step('status reports the server', async () => {
  const s = await pipe({ op: 'status' })
  expect(s.ok && s.state === 'running' && s.generation >= 6 && s.inflight.length === 0, JSON.stringify(s))
  return `generation ${s.generation}, restarts ${s.restarts}, crashes ${s.crashes}, recoveries ${s.recoveries}`
})

await step('closing stdin ends the proxy and its server', async () => {
  const { serverPid } = await pipe({ op: 'status' })
  proxy.stdin.end()
  await new Promise(resolve => proxy.once('exit', resolve))
  await sleep(500)
  let alive = true
  try {
    process.kill(serverPid, 0)
  } catch {
    alive = false
  }
  expect(!alive, `server ${serverPid} still running`)
})

rmSync(STATE, { force: true })
if (failures) console.log(`--- proxy stderr (tail)\n${stderr.slice(-1500)}`)
console.log(`${failures} failed`)
process.exit(failures)
