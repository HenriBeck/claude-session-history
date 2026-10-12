// Fills the session history from the transcripts Claude Code keeps under `<config dir>/projects`, so sessions
// from before the mod recorded them can be found and resumed with /sessions.
//
// Usage: node scripts/backfill.mjs [--dry-run]      (Node 23.6 or later: it imports the mod's TypeScript)
//
// A session the history already holds keeps its better name and widest span (mergeRecords). Each written file's
// modification time is set to the session's last message, the order /sessions reads the history in.

import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  addTranscriptEntry,
  assertSessionId,
  emptyTranscriptSummary,
  mergeRecords,
  parseRecord,
  recordFromTranscript,
} from '../hooks/history.ts'

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

const isDryRun = process.argv.includes('--dry-run')
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

const counts = { created: 0, updated: 0, unchanged: 0 }
const skipped = new Map()
const problems = []
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
    const text = serialize(merged)

    if (existing !== null && serialize(existing) === text) {
      counts.unchanged += 1
      continue
    }

    counts[existing === null ? 'created' : 'updated'] += 1

    if (isDryRun) {
      console.log(`${existing === null ? 'create' : 'update'}  ${merged.lastMessageAt}  ${merged.name ?? id}  (${merged.cwd})`)
      continue
    }

    const lastMessage = new Date(merged.lastMessageAt ?? merged.createdAt)

    await mkdir(historyDir, { recursive: true })
    await writeFile(target, text)
    await utimes(target, lastMessage, lastMessage)
  }
}

const verb = isDryRun ? 'Would write' : 'Wrote'

console.log(`${verb} ${counts.created} new and ${counts.updated} updated session(s) to ${historyDir}; ${counts.unchanged} unchanged.`)

for (const [reason, count] of skipped) {
  console.log(`Skipped ${count} transcript(s): ${reason}`)
}

for (const problem of problems) {
  console.warn(`warning: ${problem}`)
}
