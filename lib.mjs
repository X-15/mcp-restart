// mcp-restart core: find the stdio MCP servers that running Claude Code sessions started, restart them,
// and wrap or unwrap servers in the restart proxy.
//
// Two ways a server restarts (Claude Code 2.1.309, read from its code and verified 2026-10-31):
// - wrapped (its config runs proxy.mjs, which runs the server): the proxy starts the new server, switches
//   to it once it answered, and tells the session to read the tools again. Nothing fails, a broken update
//   keeps the old server serving, and the model sees new or changed tools at once.
// - not wrapped: stop the server's process tree. The session starts it again on the next call to one of
//   its tools, but keeps the tool list it read at its start, and a start that fails leaves the server
//   unusable for the rest of that session. `node cli.mjs wrap` moves a server to the first way.
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
export const PROXY = join(HERE, 'proxy.mjs')
// An installed plugin runs from a cache folder named after its version, which an update replaces, so
// wrapped configs point at a copy that stays: ~/.claude/mcp-restart/proxy.mjs, refreshed on every run.
const STABLE_PROXY = join(homedir(), '.claude', 'mcp-restart', 'proxy.mjs')
const INSTALLED = /[\\/]plugins[\\/]cache[\\/]/i.test(HERE)

// the proxy path wrapped configs get: this folder's own for a checkout, the stable copy for an install
export function proxyForConfigs() {
  if (!INSTALLED) return PROXY
  const source = readFileSync(PROXY)
  if (!existsSync(STABLE_PROXY) || !readFileSync(STABLE_PROXY).equals(source)) {
    mkdirSync(dirname(STABLE_PROXY), { recursive: true })
    writeFileSync(STABLE_PROXY, source) // running proxies keep the code they started with; new ones get this
  }
  return STABLE_PROXY
}

// Windows only for now: finding and stopping a session's servers uses PowerShell (CIM) and taskkill
export function assertSupported() {
  if (process.platform !== 'win32') throw new Error(`mcp-restart supports Windows only for now (this is ${process.platform})`)
}
export const SELF_NAME = 'mcp-restart'
const SETTLE_MS = 1000
const STATUS_TIMEOUT_MS = 3000
const RESTART_TIMEOUT_MS = 15 * 60 * 1000 // a restart lasts as long as the new server takes to start
export const STOP_NOTE =
  'A server that is not wrapped is started again by Claude Code on the next call to one of its tools, running the current code; ' +
  'the session keeps the tool list it read at its start, and a new version that fails to start stays unusable until a new session. ' +
  'Wrap it (node cli.mjs wrap <name>, from the next session on) to swap it safely and refresh its tools.'

// ------------------------------------------------------------------ processes

