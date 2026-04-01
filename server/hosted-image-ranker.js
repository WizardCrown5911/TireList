const USER_AGENT = 'ForgeTierlistBuilder/1.0'
const GEMINI_API_KEY = ensureString(process.env.GEMINI_API_KEY)
const GEMINI_MODEL = ensureString(process.env.GEMINI_MODEL) || 'gemini-2.5-flash'
const GROQ_API_KEY = ensureString(process.env.GROQ_API_KEY)
const GROQ_MODEL =
  ensureString(process.env.GROQ_MODEL) ||
  'meta-llama/llama-4-scout-17b-16e-instruct'
const REQUEST_TIMEOUT_MS = 18_000
const MAX_HOSTED_CANDIDATES = 5
const MAX_INLINE_IMAGE_BYTES = 1_800_000
let geminiCooldownUntil = 0

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    candidateId: {
      type: 'string',
      description: 'The exact candidate id from the provided list.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence from 0 to 1.',
    },
    reason: {
      type: 'string',
      description: 'One short sentence explaining the choice.',
    },
  },
  required: ['candidateId', 'confidence', 'reason'],
  additionalProperties: false,
}

export function getHostedRankerStatus() {
  return {
    gemini: {
      configured: Boolean(GEMINI_API_KEY),
      model: GEMINI_MODEL,
    },
    groq: {
      configured: Boolean(GROQ_API_KEY),
      model: GROQ_MODEL,
    },
  }
}

export async function chooseCandidateWithHostedAi({
  candidates,
  itemContext,
  itemName,
  listContext,
  preferredProviders = ['gemini', 'groq'],
}) {
  const shortlist = candidates.slice(0, MAX_HOSTED_CANDIDATES)
  const errors = []
  const providers = preferredProviders.filter(
    (provider) => provider === 'gemini' || provider === 'groq',
  )

  if (!shortlist.length) {
    throw new Error('No candidates were available for hosted reranking.')
  }

  for (const provider of providers) {
    if (provider === 'gemini' && GEMINI_API_KEY && Date.now() >= geminiCooldownUntil) {
      try {
        return await chooseWithGemini({
          candidates: shortlist,
          itemContext,
          itemName,
          listContext,
        })
      } catch (error) {
        if (isQuotaError(error)) {
          geminiCooldownUntil = Date.now() + extractRetryDelayMs(error)
        }
        errors.push(formatProviderError('Gemini', error))
      }
    }

    if (provider === 'groq' && GROQ_API_KEY) {
      try {
        return await chooseWithGroq({
          candidates: shortlist,
          itemContext,
          itemName,
          listContext,
        })
      } catch (error) {
        errors.push(formatProviderError('Groq', error))
      }
    }
  }

  throw new Error(
    errors.length
      ? errors.join(' ')
      : 'No hosted image rankers are configured.',
  )
}

async function chooseWithGemini({
  candidates,
  itemContext,
  itemName,
  listContext,
}) {
  const prepared = (
    await Promise.allSettled(
      candidates.map(async (candidate) => ({
        candidate,
        image: await downloadImageForInlinePrompt(candidate.previewUrl),
      })),
    )
  )
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)

  if (!prepared.length) {
    throw new Error('Gemini could not fetch any candidate preview images.')
  }

  const parts = [
    {
      text: buildSelectionPrompt({
        candidates: prepared.map((entry) => entry.candidate),
        itemContext,
        itemName,
        listContext,
      }),
    },
  ]

  for (const entry of prepared) {
    parts.push({
      text: buildCandidateMetadata(entry.candidate),
    })
    parts.push({
      inline_data: {
        mime_type: entry.image.mimeType,
        data: entry.image.base64,
      },
    })
  }

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
            parts,
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: SELECTION_SCHEMA,
          temperature: 0.1,
        },
      }),
    },
  )

  const responseText = extractGeminiText(payload)

  if (!responseText) {
    throw new Error('Gemini returned an empty structured response.')
  }

  return normalizeHostedSelection(
    parseJsonBlock(responseText),
    prepared.map((entry) => entry.candidate),
    'gemini',
    'Gemini reranked the candidate images.',
  )
}

