import 'dotenv/config'

const USER_AGENT = 'ForgeTierlistBuilder/1.0'
const GEMINI_API_KEY = ensureString(process.env.GEMINI_API_KEY)
const GEMINI_MODEL = ensureString(process.env.GEMINI_MODEL) || 'gemini-2.5-flash'
const GROQ_API_KEY = ensureString(process.env.GROQ_API_KEY)
const GROQ_MODEL =
  ensureString(process.env.GROQ_MODEL) ||
  'meta-llama/llama-4-scout-17b-16e-instruct'
const REQUEST_TIMEOUT_MS = 18_000
const WIKIPEDIA_SEARCH_TIMEOUT_MS = 10_000
const suggestionCache = new Map()
let geminiCooldownUntil = 0

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The concrete item name to add to the tier list.',
          },
          context: {
            type: 'string',
            description:
              'Optional short disambiguation context. Use an empty string if not needed.',
          },
        },
        required: ['name', 'context'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

export async function suggestRelatedItems({
  limit = 18,
  listContext,
  title,
}) {
  const count = clamp(Math.round(Number(limit) || 18), 8, 24)
  const cacheKey = `${title.toLowerCase()}|${listContext.toLowerCase()}|${count}`
  const cached = suggestionCache.get(cacheKey)
  const errors = []

  if (cached) {
    return cached
  }

  if (GEMINI_API_KEY && Date.now() >= geminiCooldownUntil) {
    try {
      const items = await suggestWithGemini({
        count,
        listContext,
        title,
      })
      suggestionCache.set(cacheKey, items)
      return items
    } catch (error) {
      if (isQuotaError(error)) {
        geminiCooldownUntil = Date.now() + extractRetryDelayMs(error)
      }
      errors.push(formatProviderError('Gemini', error))
    }
  }

  if (GROQ_API_KEY) {
    try {
      const items = await suggestWithGroq({
        count,
        listContext,
        title,
      })
      suggestionCache.set(cacheKey, items)
      return items
    } catch (error) {
      errors.push(formatProviderError('Groq', error))
    }
  }

  try {
    const items = await suggestWithWikipediaSearch({
      count,
      listContext,
      title,
    })
    suggestionCache.set(cacheKey, items)
    return items
  } catch (error) {
    errors.push(formatProviderError('Wikipedia fallback', error))
  }

  throw new Error(errors.join(' ') || 'Unable to generate related items right now.')
}

async function suggestWithGemini({ count, listContext, title }) {
  const payload = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL,
    )}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: buildSuggestionPrompt({
                  count,
                  listContext,
                  title,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: SUGGESTION_SCHEMA,
          temperature: 0.3,
        },
      }),
    },
  )

  const responseText = extractGeminiText(payload)

  if (!responseText) {
    throw new Error('Gemini returned an empty item suggestion response.')
  }

  return normalizeSuggestionItems(parseJsonBlock(responseText), count)
}

async function suggestWithGroq({ count, listContext, title }) {
  const payload = await fetchJson('https://api.groq.com/openai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      instructions:
        'You generate concrete tier-list items and return only valid JSON that matches the provided schema.',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildSuggestionPrompt({
                count,
                listContext,
                title,
              }),
            },
          ],
        },
      ],
      temperature: 0.3,
      text: {
        format: {
          type: 'json_schema',
          name: 'tierlist_related_items',
          schema: SUGGESTION_SCHEMA,
        },
      },
    }),
  })

  const responseText = extractGroqText(payload)

  if (!responseText) {
    throw new Error('Groq returned an empty item suggestion response.')
  }

  return normalizeSuggestionItems(parseJsonBlock(responseText), count)
}

function buildSuggestionPrompt({ count, listContext, title }) {
  const lines = [
    'Generate related concrete items for a tier list.',
    `Tier list title: ${title}`,
    `Return up to ${count} items.`,
    'Rules:',
    '- Return concrete items the user could actually drag into tiers.',
    '- Prefer canonical, recognizable names over vague categories.',
    '- Use short context only when it helps disambiguate the item.',
    '- Do not repeat the list title as an item unless it is itself a rankable item.',
    '- Keep names concise.',
    '- Avoid duplicates, broad traits, or filler words.',
  ]

  if (listContext) {
    lines.push(`Extra context: ${truncate(listContext, 180)}`)
  }

  lines.push(
    'If the title implies a franchise, series, genre, category, or topic, return representative items from that topic.',
  )

  return lines.join('\n')
}