// one CIM query for the whole process table; Windows PowerShell 5.1 is on every Windows machine
const SNAPSHOT_SCRIPT = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath; cmd = $_.CommandLine
    started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } }
} | ConvertTo-Json -Compress`

export async function snapshot() {
  assertSupported()
  // -EncodedCommand: the script reaches PowerShell intact, without Windows argument quoting
  const encoded = Buffer.from(SNAPSHOT_SCRIPT, 'utf16le').toString('base64')
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return JSON.parse(stdout.replace(/^﻿/, '')).map(p => ({ ...p, cmd: p.cmd || '', started: p.started ? new Date(p.started) : null }))
}

// The desktop app's own Electron processes are claude.exe too: they run the desktop extensions
// (Windows-MCP, Desktop Commander), which the app owns and restarts from Settings > Extensions.
const ELECTRON = /\\(WindowsApps\\Claude_|AnthropicClaude\\)/i
export const isSession = p =>
  (/^claude\.exe$/i.test(p.name) && !ELECTRON.test(p.exe || '') && !p.cmd.includes('--type=')) ||
  (/^node\.exe$/i.test(p.name) && /@anthropic-ai[\\/]claude-code/i.test(p.cmd))

// The session this process belongs to: the nearest Claude Code ancestor (the MCP server is its child,
// the CLI run from a session's shell tool its grandchild). MCP_RESTART_SESSION_PID overrides it for tests.
export function findOwnSession(procs, pid = process.pid) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const forced = Number(process.env.MCP_RESTART_SESSION_PID)
  if (forced) return byPid.get(forced)
  for (let p = byPid.get(pid), hops = 0; p && hops < 12; p = byPid.get(p.ppid), hops++) if (isSession(p)) return p
  return undefined
}

function descendants(procs, root) {
  const found = []
  const pending = [root.pid]
  while (pending.length > 0) {
    const pid = pending.shift()
    for (const p of procs) {
      if (p.ppid !== pid || p.started < root.started) continue // a reused parent pid
      found.push(p)
      pending.push(p.pid)
    }
  }
  return found
}

const alive = pid => {
  try {
    process.kill(pid, 0) // signal 0 only tests: ESRCH once the process has exited
    return true
  } catch {
    return false
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// /T takes the whole tree: npx, uvx, uv run and cmd /c start the real server as a grandchild
export async function killTree(pid) {
  await run('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }).catch(() => {}) // its text is localized: check the pid instead
  for (let waited = 0; alive(pid) && waited < 5000; waited += 100) await sleep(100)
  return !alive(pid)
}

// ------------------------------------------------------------------ the proxy's control pipe

// one JSON line out, one back; undefined when nothing listens there (not a proxy, or gone)
export function askProxy(pid, request, timeoutMs = STATUS_TIMEOUT_MS) {
  return new Promise(resolve => {
    const socket = connect(`\\\\.\\pipe\\mcp-restart-${pid}`)
    let data = ''
    const done = value => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done({ ok: false, error: `the proxy did not answer within ${timeoutMs} ms` }), timeoutMs)
    socket.on('data', chunk => (data += chunk))
    socket.on('end', () => {
      try {
        done(JSON.parse(data))
      } catch {
        done(undefined)
      }
    })
    socket.on('error', () => done(undefined))
    socket.write(`${JSON.stringify(request)}\n`)
  })
}

// The proxy of a wrapped server: the server's root process or one below it (the Volta node shim runs
// the real node as its child; both carry proxy.mjs on their command line, only the real one listens).
async function findProxy(procs, root) {
  for (const p of [root, ...descendants(procs, root)]) {
    if (!/proxy\.mjs/i.test(p.cmd)) continue
    const status = await askProxy(p.pid, { op: 'status' })
    if (status?.ok) return status
  }
  return undefined
}

// ------------------------------------------------------------------ configured servers

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

// ${VAR} and ${VAR:-default}, as Claude Code expands them in .mcp.json
const expand = (value, extra = {}) =>
  String(value).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, key, fallback) => extra[key] ?? process.env[key] ?? fallback ?? '')

function collect(list, servers, meta, extra) {
  for (const [name, def] of Object.entries(servers || {})) {
    if (!def || typeof def !== 'object' || !def.command) continue // http/sse servers: no local process to restart
    const wrapped = isWrapped(def)
    const entry = (run, variant) => ({
      name,
      ...meta,
      raw: def,
      wrapped,
      variant,
      command: expand(run.command, extra),
      args: (run.args || []).map(arg => expand(arg, extra)),
    })
    list.push(entry(def, false))
    // a session started before the server was wrapped runs it plain: know that form too
    if (wrapped) list.push(entry(innerOf(def), true))
  }
}

// every place Claude Code reads stdio servers from: user and local scope in ~/.claude.json, each known
// project's .mcp.json (plus extraProjects, folders no session has opened yet), and installed plugins
// (.mcp.json or plugin.json mcpServers)
export function loadConfigs(extraProjects = []) {
  const list = []
  const claudeJson = readJson(join(homedir(), '.claude.json')) || {}
  collect(list, claudeJson.mcpServers, { scope: 'user' })
  const projects = new Map() // ~/.claude.json keys a project once per spelling of its path
  for (const [project, settings] of Object.entries(claudeJson.projects || {})) {
    collect(list, settings?.mcpServers, { scope: 'local', project })
    const key = resolve(project).toLowerCase()
    if (!projects.has(key)) projects.set(key, project)
  }
  for (const project of extraProjects) if (!projects.has(resolve(project).toLowerCase())) projects.set(resolve(project).toLowerCase(), project)
  for (const project of projects.values()) collect(list, readJson(join(project, '.mcp.json'))?.mcpServers, { scope: 'project', project })
  const plugins = readJson(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'))?.plugins || {}
  for (const [plugin, installs] of Object.entries(plugins)) {
    for (const { installPath } of installs || []) {
      const extra = { CLAUDE_PLUGIN_ROOT: installPath }
      const mcpJson = readJson(join(installPath, '.mcp.json'))
      collect(list, mcpJson?.mcpServers ?? mcpJson, { scope: `plugin ${plugin}` }, extra)
      const declared = readJson(join(installPath, '.claude-plugin', 'plugin.json'))?.mcpServers
      const servers = typeof declared === 'string' ? readJson(resolve(installPath, expand(declared, extra))) : declared
      collect(list, servers?.mcpServers ?? servers, { scope: `plugin ${plugin}` }, extra)
    }
  }
  return list
}

// ------------------------------------------------------------------ wrapped configs

const isProxyPath = arg => /mcp-restart[\\/]proxy\.mjs$/i.test(String(arg))
export const isWrapped = def => (def.args || []).some(isProxyPath)

// the server a wrapped config runs: what comes after the proxy's `--`
export function innerOf(def) {
  const args = def.args || []
  const at = args.findIndex(isProxyPath)
  if (at < 0) return def
  const split = args.indexOf('--', at)
  return split < 0 ? def : { ...def, command: args[split + 1], args: args.slice(split + 2) }
}

export function wrapDef(name, def, { startTimeoutMs } = {}) {
  const { command, args = [], type, ...rest } = def
  const own = ['--name', name, ...(startTimeoutMs ? ['--start-timeout', String(startTimeoutMs)] : [])]
  return { type: 'stdio', command: 'node', args: [proxyForConfigs(), ...own, '--', command, ...args], ...rest }
}

export function unwrapDef(def) {
  const inner = innerOf(def)
  const { type, ...rest } = inner
  return { type: 'stdio', ...rest }
}

// ------------------------------------------------------------------ matching processes to servers

const norm = s => String(s).replace(/"/g, '').replace(/\//g, '\\').replace(/\s+/g, ' ').trim().toLowerCase()
const stem = command => basename(norm(command)).replace(/\.(exe|cmd|bat|ps1)$/, '')

// A process is a configured server when its command line holds the command's name and every argument.
// The most specific match wins (longest matched text); equal matches are the same server registered
// under several scopes (ghidra in ~/.claude.json and in a project's .mcp.json).
export function matchConfigs(proc, configs) {
  const cmd = norm(proc.cmd)
  let best = []
  let bestScore = 0
  for (const config of configs) {
    if (!cmd.includes(stem(config.command))) continue
    const command = norm(config.command)
    const args = config.args.map(norm).filter(Boolean)
    if (args.length === 0 && !cmd.includes(command)) continue // without arguments the command alone must match
    if (!args.every(arg => cmd.includes(arg))) continue
    const score = args.reduce((sum, arg) => sum + arg.length, 0) + (cmd.includes(command) ? command.length : 0)
    if (score > bestScore) [best, bestScore] = [[config], score]
    else if (score === bestScore) best.push(config)
  }
  return best
}

// ------------------------------------------------------------------ staleness

const changedAt = path => {
  try {
    const stat = statSync(path)
    return Math.max(stat.mtimeMs, stat.birthtimeMs) // npm packs files with a 1985 mtime: install time is the birth time
  } catch {
    return 0
  }
}

// Paths whose change means a running server is out of date: the command and script files, the
// lockfile npm rewrites on every install or update, a venv's site-packages folder, and uv.lock of a
// `uv --directory` project. npx/uvx packages have nothing local to compare.
function watchedPaths(config) {
  const paths = new Set()
  const base = config.project && existsSync(config.project) ? config.project : undefined
  const inner = innerOf(config)
  for (const raw of [inner.command, ...inner.args]) {
    if (!/[\\/]/.test(raw)) continue // a bare word or flag, not a path
    const path = isAbsolute(raw) ? raw : base && resolve(base, raw)
    if (!path || !existsSync(path)) continue
    let dir = path
    if (statSync(path).isFile()) {
      paths.add(path)
      dir = dirname(path)
    } else {
      paths.add(join(path, 'uv.lock'))
    }
    for (let hops = 0; hops < 4; hops++) {
      for (const marker of [join(dir, 'node_modules', '.package-lock.json'), join(dir, '.venv', 'Lib', 'site-packages'), join(dir, 'Lib', 'site-packages')])
        if (existsSync(marker)) paths.add(marker)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return [...paths].filter(path => existsSync(path))
}

export function staleness(config, started) {
  const paths = started ? watchedPaths(config) : []
  if (paths.length === 0) return { stale: null }
  const newest = paths.reduce((a, b) => (changedAt(b) > changedAt(a) ? b : a))
  const at = changedAt(newest)
  return { stale: at > started.getTime() + 2000, changed: newest, changedAt: new Date(at) }
}

// ------------------------------------------------------------------ discover and restart

async function serversOf(session, procs, configs) {
  const found = []
  for (const child of procs) {
    if (child.ppid !== session.pid) continue
    if (child.started && session.started && child.started < session.started) continue // a reused parent pid
    const matches = matchConfigs(child, configs)
    if (matches.length === 0) continue // the session's shell-tool processes and the like
    found.push({ child, matches })
  }
  const servers = await Promise.all(
    found.map(async ({ child, matches }) => {
      const names = [...new Set(matches.map(m => m.name))]
      // through the proxy only when the process matched the wrapped form, not the plain one
      const proxy = matches.some(m => m.wrapped && !m.variant) ? await findProxy(procs, child) : undefined
      // the server answering this very call: the MCP server itself, plain or behind its proxy
      const me = child.pid === process.pid || (proxy !== undefined && String(proxy.proxyPid) === process.env.MCP_RESTART_PROXY_PID)
      // a wrapped server's own start, not the proxy's: what its files are compared with
      const started = proxy?.serverStartedAt ? new Date(proxy.serverStartedAt) : child.started
      return {
        names,
        scope: [...new Set(matches.map(m => m.scope.split(' ')[0]))].join('|'),
        pid: child.pid,
        started,
        cmd: child.cmd,
        self: names.includes(SELF_NAME),
        me,
        wrapped: matches.some(m => m.wrapped),
        proxy,
        ...staleness(matches[0], started),
      }
    }),
  )
  return servers.sort((a, b) => a.names[0].localeCompare(b.names[0]))
}

// this session only, unless allSessions or there is no session above this process (a plain terminal)
export async function discover({ allSessions = false } = {}) {
  const procs = await snapshot()
  const configs = loadConfigs()
  const own = findOwnSession(procs)
  const sessions = procs.filter(isSession).filter(s => allSessions || !own || s.pid === own.pid)
  return { own, sessions: await Promise.all(sessions.map(async session => ({ session, servers: await serversOf(session, procs, configs) }))) }
}

async function restartOne(server, force) {
  if (server.proxy) {
    const result = await askProxy(server.proxy.proxyPid, { op: 'restart', force }, RESTART_TIMEOUT_MS)
    return { mode: 'swap', ok: result?.ok === true, result: result ?? { ok: false, error: 'the proxy did not answer' } }
  }
  // not wrapped, or a wrapped config this session started before it was wrapped
  return { mode: 'stop', ok: await killTree(server.pid) }
}

// spec: server names separated by commas, `stale` (files changed since start) or `all`. The server
// answering this call restarts itself last, and only behind its proxy (which lets it answer first);
// stopping it plain would break the very call that asked.
export async function restart(spec, { allSessions = false, force = false } = {}) {
  const { own, sessions } = await discover({ allSessions })
  const wanted = String(spec).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const targets = []
  const skipped = []
  for (const { session, servers } of sessions) {
    for (const server of servers) {
      const hit = wanted.includes('all') || (wanted.includes('stale') && server.stale) || server.names.some(n => wanted.includes(n.toLowerCase()))
      if (!hit) continue
      if (server.me && !server.proxy) skipped.push(server)
      else targets.push({ ...server, session: session.pid })
    }
  }
  const others = targets.filter(server => !server.me)
  const results = await Promise.all(others.map(async server => ({ ...server, ...(await restartOne(server, force)) })))
  for (const server of targets.filter(server => server.me)) results.push({ ...server, ...(await restartOne(server, force)) })
  // Give the session time to see a stopped server's exit: a call it sends before then goes down the dead
  // pipe and fails with "Connection closed"; one sent after it notices starts the server again.
  if (results.some(r => r.mode === 'stop' && r.ok)) await sleep(SETTLE_MS)
  const found = new Set([...results, ...skipped].flatMap(r => r.names.map(n => n.toLowerCase())))
  const missing = wanted.filter(w => w !== 'all' && w !== 'stale' && !found.has(w))
  return { own, results, missing, skipped }
}

// ------------------------------------------------------------------ wrap and unwrap configs

// the desktop app's Claude Code (the `claude` on PATH may be older); its own `claude mcp` writes
// ~/.claude.json, which running sessions write too
function claudeExe() {
  const root = join(process.env.APPDATA || '', 'Claude', 'claude-code')
  const found = []
  try {
    for (const version of readdirSync(root)) {
      for (const build of readdirSync(join(root, version))) {
        const exe = join(root, version, build, 'claude.exe')
        if (existsSync(exe)) found.push({ exe, at: statSync(exe).mtimeMs })
      }
    }
  } catch {
    // no desktop app: the claude on PATH
  }
  return found.sort((a, b) => b.at - a.at)[0]?.exe
}

async function claudeMcp(args, cwd) {
  const exe = claudeExe()
  const { stdout, stderr } = exe
    ? await run(exe, ['mcp', ...args], { cwd, windowsHide: true })
    : await run('claude', ['mcp', ...args], { cwd, windowsHide: true, shell: true })
  return `${stdout}${stderr}`.trim()
}

function backup(file) {
  if (!existsSync(file)) return undefined
  const copy = `${file}.mcp-restart-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  copyFileSync(file, copy)
  return copy
}

