import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  chooseCandidateWithHostedAi,
  getHostedRankerStatus,
} from './hosted-image-ranker.js'
import {
  chooseCandidateWithLocalAi,
  LocalImageRanker,
} from './local-image-ranker.js'
import { suggestRelatedItems } from './related-item-suggester.js'

const PORT = Number(process.env.PORT || 3001)
const USER_AGENT = 'ForgeTierlistBuilder/1.0'
const SEARCH_TIMEOUT_MS = 12_000
const HOSTED_CONFIDENCE_THRESHOLD = 0.58
const GOOGLE_API_KEY = ensureString(process.env.GOOGLE_API_KEY)
const GOOGLE_CSE_ID = ensureString(process.env.GOOGLE_CSE_ID)
const GOOGLE_GL = ensureString(process.env.GOOGLE_GL)
const GOOGLE_HL = ensureString(process.env.GOOGLE_HL)
const DISCORD_BOT_TOKEN = ensureString(process.env.DISCORD_BOT_TOKEN)
const DISCORD_CHANNEL_ID = ensureString(process.env.DISCORD_CHANNEL_ID)
const SOURCE_PROVIDER_KEYS = ['commons', 'wikipedia', 'openverse', 'google']
const RANKER_PROVIDER_KEYS = ['local', 'gemini', 'groq']

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.resolve(__dirname, '..', 'dist')

const app = express()

app.use(express.json({ limit: '12mb' }))

app.get('/api/health', (_request, response) => {
  const rankerStatus = LocalImageRanker.getStatus()
  const hostedStatus = getHostedRankerStatus()

  response.json({
    ok: true,
    mode: describeMode(rankerStatus, hostedStatus),
    providers: {
      ...hostedStatus,
      google: {
        configured: Boolean(GOOGLE_API_KEY && GOOGLE_CSE_ID),
      },
      local: {
        configured: rankerStatus.available,
        model: rankerStatus.model,
      },
    },
    integrations: {
      discord: {
        configured: Boolean(DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID),
      },
    },
    ranker: rankerStatus,
  })
})