function normalizeSuggestionItems(value, count) {
  const rawItems = Array.isArray(value?.items) ? value.items : []
  const seen = new Set()
  const items = []

  for (const entry of rawItems) {
    const name = ensureString(entry?.name)
    const context = ensureString(entry?.context)

    if (!name) {
      continue
    }

    const key = `${name.toLowerCase()}|${context.toLowerCase()}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    items.push({ context, name })

    if (items.length >= count) {
      break
    }
  }

  if (!items.length) {
    throw new Error('The suggestion model did not return any usable items.')
  }

  return items
}

async function suggestWithWikipediaSearch({ count, listContext, title }) {
  const queries = buildWikipediaQueries(title, listContext)
  const batches = await Promise.all(queries.map((query) => searchWikipediaTitles(query, count)))
  const titles = dedupeWikipediaTitles(batches.flat())
  const items = titles
    .map(parseWikipediaTitle)
    .filter((item) => item && item.name)
    .slice(0, count)

  if (!items.length) {
    throw new Error('Wikipedia search did not return any usable related items.')
  }

  return items
}

function buildWikipediaQueries(title, listContext) {
  const cleanedTitle = normalizeSearchText(title)
  const context = normalizeSearchText(listContext)
  const variants = [
    cleanedTitle,
    context ? `${cleanedTitle} ${context}` : '',
    stripTierlistWords(cleanedTitle),
    context ? stripTierlistWords(`${cleanedTitle} ${context}`) : '',
  ]

  return Array.from(new Set(variants.filter(Boolean)))
}

async function searchWikipediaTitles(query, count) {
  const url = new URL('https://en.wikipedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', query)
  url.searchParams.set('srlimit', String(Math.min(Math.max(count, 8), 20)))
  url.searchParams.set('srnamespace', '0')
  url.searchParams.set('origin', '*')

  const payload = await fetchJson(url, {
    signal: AbortSignal.timeout(WIKIPEDIA_SEARCH_TIMEOUT_MS),
  })

  return Array.isArray(payload?.query?.search)
    ? payload.query.search.map((entry) => ensureString(entry?.title)).filter(Boolean)
    : []
}

function dedupeWikipediaTitles(titles) {
  const seen = new Set()
  const filtered = []

  for (const title of titles) {
    const normalized = title.toLowerCase()

    if (!title || seen.has(normalized) || shouldSkipWikipediaTitle(title)) {
      continue
    }

    seen.add(normalized)
    filtered.push(title)
  }

  return filtered
}

function shouldSkipWikipediaTitle(title) {
  const normalized = title.toLowerCase()
  return (
    normalized.startsWith('list of ') ||
    normalized.startsWith('category:') ||
    normalized.startsWith('portal:') ||
    normalized.startsWith('wikipedia:') ||
    normalized.includes('disambiguation')
  )
}

function parseWikipediaTitle(title) {
  const match = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(title)

  if (!match) {
    return { context: '', name: title }
  }

  return {
    context: match[2].trim(),
    name: match[1].trim(),
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const text = await response.text()
  const payload = text ? safeJsonParse(text) : null

  if (!response.ok) {
    throw new Error(extractApiError(payload) || `Request failed with status ${response.status}.`)
  }

  if (payload == null) {
    throw new Error('Provider returned an empty response.')
  }

  return payload
}

function isQuotaError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return message.includes('quota') || message.includes('rate limit') || message.includes('resource_exhausted')
}

function extractRetryDelayMs(error) {
  const message = error instanceof Error ? error.message : ''
  const secondsMatch = /retry in\s+(\d+(?:\.\d+)?)/i.exec(message)

  if (secondsMatch) {
    return Math.max(5_000, Math.ceil(Number(secondsMatch[1]) * 1000))
  }

  return 60_000
}

function extractGeminiText(payload) {
  return (
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || '')
      .join('')
      .trim() || ''
  )
}

function extractGroqText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }

  const message = Array.isArray(payload?.output)
    ? payload.output.find((entry) => entry?.type === 'message')
    : null

  return (
    message?.content
      ?.filter((entry) => entry?.type === 'output_text')
      .map((entry) => entry.text || '')
      .join('')
      .trim() || ''
  )
}

function parseJsonBlock(value) {
  const parsed = safeJsonParse(value)

  if (parsed && typeof parsed === 'object') {
    return parsed
  }

  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Provider response was not valid JSON.')
  }

  const nested = safeJsonParse(value.slice(start, end + 1))

  if (!nested || typeof nested !== 'object') {
    throw new Error('Provider response was not valid JSON.')
  }

  return nested
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function extractApiError(payload) {
  return (
    ensureString(payload?.error?.message) ||
    ensureString(payload?.message) ||
    ensureString(payload?.promptFeedback?.blockReason)
  )
}

function formatProviderError(provider, error) {
  const message =
    error instanceof Error ? error.message : `Unable to use ${provider} for item suggestions.`

  return `${provider} failed: ${message}`
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length).trim()}...` : value
}

function normalizeSearchText(value) {
  return ensureString(value).replace(/\s+/g, ' ').trim()
}

function stripTierlistWords(value) {
  return value
    .replace(/\b(best|worst|top|favorite|favourite|ranking|ranked|tier|tierlist|list)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function ensureString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