// spec: server names separated by commas, or `all`; scope: limit to user, local or project
export async function rewrap(spec, { unwrap = false, scope, project, startTimeoutMs, dryRun = false } = {}) {
  assertSupported()
  const wanted = String(spec).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const all = loadConfigs(project ? [project] : []).filter(
    c =>
      !c.variant &&
      ['user', 'local', 'project'].includes(c.scope) &&
      (wanted.includes('all') || wanted.includes(c.name.toLowerCase())) &&
      (!scope || c.scope === scope) &&
      (!project || resolve(c.project ?? '').toLowerCase() === resolve(project).toLowerCase()) &&
      isWrapped(c.raw) === unwrap,
  )
  // A server whose program is not on this machine cannot run here anyway: a config that came with a
  // cloned repository (another person's paths) is left as its author wrote it.
  const absentPath = c => [c.command, ...c.args].find(arg => /^[a-z]:[\\/]/i.test(arg) && !existsSync(arg))
  const skipped = unwrap ? [] : all.filter(c => absentPath(c) !== undefined)
  const configs = all.filter(c => !skipped.includes(c))
  const changes = skipped.map(c => ({ name: c.name, where: c.scope === 'user' ? 'user' : `${c.scope} ${c.project}`, ok: true, skipped: `not on this machine: ${absentPath(c)}` }))
  const backups = new Map() // file -> its copy, made once, before the first change
  const backupOnce = file => backups.has(file) || backups.set(file, backup(file))
  for (const config of configs) {
    const def = unwrap ? unwrapDef(config.raw) : wrapDef(config.name, config.raw, { startTimeoutMs })
    const where = config.scope === 'user' ? 'user' : `${config.scope} ${config.project}`
    if (dryRun) {
      changes.push({ name: config.name, where, ok: true, def })
      continue
    }
    try {
      if (config.scope === 'project') {
        const file = join(config.project, '.mcp.json')
        backupOnce(file)
        const json = JSON.parse(readFileSync(file, 'utf8'))
        json.mcpServers[config.name] = def
        writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
      } else {
        backupOnce(join(homedir(), '.claude.json'))
        const cwd = config.scope === 'local' ? config.project : homedir()
        await claudeMcp(['remove', config.name, '-s', config.scope], cwd)
        await claudeMcp(['add-json', config.name, JSON.stringify(def), '-s', config.scope], cwd)
      }
      changes.push({ name: config.name, where, ok: true })
    } catch (error) {
      changes.push({ name: config.name, where, ok: false, error: (error.stderr || error.message || '').toString().trim() })
    }
  }
  return { unwrap, changes, backups: [...backups.values()].filter(Boolean) }
}

