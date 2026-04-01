import path from 'node:path'
import { env, pipeline } from '@huggingface/transformers'

const CACHE_DIR = path.resolve(process.cwd(), '.cache', 'transformers')
const NEGATIVE_LABELS = [
  'text-heavy screenshot',
  'abstract pattern',
  'logo or icon',
  'collage of many things',
  'cosplay costume',
  'group photo',
]

env.cacheDir = CACHE_DIR

export class LocalImageRanker {
  static task = 'zero-shot-image-classification'
  static model = 'Xenova/clip-vit-base-patch32'
  static instancePromise = null
  static state = 'idle'
  static errorMessage = ''

  static isEnabled() {
    const value = String(process.env.ENABLE_LOCAL_CLIP || 'true').trim().toLowerCase()
    return !['0', 'false', 'off', 'no'].includes(value)
  }

  static getStatus() {
    if (!this.isEnabled()) {
      return {
        available: false,
        error: null,
        model: this.model,
        ready: false,
        state: 'disabled',
      }
    }

    return {
      available: true,
      error: this.errorMessage || null,
      model: this.model,
      ready: this.state === 'ready',
      state: this.state,
    }
  }

  static async getInstance() {
    if (!this.isEnabled()) {
      throw new Error('Local CLIP is disabled by configuration.')
    }

    if (!this.instancePromise) {
      this.state = 'loading'
      this.errorMessage = ''

      this.instancePromise = pipeline(this.task, this.model, {
        dtype: 'q8',
      })
        .then((instance) => {
          this.state = 'ready'
          return instance
        })
        .catch((error) => {
          this.state = 'error'
          this.errorMessage =
            error instanceof Error ? error.message : 'Unable to load local model.'
          this.instancePromise = null
          throw error
        })
    }

    return this.instancePromise
  }

  static warm() {
    if (!this.isEnabled()) {
      return
    }

    void this.getInstance().catch(() => {})
  }
}

export async function chooseCandidateWithLocalAi({
  candidates,
  itemContext,
  itemName,
  listContext,
}) {
  const classifier = await LocalImageRanker.getInstance()
  const promptLabels = buildPromptLabels(itemName, itemContext, listContext)
  const targetLabels = promptLabels.filter(
    (label) => !NEGATIVE_LABELS.includes(label),
  )
  const scoredCandidates = []

  for (const candidate of candidates) {
    try {
      const output = await classifier(candidate.previewUrl, promptLabels)
      const scoreMap = new Map(
        output.map((entry) => [entry.label, Number(entry.score) || 0]),
      )
      const targetScore = Math.max(
        ...targetLabels.map((label) => scoreMap.get(label) || 0),
      )
      const negativeScore = Math.max(
        ...NEGATIVE_LABELS.map((label) => scoreMap.get(label) || 0),
      )
      const heuristicScore = normalizeHeuristicScore(
        scoreCandidate(candidate, normalizeForMatch(itemName)),
      )
      const totalScore =
        targetScore * 0.74 +
        heuristicScore * 0.22 -
        negativeScore * 0.28 +
        providerBonus(candidate.provider)

      scoredCandidates.push({
        candidate,
        heuristicScore,
        negativeScore,
        targetScore,
        topLabel: output[0]?.label || targetLabels[0],
        totalScore,
      })
    } catch {
      continue
    }
  }

  if (!scoredCandidates.length) {
    throw new Error('Local model could not score any candidate images.')
  }

  scoredCandidates.sort((left, right) => right.totalScore - left.totalScore)

  const [best, runnerUp] = scoredCandidates
  const margin = best.totalScore - (runnerUp?.totalScore ?? 0)
  const confidence = clamp(
    best.targetScore * 0.7 + best.heuristicScore * 0.2 + margin * 0.6,
    0.08,
    0.98,
  )

  return {
    candidateId: best.candidate.id,
    confidence,
    matchMethod: 'local-ai',
    reason: `Local CLIP ranked this image highest for "${best.topLabel}".`,
  }
}

function buildPromptLabels(itemName, itemContext, listContext) {
  const labels = [
    toLabel(itemName),
    itemContext ? toLabel(`${itemName} ${itemContext}`) : '',
    listContext ? toLabel(`${itemName} ${truncate(listContext, 80)}`) : '',
    ...NEGATIVE_LABELS,
  ].filter(Boolean)

  return Array.from(new Set(labels))
}

function toLabel(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length).trim()}...` : value
}

function providerBonus(provider) {
  if (provider === 'Wikimedia Commons') {
    return 0.05
  }

  if (provider === 'Wikipedia') {
    return 0.04
  }

  return provider === 'Openverse' ? 0.01 : 0
}

function normalizeHeuristicScore(score) {
  return clamp(score / 120, 0, 1)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
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
