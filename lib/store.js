import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const iso = () => new Date().toISOString()
const parse = value => value == null ? null : JSON.parse(value)

export function databasePath(config, cwd) {
  const root = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'fount-memory')
  const workspace = config.scope === 'global' ? 'global' : resolve(cwd)
  const key = createHash('sha256').update(`${config.namespace || 'default'}\0${workspace}`).digest('hex')
  return join(isAbsolute(root) ? root : resolve(root), `${key}.sqlite`)
}

export class MemoryStore {
  constructor(filename) {
    mkdirSync(resolve(filename, '..'), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        name TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_context TEXT NOT NULL,
        updated_context TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS revisions (
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        source_context TEXT NOT NULL,
        PRIMARY KEY (name, revision),
        FOREIGN KEY (name) REFERENCES memories(name) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        text TEXT NOT NULL,
        terms_json TEXT NOT NULL,
        focus_json TEXT NOT NULL,
        event_dates_json TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, turn)
      );
      CREATE INDEX IF NOT EXISTS episodes_recorded_at ON episodes(recorded_at);
    `)
  }

  close() { this.db.close() }

  putMemory({ name, content, trigger, context }) {
    name = name.trim()
    content = content.trim()
    if (!name || !content) throw new Error('name and content are required')
    const now = iso()
    const json = JSON.stringify(trigger)
    const previous = this.db.prepare('SELECT * FROM memories WHERE name = ?').get(name)
    if (previous && previous.content === content && previous.trigger_json === json) return { name, revision: previous.revision, changed: false }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (previous) {
        this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(name, previous.revision, previous.content, previous.trigger_json, previous.updated_at, now, previous.updated_context)
        this.db.prepare('UPDATE memories SET content = ?, trigger_json = ?, updated_at = ?, updated_context = ?, revision = revision + 1 WHERE name = ?')
          .run(content, json, now, context, name)
      } else {
        this.db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
          .run(name, content, json, now, now, context, context)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { name, revision: previous ? previous.revision + 1 : 1, changed: true }
  }

  getMemory(name) {
    const row = this.db.prepare('SELECT * FROM memories WHERE name = ?').get(name)
    if (!row) return null
    const revisions = this.db.prepare('SELECT * FROM revisions WHERE name = ? ORDER BY revision DESC').all(name)
    return {
      name: row.name, content: row.content, trigger: parse(row.trigger_json),
      createdAt: row.created_at, updatedAt: row.updated_at,
      createdContext: row.created_context, updatedContext: row.updated_context,
      revision: row.revision,
      revisions: revisions.map(item => ({ revision: item.revision, content: item.content, trigger: parse(item.trigger_json), validFrom: item.valid_from, validUntil: item.valid_until, sourceContext: item.source_context }))
    }
  }

  allMemories() {
    return this.db.prepare('SELECT name, content, trigger_json, updated_at FROM memories ORDER BY updated_at DESC').all()
      .map(row => ({ name: row.name, content: row.content, trigger: parse(row.trigger_json), updatedAt: row.updated_at }))
  }

  forgetMemory(name) {
    return this.db.prepare('DELETE FROM memories WHERE name = ?').run(name).changes > 0
  }

  saveEpisode({ sessionId, turn, text, terms, focus, eventDates }) {
    return this.db.prepare('INSERT OR IGNORE INTO episodes (session_id, turn, recorded_at, text, terms_json, focus_json, event_dates_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, turn, iso(), text, JSON.stringify(terms), JSON.stringify(focus), JSON.stringify(eventDates)).changes > 0
  }

  episodes() {
    return this.db.prepare('SELECT * FROM episodes ORDER BY recorded_at DESC, id DESC').all().map(row => ({
      id: row.id, sessionId: row.session_id, turn: row.turn, recordedAt: row.recorded_at,
      text: row.text, terms: parse(row.terms_json), focus: parse(row.focus_json), eventDates: parse(row.event_dates_json), score: row.score
    }))
  }

  reinforce(ids, increments) {
    if (!ids.length) return
    const statement = this.db.prepare('UPDATE episodes SET score = score + ? WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (let index = 0; index < ids.length; index++) statement.run(increments[index], ids[index])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  forgetEpisodes(query) {
    const matches = this.episodes().filter(episode => episode.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    const statement = this.db.prepare('DELETE FROM episodes WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const episode of matches) statement.run(episode.id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return matches.length
  }

  forgetMatching(query) {
    const needle = query.toLocaleLowerCase()
    const names = this.allMemories().map(item => this.getMemory(item.name))
      .filter(item => [item.name, item.content, ...item.revisions.map(revision => revision.content)].some(text => text.toLocaleLowerCase().includes(needle)))
      .map(item => item.name)
    const episodes = this.episodes().filter(item => item.text.toLocaleLowerCase().includes(needle)).map(item => item.id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deleteName = this.db.prepare('DELETE FROM memories WHERE name = ?')
      const deleteEpisode = this.db.prepare('DELETE FROM episodes WHERE id = ?')
      for (const name of names) deleteName.run(name)
      for (const id of episodes) deleteEpisode.run(id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { memories: names.length, episodes: episodes.length }
  }
}
