#!/usr/bin/env node
// Sends one control request to a running proxy and prints its answer.
//   node test/pipe.mjs <proxy pid> '{"op":"status"}'
import { connect } from 'node:net'

const [pid, request = '{"op":"status"}'] = process.argv.slice(2)
const socket = connect(`\\\\.\\pipe\\mcp-restart-${pid}`)
let data = ''
socket.on('data', chunk => (data += chunk))
socket.on('end', () => console.log(JSON.stringify(JSON.parse(data), null, 2)))
socket.on('error', error => {
  console.error(error.message)
  process.exitCode = 1
})
socket.write(`${request}\n`)
