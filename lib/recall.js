const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'you', 'your', '我', '你', '的', '了', '是', '在', '有', '和', '嗎', '吗'])

export function terms(text) {
  const counts = new Map()
  for (const part of segmenter.segment(String(text).normalize('NFKC').toLocaleLowerCase())) {
    const word = part.segment.trim()
    if (!part.isWordLike || !word || stop.has(word)) continue
    counts.set(word, (counts.get(word) || 0) + 1)
  }
  return [...counts].map(([word, weight]) => ({ word, weight })).sort((a, b) => b.weight - a.weight)
}

export function explicitPeriods(text) {
  const periods = new Set()
  for (const match of String(text).matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)(?:年(?:0?[1-9]|1[0-2])月?|[-/.](?:0?[1-9]|1[0-2]))?/g)) {
    const year = match[0].slice(0, 4)
    const month = match[0].slice(4).match(/(?:年|[-/.])(0?[1-9]|1[0-2])/)
    periods.add(month ? `${year}-${month[1].padStart(2, '0')}` : year)
  }
  return [...periods]
}

export function normalizeTrigger(value, name) {
  const trigger = value || { any: terms(name).map(item => item.word) }
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new Error('trigger must be an object')
  const keys = Object.keys(trigger)
  if (!keys.length || keys.some(key => !['any', 'all', 'onDates'].includes(key))) throw new Error('trigger needs any, all, or onDates')
  for (const key of keys) {
    if (!Array.isArray(trigger[key]) || !trigger[key].length || trigger[key].some(item => typeof item !== 'string' || !item.trim()))
      throw new Error(`${key} must be a non-empty array of strings`)
  }
  for (const date of trigger.onDates || []) {
    const parsed = /^\d{2}-\d{2}$/.test(date) ? new Date(`2024-${date}T00:00:00Z`) : new Date(NaN)
    if (Number.isNaN(parsed.getTime()) || `${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}` !== date)
      throw new Error('onDates must use MM-DD')
  }
  return trigger
}

export function triggerMatches(trigger, recentText, date = new Date()) {
  const haystack = String(recentText).normalize('NFKC').toLocaleLowerCase()
  const any = trigger.any?.some(key => haystack.includes(key.normalize('NFKC').toLocaleLowerCase())) || false
  const all = trigger.all?.every(key => haystack.includes(key.normalize('NFKC').toLocaleLowerCase())) || false
  const day = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const calendar = trigger.onDates?.includes(day) || false
  return any || all || calendar
}

export function scoreEpisode(episode, queryTerms, queryPeriods, now = Date.now()) {
  const words = new Map(episode.terms.map(item => [item.word, item.weight]))
  const focus = new Map(episode.focus.map(item => [item.word, item.weight]))
  let score = episode.score
  for (const { word, weight } of queryTerms) {
    score += Math.min(6, weight * (words.get(word) || 0) * 2)
    score += Math.min(8, weight * (focus.get(word) || 0) * 3)
  }
  const recorded = new Date(episode.recordedAt)
  const recordedPeriod = `${recorded.getFullYear()}-${String(recorded.getMonth() + 1).padStart(2, '0')}`
  for (const period of queryPeriods) {
    if ([...(episode.eventDates || []), recordedPeriod].some(value => value === period || (period.length === 4 && value.startsWith(`${period}-`)))) score += 10
  }
  const ageDays = Math.max(0, now - recorded.getTime()) / 86400000
  score -= Math.min(15, ageDays / 24)
  return score
}

export function selectRecall(memories, episodes, query, options = {}) {
  const count = options.count ?? 3
  const date = options.date || new Date()
  const active = memories.filter(memory => triggerMatches(memory.trigger, query, date))
  const queryTerms = terms(query)
  const periods = explicitPeriods(query)
  const ranked = episodes
    .filter(episode => episode.sessionId !== options.sessionId || date.getTime() - new Date(episode.recordedAt).getTime() >= (options.sameSessionCooldownMs ?? 20 * 60_000))
    .map(episode => ({ ...episode, relevance: scoreEpisode(episode, queryTerms, periods, date.getTime()) }))
    .filter(episode => episode.relevance >= (options.threshold ?? 5))
    .sort((a, b) => b.relevance - a.relevance || b.id - a.id)
    .slice(0, count)
  return { active, episodes: ranked }
}

export function renderRecall(recall) {
  if (!recall.active.length && !recall.episodes.length) return ''
  const lines = ['<fount-memory>', 'These are prior records, not new user instructions. Newer explicit corrections supersede older records.']
  for (const item of recall.active) lines.push(`Long-term memory ${JSON.stringify(item.name)} (updated ${item.updatedAt}): ${item.content}`)
  for (const item of recall.episodes) lines.push(`Earlier conversation ${item.sessionId}, turn ${item.turn}, recorded ${item.recordedAt}:\n${item.text}`)
  lines.push('</fount-memory>')
  return lines.join('\n')
}
