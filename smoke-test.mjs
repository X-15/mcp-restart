#!/usr/bin/env node
// Drives server.mjs as an MCP client does: initialize, tools/list, then list_servers for a session.
//   node smoke-test.mjs <session pid>                    list that session's servers
//   node smoke-test.mjs <session pid> --restart <name>   and restart_server <name> there
// The session pid stands in for the Claude Code process that would be the server's parent.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const [sessionPid, flag, name] = process.argv.slice(2)
if (!sessionPid) {
  console.error('usage: node smoke-test.mjs <session pid> [--restart <name>]')
  process.exit(2)
}
const server = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')], {
  env: { ...process.env, MCP_RESTART_SESSION_PID: sessionPid },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const pending = new Map()
createInterface({ input: server.stdout }).on('line', line => {
  const message = JSON.parse(line)
  pending.get(message.id)?.(message)
})
let nextId = 0
const request = (method, params) =>
  new Promise(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const text = response => response.result?.content?.map(block => block.text).join('\n') ?? JSON.stringify(response)

const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
console.log('initialize:', init.result.serverInfo.name, init.result.serverInfo.version)
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
console.log('tools:', (await request('tools/list', {})).result.tools.map(tool => tool.name).join(', '))
console.log(text(await request('tools/call', { name: 'list_servers', arguments: {} })))
if (flag === '--restart' && name) console.log(text(await request('tools/call', { name: 'restart_server', arguments: { name } })))
server.stdin.end()
