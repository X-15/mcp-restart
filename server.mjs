#!/usr/bin/env node
// mcp-restart: a stdio MCP server that restarts the other stdio MCP servers of the Claude Code
// session that runs it, so an updated server runs its new code without starting a new session.
//
// Why: the Claude Code desktop app has no Reconnect or Restart for a connected stdio server. A server
// wrapped in proxy.mjs is swapped by its proxy: the new one starts, takes over once it answered, and the
// session reads its tools again. One not wrapped is stopped; the session starts it on its next call.
//
// No dependencies: Node 22+. See lib.mjs for how servers are found; cli.mjs does the same from a terminal.
import { createInterface } from 'node:readline'
import { discover, formatList, formatRestart, restart } from './lib.mjs'

const VERSION = '1.0.0'
const log = (...parts) => process.stderr.write(`[mcp-restart] ${parts.join(' ')}\n`)

// ------------------------------------------------------------------ tools

const ALL_SESSIONS = {
  type: 'boolean',
  description: 'Act on every running Claude Code session instead of only this one. Default false.',
}

const TOOLS = [
  {
    name: 'restart_server',
    description:
      'Restart stdio MCP servers of this Claude Code session so they run their current code. Call it on your own, without asking: ' +
      'after installing, updating or rebuilding anything an MCP server runs (name "stale"), and when a server\'s calls fail or hang ' +
      '(that server by name, force true for a hang; then retry the call once). A wrapped ("hot-swap") server is swapped safely: the ' +
      'new version starts, takes over once it answers, and its new or changed tools are available to you right after this returns; ' +
      'a new version that fails to start is reported and the old one keeps serving. A server that is not wrapped ("stop only") is ' +
      'stopped and starts again on its next call, with the tool list of the session start. Wait for this result before calling ' +
      'the restarted server, never in the same parallel batch.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Server name as configured (e.g. "rea"), several separated by commas, "stale" (servers whose files changed after they started) or "all".',
        },
        force: {
          type: 'boolean',
          description: 'Interrupt the calls the server is running (they fail with an error) instead of letting the old version finish them. For a hung server. Default false.',
        },
        all_sessions: ALL_SESSIONS,
      },
      required: ['name'],
    },
  },
  {
    name: 'list_servers',
    description:
      'List the stdio MCP servers this Claude Code session runs: name, config scope, uptime, hot-swap (wrapped) or stop only, ' +
      'calls in flight, and whether their files changed since they started ("STALE": an update waits for a restart).',
    inputSchema: { type: 'object', properties: { all_sessions: ALL_SESSIONS } },
  },
]

async function callTool(name, args = {}) {
  const options = { allSessions: args.all_sessions === true }
  if (name === 'list_servers') return formatList(await discover(options))
  if (name === 'restart_server') {
    if (!args.name) throw new Error('name is required: a server name, "stale" or "all"')
    return formatRestart(await restart(args.name, { ...options, force: args.force === true }))
  }
  throw new Error(`unknown tool: ${name}`)
}

// ------------------------------------------------------------------ MCP over stdio

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return // a notification: nothing to answer
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mcp-restart', version: VERSION },
            instructions:
              'Restarts this session\'s other stdio MCP servers. Use restart_server on your own, without asking the user: ' +
              '(1) after you installed, updated or rebuilt anything an MCP server runs (npm, uv, pip, pipx, volta, a build of its code): ' +
              'name "stale" restarts exactly the servers whose files changed since they started; ' +
              '(2) when a server\'s calls fail ("Connection closed", "process exited") or hang: restart that server by name ' +
              '(force true when a call hangs), then retry the call once. Wrapped servers ("hot-swap" in list_servers) are swapped ' +
              'safely and their new tools are available right after the restart; others are stopped and start again on their next ' +
              'call with the tool list of the session start. Wait for restart_server\'s result before calling the restarted server ' +
              '(never in the same parallel batch). If it reports that a new version did not start, the old one is still serving: ' +
              'tell the user the error instead of retrying.',
          },
        })
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} })
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      case 'tools/call':
        try {
          return send({ jsonrpc: '2.0', id, result: textResult(await callTool(params?.name, params?.arguments)) })
        } catch (error) {
          return send({ jsonrpc: '2.0', id, result: textResult(`mcp-restart: ${error.message}`, true) })
        }
      case 'resources/list':
        return send({ jsonrpc: '2.0', id, result: { resources: [] } })
      case 'prompts/list':
        return send({ jsonrpc: '2.0', id, result: { prompts: [] } })
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } })
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
  }
  void handle(message)
})
// the client went away: stop, never wait on a pipe nobody reads
process.stdin.on('end', () => process.exit(0))
process.stdout.on('error', () => process.exit(0))
log('ready')