async function chooseWithGroq({
  candidates,
  itemContext,
  itemName,
  listContext,
}) {
  const content = [
    {
      type: 'input_text',
      text: buildSelectionPrompt({
        candidates,
        itemContext,
        itemName,
        listContext,
      }),
    },
  ]

  for (const candidate of candidates) {
    content.push({
      type: 'input_text',
      text: buildCandidateMetadata(candidate),
    })
    content.push({
      type: 'input_image',
      detail: 'auto',
      image_url: candidate.previewUrl,
    })
  }

  const payload = await fetchJson('https://api.groq.com/openai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      instructions:
        'You select the single best image candidate for a tier-list card. Return only valid JSON that matches the provided schema.',
      input: [
        {
          role: 'user',
          content,
        },
      ],
      temperature: 0.1,
      text: {
        format: {
          type: 'json_schema',
          name: 'tierlist_image_selection',
          schema: SELECTION_SCHEMA,
        },
      },
    }),
  })

  const responseText = extractGroqText(payload)

  if (!responseText) {
    throw new Error('Groq returned an empty structured response.')
  }

  return normalizeHostedSelection(
    parseJsonBlock(responseText),
    candidates,
    'groq',
    'Groq reranked the candidate images.',
  )
}

function buildSelectionPrompt({ candidates, itemContext, itemName, listContext }) {
  const lines = [
    'Pick the single best image for this tier-list item.',
    `Target item: ${itemName}`,
  ]

  if (itemContext) {
    lines.push(`Item context: ${itemContext}`)
  }

  if (listContext) {
    lines.push(`List context: ${truncate(listContext, 140)}`)
  }

  lines.push(`Candidate count: ${candidates.length}`)
  lines.push('Rules:')
  lines.push('- Prefer images that directly depict the exact requested item.')
  lines.push('- Prefer clear representative art, photos, or product shots.')
  lines.push(
    '- Avoid logos, icons, text-heavy screenshots, collages, memes, unrelated people, or tangential scenes.',
  )
  lines.push(
    '- Avoid cosplay, toys, and fan edits unless they are clearly the closest match available.',
  )
  lines.push('- Use the exact candidateId from the metadata blocks.')

  return lines.join('\n')
}

function buildCandidateMetadata(candidate) {
  const lines = [
    `Candidate id: ${candidate.id}`,
    `Title: ${candidate.title || 'Untitled image'}`,
    `Provider: ${candidate.provider}`,
  ]

  if (candidate.creator) {
    lines.push(`Creator: ${candidate.creator}`)
  }

  if (candidate.license) {
    lines.push(`License: ${candidate.license}`)
  }

  if (candidate.attribution) {
    lines.push(`Attribution: ${truncate(candidate.attribution, 180)}`)
  }

  return lines.join('\n')
}

async function downloadImageForInlinePrompt(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Image download failed with status ${response.status}.`)
  }

  const mimeType = normalizeMimeType(response.headers.get('content-type'))

  if (!mimeType) {
    throw new Error('Remote candidate did not return a supported image content type.')
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)

  if (declaredLength > MAX_INLINE_IMAGE_BYTES) {
    throw new Error('Remote candidate image is too large for inline prompting.')
  }

  const bytes = Buffer.from(await response.arrayBuffer())

  if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
    throw new Error('Remote candidate image exceeded the inline prompt size limit.')
  }

  return {
    base64: bytes.toString('base64'),
    mimeType,
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

function normalizeHostedSelection(
  value,
  candidates,
  matchMethod,
  fallbackReason,
) {
  const candidateId = ensureString(value?.candidateId)
  const candidate = candidates.find((entry) => entry.id === candidateId)

  if (!candidate) {
    throw new Error('Hosted ranker selected an unknown candidate.')
  }

  return {
    candidateId,
    confidence: clamp(Number(value?.confidence) || 0.66, 0.12, 0.98),
    matchMethod,
    reason: ensureString(value?.reason) || fallbackReason,
  }
}

function extractApiError(payload) {
  return (
    ensureString(payload?.error?.message) ||
    ensureString(payload?.message) ||
    ensureString(payload?.promptFeedback?.blockReason)
  )
}

function isQuotaError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return (
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted')
  )
}

function extractRetryDelayMs(error) {
  const message = error instanceof Error ? error.message : ''
  const secondsMatch = /retry in\s+(\d+(?:\.\d+)?)/i.exec(message)

  if (secondsMatch) {
    return Math.max(5_000, Math.ceil(Number(secondsMatch[1]) * 1000))
  }

  return 60_000
}

function normalizeMimeType(contentType) {
  const value = ensureString(contentType).split(';')[0].trim().toLowerCase()

  return value.startsWith('image/') ? value : ''
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

function formatProviderError(provider, error) {
  const message =
    error instanceof Error ? error.message : `Unable to use ${provider} for reranking.`

  return `${provider} failed: ${message}`
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length).trim()}...` : value
}

function ensureString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