// ------------------------------------------------------------------ text output

const clock = date => (date ? date.toTimeString().slice(0, 8) : '?')
const age = (date, now = Date.now()) => {
  if (!date) return '?'
  const s = Math.round((now - date) / 1000)
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`
}
const list = (names, max = 6) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`)

function describeServer(s) {
  const mode = (s.proxy ? `hot-swap g${s.proxy.generation ?? '?'}` : s.wrapped ? 'wrapped, not live' : 'stop only') + (s.me ? ' (this tool)' : '')
  const state = s.stale === true ? `STALE: ${basename(s.changed)} changed ${clock(s.changedAt)}` : s.stale === false ? 'current' : ''
  const busy = (s.proxy?.inflight ?? []).map(c => `${c.tool ?? c.method} running ${age(Date.now() - c.ms)}`)
  const down = s.proxy && s.proxy.state !== 'running' ? s.proxy.state : ''
  return [mode.padEnd(16), state, down, busy.join('; ')].filter(Boolean).join('  ')
}

export function formatList({ own, sessions }) {
  if (sessions.length === 0) return 'No running Claude Code session found.'
  const blocks = sessions.map(({ session, servers }) => {
    const version = session.exe?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '?'
    const head =
      `Session pid ${session.pid} (Claude Code ${version}, started ${clock(session.started)})` +
      `${own?.pid === session.pid ? ', this session' : ''}: ${servers.length} stdio servers running`
    const rows = servers.map(s => `  ${s.names.join('|').padEnd(22)} ${s.scope.padEnd(13)} up ${age(s.started).padEnd(5)} ${describeServer(s)}`)
    return [head, ...rows].join('\n')
  })
  blocks.push(
    'hot-swap: wrapped; a restart swaps it safely and the model sees new tools at once. stop only: not wrapped (node cli.mjs wrap <name>). ' +
      'wrapped, not live: wrapped after this session started; it swaps from the next session on. ' +
      'A configured server missing here is not running; Claude Code starts it on its next tool call.',
  )
  return blocks.join('\n\n')
}