app.post('/api/items/suggest', async (request, response) => {
  const title = ensureString(request.body?.title)
  const listContext = ensureString(request.body?.listContext)
  const limit = Number(request.body?.limit || 18)

  if (!title) {
    response.status(400).json({ error: 'title is required.' })
    return
  }

  try {
    const items = await suggestRelatedItems({
      limit,
      listContext,
      title,
    })

    response.json({
      items,
      title,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Item suggestion failed.'

    response.status(500).json({ error: message })
  }
})

app.post('/api/images/lookup', async (request, response) => {
  const itemName = ensureString(request.body?.itemName)
  const itemContext = ensureString(request.body?.itemContext)
  const listContext = ensureString(request.body?.listContext)
  const sourceProviders = normalizeSourceProviders(request.body?.sourceProviders)
  const rankerProviders = normalizeRankerProviders(request.body?.rankerProviders)

  if (!itemName) {
    response.status(400).json({ error: 'itemName is required.' })
    return
  }

  const searchQuery = buildSearchQuery(itemName, itemContext, listContext)
  const searchQueries = createSearchQueries(itemName, itemContext, listContext)

  try {
    const candidates = (await collectCandidates(searchQueries, sourceProviders)).slice(0, 10)

    if (!candidates.length) {
      response.status(404).json({
        error: `No image candidates were found for "${itemName}".`,
      })
      return
    }

    const heuristicSelection = chooseHeuristicCandidate({
      candidates,
      itemName,
    })
    let localSelection = null

    if (rankerProviders.includes('local')) {
      try {
        localSelection = await chooseCandidateWithLocalAi({
          candidates,
          itemContext,
          itemName,
          listContext,
        })
      } catch {}
    }

    const hostedStatus = getHostedRankerStatus()
    const hostedProviders = getHostedProviderOrder(rankerProviders, hostedStatus)
    let selection = localSelection

    if (shouldTryHostedFallback(localSelection, hostedProviders)) {
      try {
        selection = await chooseCandidateWithHostedAi({
          candidates: buildHostedShortlist(
            candidates,
            itemName,
            localSelection || heuristicSelection,
          ),
          itemContext,
          itemName,
          listContext,
          preferredProviders: hostedProviders,
        })
      } catch {
        selection = localSelection
      }
    }

    selection ||= heuristicSelection

    const chosen =
      candidates.find((candidate) => candidate.id === selection.candidateId) ||
      heuristicSelection.candidate

    response.json({
      query: searchQuery,
      result: toImageResult(chosen, {
        confidence: selection.confidence,
        matchMethod: selection.matchMethod,
        reason: selection.reason,
      }, itemName),
      candidates: rankCandidatesForPicker(candidates, itemName, chosen.id).map((candidate) =>
        toImageResult(candidate, {}, itemName),
      ),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Image lookup failed.'

    response.status(500).json({ error: message })
  }
})

app.post('/api/discord/share', async (request, response) => {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) {
    response.status(503).json({
      error:
        'Discord bot sharing is not configured. Add DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID on the server.',
    })
    return
  }

  const title = ensureString(request.body?.title) || 'Untitled tier list'
  const listContext = ensureString(request.body?.listContext)
  const imageDataUrl = ensureString(request.body?.imageDataUrl)

  if (!imageDataUrl) {
    response.status(400).json({ error: 'imageDataUrl is required.' })
    return
  }

  try {
    const attachment = parseImageDataUrl(
      imageDataUrl,
      `${slugifyFilename(title || 'tier-list')}.png`,
    )
    const result = await sendTierListToDiscord({
      attachment,
      listContext,
      title,
    })

    response.json(result)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Discord share failed.'

    response.status(500).json({ error: message })
  }
})

app.use(express.static(distPath))

app.use((request, response, next) => {
  if (request.path.startsWith('/api/')) {
    next()
    return
  }

  response.sendFile(path.join(distPath, 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Forge Tierlist Builder running on http://localhost:${PORT}`)
  LocalImageRanker.warm()
})

function describeMode(rankerStatus, hostedStatus) {
  const parts = []

  if (rankerStatus.ready) {
    parts.push('Local CLIP')
  } else if (rankerStatus.state === 'loading') {
    parts.push('CLIP warming')
  } else if (rankerStatus.state === 'error') {
    parts.push('Heuristic')
  } else if (rankerStatus.state === 'disabled') {
    parts.push('Hosted or heuristic')
  } else {
    parts.push('CLIP on demand')
  }

  if (hostedStatus.gemini.configured) {
    parts.push('Gemini')
  }

  if (hostedStatus.groq.configured) {
    parts.push('Groq')
  }

  return parts.join(' + ')
}

function ensureString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function slugifyFilename(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'tier-list'
}

function parseImageDataUrl(value, filename) {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)

  if (!match) {
    throw new Error('The exported board image was not in a supported format.')
  }

  const [, contentType, base64Payload] = match
  const bytes = Buffer.from(base64Payload, 'base64')

  if (!bytes.length) {
    throw new Error('The exported board image was empty.')
  }

  return {
    bytes,
    contentType,
    filename,
  }
}

function buildDiscordMessageContent(title, listContext) {
  const lines = [`Tier list: ${title}`]
  const summary = summarizeContext(listContext)

  if (summary) {
    lines.push(`Context: ${summary}`)
  }

  lines.push('Shared from Forge Tierlist.')

  return lines.join('\n').slice(0, 1800)
}

async function sendTierListToDiscord({ attachment, listContext, title }) {
  const form = new FormData()
  form.append(
    'payload_json',
    JSON.stringify({
      allowed_mentions: { parse: [] },
      content: buildDiscordMessageContent(title, listContext),
    }),
  )
  form.append(
    'files[0]',
    new Blob([attachment.bytes], { type: attachment.contentType }),
    attachment.filename,
  )

  const result = await fetch(
    `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'User-Agent': USER_AGENT,
      },
      body: form,
      signal: AbortSignal.timeout(20_000),
    },
  )

  if (!result.ok) {
    throw new Error(await readDiscordError(result))
  }

  const payload = await result.json()

  return {
    channelId: payload.channel_id,
    messageId: payload.id,
    ok: true,
  }
}

async function readDiscordError(result) {
  try {
    const payload = await result.json()
    if (typeof payload?.message === 'string' && payload.message) {
      return `Discord share failed: ${payload.message}`
    }
  } catch {}

  return `Discord share failed with status ${result.status}.`
}

function buildSearchQuery(itemName, itemContext, listContext) {
  const parts = [itemName, itemContext, summarizeContext(listContext)]
    .filter(Boolean)
    .map((part) => part.replace(/\s+/g, ' ').trim())

  return Array.from(new Set(parts)).join(' ')
}

function summarizeContext(value) {
  if (!value) {
    return ''
  }

  return value.split(/\r?\n/).join(' ').slice(0, 120).trim()
}

function createSearchQueries(itemName, itemContext, listContext) {
  return Array.from(
    new Set(
      [
        buildSearchQuery(itemName, itemContext, listContext),
        buildSearchQuery(itemName, itemContext, ''),
        itemName,
      ].filter(Boolean),
    ),
  )
}

async function collectCandidates(queries, sourceProviders) {
  const batches = await Promise.all(queries.map((query) => searchAcrossSources(query, sourceProviders)))

  return dedupeCandidates(batches.flat())
}

async function searchAcrossSources(query, sourceProviders) {
  const tasks = []

  if (sourceProviders.includes('commons')) {
    tasks.push(searchWikimediaCommons(query))
  }

  if (sourceProviders.includes('wikipedia')) {
    tasks.push(searchWikipedia(query))
  }

  if (sourceProviders.includes('openverse')) {
    tasks.push(searchOpenverse(query))
  }

  if (sourceProviders.includes('google')) {
    tasks.push(searchGoogleImages(query))
  }

  const results = await Promise.all(tasks)
  return dedupeCandidates(results.flat())
}

async function searchWikimediaCommons(query) {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('generator', 'search')
  url.searchParams.set('gsrsearch', query)
  url.searchParams.set('gsrnamespace', '6')
  url.searchParams.set('gsrlimit', '8')
  url.searchParams.set('prop', 'imageinfo|info')
  url.searchParams.set('iiprop', 'url')
  url.searchParams.set('iiurlwidth', '480')
  url.searchParams.set('inprop', 'url')
  url.searchParams.set('origin', '*')

  const result = await fetchJson(url)
  const pages = Object.values(result?.query?.pages || {})
    .filter((page) => page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url)
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))

  return pages.map((page) => {
    const imageInfo = page.imageinfo?.[0] || {}

    return {
      attribution: `Image from Wikimedia Commons file "${page.title}"`,
      creator: '',
      height: imageInfo.thumbheight || imageInfo.height,
      id: `commons:${page.pageid}`,
      license: 'Wikimedia Commons terms',
      previewUrl: imageInfo.thumburl || imageInfo.url,
      provider: 'Wikimedia Commons',
      sourceUrl: imageInfo.descriptionurl || page.fullurl || imageInfo.url,
      title: formatCommonsTitle(page.title),
      width: imageInfo.thumbwidth || imageInfo.width,
    }
  })
}

async function searchWikipedia(query) {
  const url = new URL('https://en.wikipedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('generator', 'search')
  url.searchParams.set('gsrsearch', query)
  url.searchParams.set('gsrlimit', '8')
  url.searchParams.set('prop', 'pageimages|info')
  url.searchParams.set('inprop', 'url')
  url.searchParams.set('pithumbsize', '480')
  url.searchParams.set('origin', '*')

  const result = await fetchJson(url)
  const pages = Object.values(result?.query?.pages || {})
    .filter((page) => page.thumbnail?.source && page.fullurl)
    .sort((left, right) => left.index - right.index)

  return pages.map((page) => ({
    attribution: `Image from Wikipedia article "${page.title}"`,
    creator: 'Wikipedia contributors',
    height: page.thumbnail.height,
    id: `wiki:${page.pageid}`,
    license: 'Wikipedia terms',
    previewUrl: page.thumbnail.source,
    provider: 'Wikipedia',
    sourceUrl: page.fullurl,
    title: page.title,
    width: page.thumbnail.width,
  }))
}

async function searchOpenverse(query) {
  const url = new URL('https://api.openverse.org/v1/images/')
  url.searchParams.set('q', query)
  url.searchParams.set('page_size', '8')
  url.searchParams.set('mature', 'false')

  const result = await fetchJson(url)
  const items = Array.isArray(result?.results) ? result.results : []

  return items
    .filter((item) => item.thumbnail && item.foreign_landing_url)
    .map((item) => ({
      attribution: item.attribution || '',
      creator: item.creator || '',
      height: item.height,
      id: `openverse:${item.id}`,
      license: formatLicense(item.license, item.license_version),
      previewUrl: item.thumbnail,
      provider: 'Openverse',
      sourceUrl: item.foreign_landing_url,
      title: item.title || 'Untitled image',
      width: item.width,
    }))
}

async function searchGoogleImages(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    return []
  }

  const url = new URL('https://customsearch.googleapis.com/customsearch/v1')
  url.searchParams.set('key', GOOGLE_API_KEY)
  url.searchParams.set('cx', GOOGLE_CSE_ID)
  url.searchParams.set('q', query)
  url.searchParams.set('searchType', 'image')
  url.searchParams.set('safe', 'active')
  url.searchParams.set('num', '8')

  if (GOOGLE_GL) {
    url.searchParams.set('gl', GOOGLE_GL)
  }

  if (GOOGLE_HL) {
    url.searchParams.set('hl', GOOGLE_HL)
  }

  const result = await fetchJson(url)
  const items = Array.isArray(result?.items) ? result.items : []

  return items
    .filter((item) => item?.link || item?.image?.thumbnailLink)
    .map((item, index) => ({
      attribution: item.displayLink || 'Google Images result',
      creator: '',
      height: Number(item.image?.height) || Number(item.image?.thumbnailHeight) || undefined,
      id: `google:${item.cacheId || item.image?.contextLink || item.link || index}`,
      license: 'Google Programmable Search result',
      previewUrl: item.image?.thumbnailLink || item.link,
      provider: 'Google Images',
      sourceUrl: item.image?.contextLink || item.link,
      title: stripHtml(item.title || item.snippet || 'Untitled image'),
      width: Number(item.image?.width) || Number(item.image?.thumbnailWidth) || undefined,
    }))
}

async function fetchJson(url, init = {}) {
  const result = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  })

  if (!result.ok) {
    throw new Error(`Request failed with status ${result.status}.`)
  }

  return result.json()
}

function formatLicense(license, version) {
  if (!license) {
    return 'Unknown license'
  }

  return version ? `${license.toUpperCase()} ${version}` : license.toUpperCase()
}

function formatCommonsTitle(value) {
  return value
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}

function dedupeCandidates(candidates) {
  const seen = new Set()
  const unique = []

  for (const candidate of candidates) {
    const key = `${candidate.previewUrl}|${candidate.sourceUrl}`

    if (!candidate.previewUrl || seen.has(key)) {
      continue
    }

    seen.add(key)
    unique.push(candidate)
  }

  return unique
}

function rankCandidatesForPicker(candidates, itemName, preferredId) {
  const normalizedTarget = normalizeForMatch(itemName)
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, normalizedTarget),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.candidate)

  const preferred =
    ranked.find((candidate) => candidate.id === preferredId) ||
    candidates.find((candidate) => candidate.id === preferredId) ||
    null

  return dedupeCandidates([...(preferred ? [preferred] : []), ...ranked]).slice(0, 12)
}

function toImageResult(candidate, override = {}, itemName = '') {
  return {
    ...candidate,
    confidence: estimateCandidateConfidence(candidate, itemName),
    matchMethod: 'heuristic',
    reason: `Candidate from ${candidate.provider}.`,
    ...override,
  }
}

function shouldTryHostedFallback(selection, hostedStatus) {
  if (!hostedStatus.length) {
    return false
  }

  if (!selection) {
    return true
  }

  return (
    selection.matchMethod !== 'local-ai' ||
    selection.confidence < HOSTED_CONFIDENCE_THRESHOLD
  )
}

function getHostedProviderOrder(rankerProviders, hostedStatus) {
  return rankerProviders.filter(
    (provider) =>
      (provider === 'gemini' && hostedStatus.gemini.configured) ||
      (provider === 'groq' && hostedStatus.groq.configured),
  )
}

function buildHostedShortlist(candidates, itemName, preferredSelection) {
  const preferredCandidate =
    candidates.find((candidate) => candidate.id === preferredSelection?.candidateId) || null

  const normalizedTarget = normalizeForMatch(itemName)
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, normalizedTarget),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.candidate)

  return dedupeCandidates([...(preferredCandidate ? [preferredCandidate] : []), ...ranked]).slice(
    0,
    5,
  )
}

function chooseHeuristicCandidate({ candidates, itemName }) {
  const normalizedTarget = normalizeForMatch(itemName)
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, normalizedTarget),
    }))
    .sort((left, right) => right.score - left.score)

  const best = scored[0]?.candidate || candidates[0]

  return {
    candidate: best,
    candidateId: best.id,
    confidence: 0.34,
    matchMethod: 'heuristic',
    reason: 'Selected the top metadata match from public image sources.',
  }
}

function scoreCandidate(candidate, normalizedTarget) {
  const normalizedTitle = normalizeForMatch(candidate.title)
  const targetTokens = normalizedTarget.split(' ').filter((token) => token.length > 2)
  let score = 0

  if (normalizedTitle === normalizedTarget) {
    score += 100
  }

  if (normalizedTitle.includes(normalizedTarget)) {
    score += 45
  }

  score +=
    targetTokens.filter((token) => normalizedTitle.includes(token)).length * 10

  if (candidate.provider === 'Wikimedia Commons') {
    score += 14
  } else if (candidate.provider === 'Wikipedia') {
    score += 10
  } else if (candidate.provider === 'Google Images') {
    score += 8
  } else if (candidate.provider === 'Openverse') {
    score += 4
  }

  score -= metadataPenalty(normalizedTitle)

  if (candidate.width && candidate.height) {
    const ratio = candidate.width / candidate.height
    const distanceFromSquare = Math.abs(1 - ratio)
    score += Math.max(0, 10 - distanceFromSquare * 10)
  }

  return score
}

function normalizeForMatch(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function estimateCandidateConfidence(candidate, itemName) {
  return clamp(
    scoreCandidate(candidate, normalizeForMatch(itemName || candidate.title || '')) / 120,
    0.12,
    0.92,
  )
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function stripHtml(value) {
  return ensureString(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeSourceProviders(value) {
  if (!Array.isArray(value)) {
    return [...SOURCE_PROVIDER_KEYS]
  }

  const selected = new Set(
    value.filter((entry) => SOURCE_PROVIDER_KEYS.includes(entry)),
  )

  return SOURCE_PROVIDER_KEYS.filter((provider) => selected.has(provider))
    .length
    ? SOURCE_PROVIDER_KEYS.filter((provider) => selected.has(provider))
    : [...SOURCE_PROVIDER_KEYS]
}

function normalizeRankerProviders(value) {
  if (!Array.isArray(value)) {
    return [...RANKER_PROVIDER_KEYS]
  }

  const selected = new Set(
    value.filter((entry) => RANKER_PROVIDER_KEYS.includes(entry)),
  )

  return RANKER_PROVIDER_KEYS.filter((provider) => selected.has(provider))
}

function metadataPenalty(normalizedTitle) {
  const penalties = [
    { pattern: /\bcosplay\b/, value: 24 },
    { pattern: /\b(expo|convention|comic con|romics|sdcc|c2e2)\b/, value: 18 },
    { pattern: /\b(group|characters|crowd)\b/, value: 10 },
    { pattern: /\b(toy|figurine|plush|doll|lego)\b/, value: 8 },
  ]

  return penalties.reduce(
    (total, entry) => total + (entry.pattern.test(normalizedTitle) ? entry.value : 0),
    0,
  )
}
