// A call the server is running, as its proxy reports it.
export type ServerCall = { method: string; tool: string | null; ms: number; generation: number }

// One running stdio server of this session, as `node cli.mjs list --json` reports it.
export type ServerRow = {
  name: string
  scope: string
  pid: number
  started: string | null
  stale: boolean | null
  changed: string | null
  self: boolean
  // its config runs proxy.mjs; live: this session started it that way, so it hot-swaps
  wrapped: boolean
  live: boolean
  generation: number | null
  state: string | null
  inflight: ServerCall[]
  lastError: string | null
}

export type PaneView = {
  servers: ServerRow[]
  // stopped (not wrapped) and not running again yet: Claude Code starts each on its next tool call
  stopped: string[]
  session: string | null
  checkedAt: string | null
  busy: string | null
  message: string | null
}

// An MCP tool call of the model's in flight, for the hang watchdog above the prompt.
export type ModelCall = { id: string; tool: string; server: string; since: number }

// A server added to the config after this session started, which late-host.mjs runs for the session.
export type LateServerRow = {
  name: string
  scope: string
  // starting, running, restarting, down (exited; the next call starts it), failed, stopped
  state: string
  // the tool names on the server; the model calls each as mcp__mcp-restart__<server>__<tool>
  tools: string[]
  generation: number
  error: string | null
}

export type LateView = {
  // the servers this session started itself, worked out once per session; null until then
  baseline: string[] | null
  reason: string | null
  servers: LateServerRow[]
  // why the host is not running, when it is not
  hostError: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'mcp-restart': { view: Shaped<PaneView>; calls: Shaped<ModelCall[]>; tick: number; late: Shaped<LateView> }
  }
}
