// Fills the session history from the transcripts Claude Code keeps under `<config dir>/projects`, so sessions
// from before the plugin recorded them can be found and resumed with /sessions. With --label it then asks Haiku,
// through `claude -p`, to label every session still unlabeled complete or pending, as the plugin does at close.
//
// Usage: node scripts/backfill.mjs [--dry-run] [--label]      (Node 23.6 or later: it imports the plugin's TypeScript)
//
// A session the history already holds keeps its better name, widest span and label (mergeRecords). Each written
// file's modification time is set to the session's last message, the order /sessions reads the history in.

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  addTranscriptEntry,
  assertSessionId,
  conversationExcerpt,
  emptyTranscriptSummary,
  mergeRecords,
  parseRecord,
  recordFromTranscript,
} from '../hooks/history.ts'
import { LABEL_MODEL, labelPrompt, parseLabel } from '../hooks/label.ts'

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const LABEL_CONCURRENCY = 4
const LABEL_TIMEOUT_MS = 60_000

const isDryRun = process.argv.includes('--dry-run')
const isLabeling = process.argv.includes('--label')
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const projectsDir = join(configDir, 'projects')
const historyDir = join(configDir, 'session-history')

/**
 * Reads a transcript line by line; a line that is not JSON (a write cut short) is counted, not read.
 */
async function summarizeTranscript(path) {
  const summary = emptyTranscriptSummary()
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  let malformed = 0

  for await (const line of lines) {
    if (line.trim() === '') {
      continue
    }

    let entry

    try {
      entry = JSON.parse(line)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }

      malformed += 1
      continue
    }

    addTranscriptEntry(summary, entry)
  }

  return { summary, malformed }
}

async function readExisting(path) {
  try {
    return parseRecord(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`
}

async function writeRecord(path, record) {
  const lastMessage = new Date(record.lastMessageAt ?? record.createdAt)

  await mkdir(historyDir, { recursive: true })
  await writeFile(path, serialize(record))
  await utimes(path, lastMessage, lastMessage)
}

/**
 * One `claude -p` call with no tools, MCP servers, user settings or skills: the reply's text.
 */
function askClaude(system, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', LABEL_MODEL,
      '--no-session-persistence',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--disable-slash-commands',
      '--system-prompt', system,
    ]
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: LABEL_TIMEOUT_MS })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout)
      } else if (signal !== null) {
        reject(new Error(`claude was stopped by ${signal} (${LABEL_TIMEOUT_MS / 1000} s limit)`))
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 300)}`))
      }
    })
    child.stdin.end(prompt)
  })
}

async function label(item, cwd) {
  const { system, prompt } = labelPrompt(item.excerpt)
  const reply = await askClaude(system, prompt, cwd)
  const status = parseLabel(reply)

  if (status === null) {
    throw new Error(`unexpected reply ${JSON.stringify(reply.trim().slice(0, 100))}`)
  }

  const current = parseRecord(await readFile(item.target, 'utf8'), item.target)

  await writeRecord(item.target, { ...current, status, labelError: null })

  return status
}

/**
 * Labels `items` a few at a time, printing each result as it comes.
 */
async function labelAll(items) {
  const cwd = await mkdtemp(join(tmpdir(), 'session-history-label-'))
  const results = { complete: 0, pending: 0, failed: [] }
  let next = 0

  async function worker() {
    while (next < items.length) {
      const item = items[next]

      next += 1

      try {
        const status = await label(item, cwd)

        results[status] += 1
        console.log(`${status.padEnd(8)} ${item.name}`)
      } catch (error) {
        results.failed.push(`${item.id}: ${error.message}`)
        console.log(`failed   ${item.name}`)
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: LABEL_CONCURRENCY }, worker))
  } finally {
    await rm(cwd, { recursive: true })
  }

  return results
}

const counts = { created: 0, updated: 0, unchanged: 0 }
const skipped = new Map()
const problems = []
const toLabel = []
const folders = (await readdir(projectsDir, { withFileTypes: true })).filter(entry => entry.isDirectory())

for (const folder of folders) {
  const transcripts = (await readdir(join(projectsDir, folder.name))).filter(name => SESSION_FILE.test(name))

  for (const file of transcripts) {
    const id = assertSessionId(basename(file, '.jsonl'))
    const transcript = join(projectsDir, folder.name, file)
    const { summary, malformed } = await summarizeTranscript(transcript)

    if (malformed > 0) {
      problems.push(`${transcript}: skipped ${malformed} line(s) that are not JSON`)
    }

    const result = recordFromTranscript(id, folder.name, summary)

    if ('skip' in result) {
      skipped.set(result.skip, (skipped.get(result.skip) ?? 0) + 1)
      continue
    }

    if (result.isCwdGuessed) {
      problems.push(`${transcript}: no directory it names matches its folder; using ${result.record.cwd}`)
    }

    const target = join(historyDir, `${id}.json`)
    let existing

    try {
      existing = await readExisting(target)
    } catch (error) {
      problems.push(`${target}: left as it is, it could not be read (${error.message})`)
      continue
    }

    const merged = mergeRecords(existing, result.record)

    if (isLabeling && merged.status === null) {
      const excerpt = conversationExcerpt(summary.tail)

      if (excerpt === '') {
        problems.push(`${transcript}: no conversation text to label`)
      } else {
        toLabel.push({ id, target, excerpt, name: merged.name ?? id })
      }
    }

    if (existing !== null && serialize(existing) === serialize(merged)) {
      counts.unchanged += 1
      continue
    }

    counts[existing === null ? 'created' : 'updated'] += 1

    if (isDryRun) {
      console.log(`${existing === null ? 'create' : 'update'}  ${merged.lastMessageAt}  ${merged.name ?? id}  (${merged.cwd})`)
      continue
    }

    await writeRecord(target, merged)
  }
}

const verb = isDryRun ? 'Would write' : 'Wrote'

console.log(`${verb} ${counts.created} new and ${counts.updated} updated session(s) to ${historyDir}; ${counts.unchanged} unchanged.`)

for (const [reason, count] of skipped) {
  console.log(`Skipped ${count} transcript(s): ${reason}`)
}

if (isLabeling && isDryRun) {
  console.log(`Would label ${toLabel.length} session(s).`)
} else if (isLabeling) {
  const results = await labelAll(toLabel)

  console.log(`Labeled ${results.complete} complete and ${results.pending} pending; ${results.failed.length} failed.`)

  for (const failure of results.failed) {
    problems.push(`label ${failure}`)
  }
}

for (const problem of problems) {
  console.warn(`warning: ${problem}`)
}
