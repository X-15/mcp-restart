#!/usr/bin/env node
// mcp-restart from a terminal: the same as the MCP server's tools, plus wrapping servers in the proxy.
//   node cli.mjs list [--all] [--json]
//   node cli.mjs restart <name[,name...]|stale|all> [--force] [--all] [--json]
//   node cli.mjs wrap <name[,name...]|all> [--scope user|local|project] [--project <dir>] [--start-timeout <ms>] [--dry-run]
//   node cli.mjs unwrap <name[,name...]|all> [--scope ...] [--project <dir>] [--dry-run]
// Run from a Claude Code session's shell tool (or a mod's $.process.run) list and restart act on that
// session (--all: every session); run from a plain terminal they act on every running session.
// --force interrupts the calls a server is running (a hung server); without it the old server finishes them.
import { discover, formatList, formatRestart, formatRewrap, listJson, proxyForConfigs, restart, restartJson, rewrap } from './lib.mjs'

const [command, ...rest] = process.argv.slice(2)
const flag = name => rest.includes(name)
const option = name => {
  const at = rest.indexOf(name)
  return at >= 0 ? rest[at + 1] : undefined
}
const valued = new Set(['--scope', '--project', '--start-timeout'])
const target = rest.find((arg, i) => !arg.startsWith('--') && !valued.has(rest[i - 1]))
const asJson = flag('--json')

const usage = [
  'usage: node cli.mjs list [--all] [--json]',
  '       node cli.mjs restart <name[,name...]|stale|all> [--force] [--all] [--json]',
  '       node cli.mjs wrap <name[,name...]|all> [--scope user|local|project] [--project <dir>] [--start-timeout <ms>] [--dry-run]',
  '       node cli.mjs unwrap <name[,name...]|all> [--scope ...] [--project <dir>] [--dry-run]',
].join('\n')

try {
  proxyForConfigs() // an installed plugin: keep the proxy wrapped configs run in step with this version
  if (command === 'list') {
    const found = await discover({ allSessions: flag('--all') })
    console.log(asJson ? JSON.stringify(listJson(found)) : formatList(found))
  } else if (command === 'restart' && target) {
    const outcome = await restart(target, { allSessions: flag('--all'), force: flag('--force') })
    console.log(asJson ? JSON.stringify(restartJson(outcome)) : formatRestart(outcome))
    process.exitCode = outcome.results.every(r => r.ok) ? 0 : 1
  } else if ((command === 'wrap' || command === 'unwrap') && target) {
    const outcome = await rewrap(target, {
      unwrap: command === 'unwrap',
      scope: option('--scope'),
      project: option('--project'),
      startTimeoutMs: Number(option('--start-timeout')) || undefined,
      dryRun: flag('--dry-run'),
    })
    console.log(asJson ? JSON.stringify(outcome) : formatRewrap(outcome))
    process.exitCode = outcome.changes.every(c => c.ok) ? 0 : 1
  } else {
    console.error(usage)
    process.exitCode = 2
  }
} catch (error) {
  console.error(`mcp-restart: ${error.message}`)
  process.exitCode = 1
}
