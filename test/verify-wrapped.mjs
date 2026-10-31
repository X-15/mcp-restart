#!/usr/bin/env node
// Before wrapping real servers: start each configured stdio server twice, as configured and wrapped in
// proxy.mjs, run initialize + tools/list on both, and compare. Nothing in any config changes.
//   node test/verify-wrapped.mjs [name,name...] [--scope user|local|project] [--project <dir>]
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { innerOf, isWrapped, loadConfigs, wrapDef } from '../lib.mjs'

const argv = process.argv.slice(2)
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const names = argv[0] && !argv[0].startsWith('--') ? argv[0].split(',') : undefined
const scope = option('--scope') ?? 'user'
const project = option('--project')

const expand = value => String(value).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, key, fallback) => process.env[key] ?? fallback ?? '')
const quote = arg => (/[\s&()]/.test(arg) ? `"${arg}"` : arg)

// initialize + tools/list, the way a client does; the command line through the shell, as Claude Code resolves it
function probe(def, cwd, timeoutMs = 60000) {
  return new Promise(done => {
    const env = { ...process.env, ...Object.fromEntries(Object.entries(def.env ?? {}).map(([k, v]) => [k, expand(v)])) }
    const child = spawn([def.command, ...(def.args ?? [])].map(expand).map(quote).join(' '), { shell: true, env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => (stderr += chunk))
    const waiting = new Map()
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line)
        waiting.get(message.id)?.(message)
      } catch {
        // not JSON
      }
    })
    const request = (id, method, params) =>
      new Promise(answer => {
        waiting.set(id, answer)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    const finish = result => {
      clearTimeout(timer)
      try {
        execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      } catch {
        // gone
      }
      done(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `timeout after ${timeoutMs} ms`, stderr: stderr.slice(-300) }), timeoutMs)
    child.on('exit', code => finish({ ok: false, error: `exited ${code}`, stderr: stderr.slice(-300) }))
    void (async () => {
      const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-wrapped', version: '1' } })
      if (init.error) return finish({ ok: false, error: JSON.stringify(init.error) })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const list = await request(2, 'tools/list', {})
      if (list.error) return finish({ ok: false, error: JSON.stringify(list.error) })
      child.removeAllListeners('exit')
      finish({ ok: true, server: `${init.result.serverInfo?.name}@${init.result.serverInfo?.version}`, tools: list.result.tools.map(t => t.name).sort(), listChanged: init.result.capabilities?.tools?.listChanged === true })
    })()
  })
}

const configs = loadConfigs(project ? [project] : []).filter(
  c =>
    !c.variant &&
    c.scope === scope &&
    c.name !== 'mcp-restart' &&
    (!names || names.includes(c.name)) &&
    (!project || resolve(c.project ?? '').toLowerCase() === resolve(project).toLowerCase()),
)
let failures = 0
for (const c of configs) {
  const plain = isWrapped(c.raw) ? innerOf(c.raw) : c.raw
  const wrapped = isWrapped(c.raw) ? c.raw : wrapDef(c.name, c.raw)
  const cwd = c.project && c.project !== '' ? c.project : homedir()
  const [a, b] = [await probe(plain, cwd), await probe(wrapped, cwd)]
  const same = a.ok && b.ok && a.server === b.server && a.tools.join() === b.tools.join()
  const verdict = same ? 'SAME' : !a.ok && !b.ok ? 'BOTH FAIL' : 'DIFFERENT'
  if (verdict === 'DIFFERENT') failures++
  console.log(
    `${verdict.padEnd(10)} ${c.name.padEnd(22)} plain: ${a.ok ? `${a.server}, ${a.tools.length} tools` : a.error}  |  wrapped: ${b.ok ? `${b.server}, ${b.tools.length} tools, listChanged ${b.listChanged}` : b.error}`,
  )
  if (!same && (a.stderr || b.stderr)) console.log(`           stderr plain: ${(a.stderr ?? '').trim().split('\n').at(-1)} | wrapped: ${(b.stderr ?? '').trim().split('\n').at(-1)}`)
}
console.log(`${failures} differ`)
process.exit(failures)