function describeSwap(r) {
  const x = r.result
  if (!r.ok) {
    const stderr = x.stderr ? `\n    ${x.stderr.split('\n').slice(-6).join('\n    ')}` : ''
    return `${r.names.join('|')} did NOT restart: ${x.error}.${x.kept ? ' The running version keeps serving.' : ''}${stderr}`
  }
  const t = x.tools
  const changes = [
    t.added.length ? `new: ${list(t.added)}` : '',
    t.removed.length ? `removed: ${list(t.removed)}` : '',
    t.changed.length ? `changed: ${list(t.changed)}` : '',
  ].filter(Boolean)
  const interrupted = x.interrupted ? `, interrupted ${x.interrupted} call${x.interrupted > 1 ? 's' : ''}` : ''
  const draining = x.previous?.draining ? `, the old version finishes ${x.previous.draining} call${x.previous.draining > 1 ? 's' : ''} first` : ''
  return `Restarted ${r.names.join('|')} (generation ${x.generation}, ${(x.ms / 1000).toFixed(1)} s${interrupted}${draining}): ${t.count} tools${changes.length ? `; ${changes.join('; ')}` : ', unchanged'}. Available to the model now.`
}

export function formatRestart({ results, missing, skipped = [] }) {
  const lines = results.map(r =>
    r.mode === 'swap' ? describeSwap(r) : `${r.ok ? 'Stopped' : 'Could not stop'} ${r.names.join('|')} (pid ${r.pid}, not wrapped${r.wrapped ? ' in this session' : ''}).`,
  )
  for (const s of skipped)
    lines.push(`${s.names.join('|')} not restarted: this session runs it unwrapped, and stopping it would end this very call. Restart it from the MCP servers pane or the CLI, or wait for a new session.`)
  if (missing.length) lines.push(`Not running: ${missing.join(', ')}. If it is configured, its next tool call starts it with the current code anyway.`)
  if (lines.length === 0) lines.push('Nothing matched: no server was restarted.')
  if (results.some(r => r.mode === 'stop' && r.ok)) lines.push(STOP_NOTE)
  return lines.join('\n')
}

export function formatRewrap({ unwrap, changes, backups }) {
  const verb = unwrap ? 'Unwrapped' : 'Wrapped'
  const lines = changes.map(c =>
    c.skipped ? `Left ${c.name} (${c.where}): ${c.skipped}` : c.ok ? `${verb} ${c.name} (${c.where})${c.def ? `: ${JSON.stringify(c.def)}` : ''}` : `FAILED ${c.name} (${c.where}): ${c.error}`,
  )
  if (lines.length === 0) lines.push(`Nothing to ${unwrap ? 'unwrap' : 'wrap'}: no matching stdio server ${unwrap ? 'is wrapped' : 'is unwrapped'}.`)
  if (backups.length) lines.push(`Backups: ${backups.join(', ')}`)
  if (changes.some(c => c.ok && !c.def && !c.skipped)) lines.push('New sessions start these servers this way; running sessions keep how they started them.')
  return lines.join('\n')
}

// --json output, what the desktop mod's pane reads
const serverJson = s => ({
  name: s.names.join('|'),
  scope: s.scope,
  pid: s.pid,
  started: s.started?.toISOString() ?? null,
  stale: s.stale,
  changed: s.changed ? basename(s.changed) : null,
  self: s.self,
  me: s.me ?? false,
  wrapped: s.wrapped,
  live: s.proxy !== undefined,
  generation: s.proxy?.generation ?? null,
  state: s.proxy?.state ?? null,
  inflight: s.proxy?.inflight ?? [],
  lastError: s.proxy?.lastError?.message ?? null,
})

export const listJson = ({ own, sessions }) => ({
  sessions: sessions.map(({ session, servers }) => ({
    pid: session.pid,
    version: session.exe?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null,
    started: session.started?.toISOString() ?? null,
    isOwn: own?.pid === session.pid,
    servers: servers.map(serverJson),
  })),
})

export const restartJson = outcome => ({
  results: outcome.results.map(r => ({ ...serverJson(r), session: r.session, mode: r.mode, ok: r.ok, result: r.result ?? null })),
  missing: outcome.missing,
  text: formatRestart(outcome),
})
