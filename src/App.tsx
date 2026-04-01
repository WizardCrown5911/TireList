import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { toPng } from 'html-to-image'
import './App.css'

type NoticeTone = 'info' | 'success' | 'warning' | 'error'
type ImageStatus = 'idle' | 'loading' | 'ready' | 'error'
type MatchMethod = 'heuristic' | 'local-ai' | 'gemini' | 'groq' | 'manual'
type SourceProvider = 'commons' | 'wikipedia' | 'openverse' | 'google'
type RankerProvider = 'local' | 'gemini' | 'groq'
type ImageResult = { attribution: string; confidence: number; creator: string; id: string; license: string; matchMethod: MatchMethod; previewUrl: string; provider: string; reason: string; sourceUrl: string; title: string }
type TierItem = { context: string; id: string; image?: ImageResult; imageError?: string; imageStatus: ImageStatus; name: string; tierId: string | null }
type TierConfig = { color: string; id: string; label: string }
type BoardState = Record<string, string[]>
type ProviderSelection = { rankers: RankerProvider[]; sources: SourceProvider[] }
type TierThemeId = 'custom' | 'forge' | 'aurora' | 'inferno' | 'toxic'
type SavedState = { board: BoardState; compactMode: boolean; itemsById: Record<string, TierItem>; listContext: string; providerSelection: ProviderSelection; sidebarCollapsed: boolean; tierThemeId: TierThemeId; title: string; tiers: TierConfig[] }
type HealthResponse = { integrations?: { discord: { configured: boolean } }; mode: string; ok: boolean; providers?: { gemini: { configured: boolean; model: string }; google: { configured: boolean }; groq: { configured: boolean; model: string }; local: { configured: boolean; model: string } }; ranker?: { available?: boolean; error: string | null; model: string; ready: boolean; state: string } }
type LookupResponse = { candidates?: ImageResult[]; query: string; result: ImageResult }
type DiscordShareResponse = { channelId: string; messageId: string; ok: boolean }
type SuggestItemsResponse = { items: Array<{ context: string; name: string }>; title: string }
type Notice = { message: string; tone: NoticeTone }
type PickerState = { candidates: ImageResult[]; error: string; itemId: string | null; loading: boolean; query: string; recommendedId: string | null }
type SuggestedItem = { context: string; id: string; name: string }
type CountLabel = { plural: string; singular: string }
type LaneProps = {
  color: string
  emptyMessage: string
  header: ReactNode
  id: string
  isPool?: boolean
  items: TierItem[]
  menuOpenId: string | null
  onDropFiles?: (files: FileList | null) => void
  onDropImage: (itemId: string, files: FileList | null) => void
  onLookup: (itemId: string) => void
  onOpenPicker: (itemId: string) => void
  onRemove: (itemId: string) => void
  onToggleMenu: (itemId: string) => void
  onUpload: (itemId: string) => void
}
type CardShellProps = {
  item: TierItem
  menuOpen?: boolean
  onDropImage?: (itemId: string, files: FileList | null) => void
  onLookup?: (itemId: string) => void
  onOpenPicker?: (itemId: string) => void
  onRemove?: (itemId: string) => void
  onToggleMenu?: (itemId: string) => void
  onUpload?: (itemId: string) => void
  overlay?: boolean
}

const STORAGE_KEY = 'forge-tierlist:state:v1'
const POOL_ID = 'pool'
const DEFAULT_TIERS: TierConfig[] = [
  { id: 'tier-s', label: 'S', color: '#ff355e' },
  { id: 'tier-a', label: 'A', color: '#f54d6e' },
  { id: 'tier-b', label: 'B', color: '#2f6bff' },
  { id: 'tier-c', label: 'C', color: '#1e49d8' },
  { id: 'tier-d', label: 'D', color: '#0f203d' },
]
const SOURCE_PROVIDER_ORDER: SourceProvider[] = ['commons', 'wikipedia', 'openverse', 'google']
const RANKER_PROVIDER_ORDER: RankerProvider[] = ['local', 'gemini', 'groq']
const TIER_THEME_ORDER: Array<Exclude<TierThemeId, 'custom'>> = ['forge', 'aurora', 'inferno', 'toxic']
const DEFAULT_TIER_THEME_ID: Exclude<TierThemeId, 'custom'> = 'forge'
const TIER_THEME_PRESETS: Record<Exclude<TierThemeId, 'custom'>, { colors: string[]; description: string; label: string }> = {
  aurora: {
    colors: ['#79f2ff', '#3d9dff', '#5b67ff', '#13203d'],
    description: 'Cold blue neon fading into deep space.',
    label: 'Aurora',
  },
  forge: {
    colors: ['#ff4d6d', '#ff7b54', '#446dff', '#122447'],
    description: 'The default red-to-blue forged gradient.',
    label: 'Forge',
  },
  inferno: {
    colors: ['#ff5a36', '#ff9f43', '#ff477e', '#281441'],
    description: 'Hot ember tones with a dark burn-out base.',
    label: 'Inferno',
  },
  toxic: {
    colors: ['#d5ff57', '#6bff8f', '#18b7b3', '#11273a'],
    description: 'Acid green and teal over a dark chassis.',
    label: 'Toxic',
  },
}
const LEGACY_PROVIDER_SELECTION: ProviderSelection = {
  rankers: [...RANKER_PROVIDER_ORDER],
  sources: [...SOURCE_PROVIDER_ORDER],
}
const DEFAULT_PROVIDER_SELECTION: ProviderSelection = {
  rankers: ['gemini'],
  sources: ['openverse'],
}

function App() {
  const [initialState] = useState<SavedState>(() => loadSavedState())
  const [title, setTitle] = useState(initialState.title)
  const [listContext, setListContext] = useState(initialState.listContext)
  const [compactMode, setCompactMode] = useState(initialState.compactMode)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialState.sidebarCollapsed)
  const [providerSelection, setProviderSelection] = useState<ProviderSelection>(initialState.providerSelection)
  const [tierThemeId, setTierThemeId] = useState<TierThemeId>(initialState.tierThemeId)
  const [tiers, setTiers] = useState<TierConfig[]>(initialState.tiers)
  const [itemsById, setItemsById] = useState<Record<string, TierItem>>(initialState.itemsById)
  const [board, setBoard] = useState<BoardState>(initialState.board)
  const [titleSuggestions, setTitleSuggestions] = useState<SuggestedItem[]>([])
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>([])
  const [findingSuggestions, setFindingSuggestions] = useState(false)
  const [suggestionError, setSuggestionError] = useState('')
  const [manualItemsInput, setManualItemsInput] = useState('')
  const [notice, setNotice] = useState<Notice>({
    message: 'Set a list title, generate related items, or add your own items to the pool and let the matcher pick images.',
    tone: 'info',
  })
  const [backendReady, setBackendReady] = useState<boolean | null>(null)
  const [discordConfigured, setDiscordConfigured] = useState(false)
  const [lookupMode, setLookupMode] = useState('Local CLIP')
  const [providerAvailability, setProviderAvailability] = useState({ gemini: false, google: false, groq: false, local: true })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draggingTierId, setDraggingTierId] = useState<string | null>(null)
  const [tierDropTargetId, setTierDropTargetId] = useState<string | null>(null)
  const [autoPickingItems, setAutoPickingItems] = useState(false)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [sharingToDiscord, setSharingToDiscord] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [pickerState, setPickerState] = useState<PickerState>({
    candidates: [],
    error: '',
    itemId: null,
    loading: false,
    query: '',
    recommendedId: null,
  })
  const boardExportRef = useRef<HTMLDivElement | null>(null)
  const importFileRef = useRef<HTMLInputElement | null>(null)
  const imageUploadRef = useRef<HTMLInputElement | null>(null)
  const boardStateRef = useRef(initialState.board)
  const itemsRef = useRef(itemsById)
  const listContextRef = useRef(listContext)
  const providerSelectionRef = useRef(initialState.providerSelection)
  const tierThemeRef = useRef(initialState.tierThemeId)
  const pendingUploadItemIdRef = useRef<string | null>(null)
  const storageWarningShownRef = useRef(false)
  const lastOverId = useRef<UniqueIdentifier | null>(null)

  useEffect(() => { itemsRef.current = itemsById }, [itemsById])
  useEffect(() => { listContextRef.current = listContext }, [listContext])
  useEffect(() => { providerSelectionRef.current = providerSelection }, [providerSelection])
  useEffect(() => { tierThemeRef.current = tierThemeId }, [tierThemeId])
  useEffect(() => { boardStateRef.current = board }, [board])
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ board: normalizeBoard(board, tiers, itemsById), compactMode, itemsById, listContext, providerSelection, sidebarCollapsed, tierThemeId, title, tiers } satisfies SavedState),
      )
      storageWarningShownRef.current = false
    } catch (error) {
      console.error('Unable to persist tier list state.', error)
      if (!storageWarningShownRef.current) {
        storageWarningShownRef.current = true
        setNotice({
          message: 'Browser storage is full. Smaller uploads or exporting the list JSON will work better for custom images.',
          tone: 'warning',
        })
      }
    }
  }, [board, compactMode, itemsById, listContext, providerSelection, sidebarCollapsed, tierThemeId, tiers, title])

  useEffect(() => {
    let cancelled = false
    async function checkHealth() {
      try {
        const response = await fetch('/api/health')
        if (!response.ok) throw new Error('Tierlist API is unavailable.')
        const payload = (await response.json()) as HealthResponse
        if (!cancelled) {
          setBackendReady(payload.ok)
          setDiscordConfigured(Boolean(payload.integrations?.discord?.configured))
          setLookupMode(payload.mode)
          setProviderAvailability({
            gemini: Boolean(payload.providers?.gemini?.configured),
            google: Boolean(payload.providers?.google?.configured),
            groq: Boolean(payload.providers?.groq?.configured),
            local: payload.providers?.local?.configured !== false,
          })
          setProviderSelection((current) => {
            const baseSelection = isLegacyDefaultProviderSelection(current) ? DEFAULT_PROVIDER_SELECTION : current
            const nextSources = baseSelection.sources.filter((provider) =>
              provider === 'google' ? Boolean(payload.providers?.google?.configured) : true,
            )
            const nextRankers = baseSelection.rankers.filter((provider) =>
              provider === 'local'
                ? payload.providers?.local?.configured !== false
                : provider === 'gemini'
                  ? Boolean(payload.providers?.gemini?.configured)
                  : Boolean(payload.providers?.groq?.configured),
            )

            if (nextRankers.length === current.rankers.length && nextSources.length === current.sources.length) {
              return current
            }

            return {
              rankers: nextRankers,
              sources: nextSources.length ? nextSources : SOURCE_PROVIDER_ORDER.filter((provider) => provider !== 'google'),
            }
          })
        }
      } catch {
        if (!cancelled) {
          setBackendReady(false)
          setDiscordConfigured(false)
          setLookupMode('Offline')
        }
      }
    }
    void checkHealth()
    return () => { cancelled = true }
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const collisionDetectionStrategy: CollisionDetection = (args) => {
    const pointerIntersections = pointerWithin(args)
    const intersections = pointerIntersections.length > 0 ? pointerIntersections : rectIntersection(args)
    let overId = getFirstCollision(intersections, 'id')
    if (overId != null) {
      const overContainerId = String(overId)
      if (overContainerId in boardStateRef.current) {
        const containerItems = getContainerItems(boardStateRef.current, overContainerId)
        if (containerItems.length > 0) {
          const childContainers = args.droppableContainers.filter((container) => containerItems.includes(String(container.id)))
          if (childContainers.length > 0) {
            overId = closestCenter({ ...args, droppableContainers: childContainers })[0]?.id ?? overId
          }
        }
      }
      lastOverId.current = overId
      return [{ id: overId }]
    }
    if (lastOverId.current != null) return [{ id: lastOverId.current }]
    return []
  }

  const poolItems = mapIdsToItems(board[POOL_ID] || [], itemsById)
  const activeItem = activeId ? itemsById[activeId] : null
  const pickerItem = pickerState.itemId ? itemsById[pickerState.itemId] : null
  const existingItemKeys = new Set(Object.values(itemsById).map((item) => itemKeyFor(item.name, item.context)))
  const addableSuggestionCount = titleSuggestions.filter((item) => !existingItemKeys.has(itemKeyFor(item.name, item.context))).length
  const selectedAddableSuggestionCount = titleSuggestions.filter((item) => selectedSuggestionIds.includes(item.id) && !existingItemKeys.has(itemKeyFor(item.name, item.context))).length

  function updateBoard(updater: (current: BoardState) => BoardState) {
    setBoard((current) => {
      const next = updater(current)
      boardStateRef.current = next
      return next
    })
  }

  function patchItem(itemId: string, patch: Partial<TierItem>) {
    setItemsById((current) => {
      const item = current[itemId]
      if (!item) return current
      return { ...current, [itemId]: { ...item, ...patch } }
    })
  }

  function createSnapshot() {
    return {
      board: normalizeBoard(boardStateRef.current, tiers, itemsRef.current),
      compactMode,
      itemsById: itemsRef.current,
      listContext: listContextRef.current,
      providerSelection: providerSelectionRef.current,
      sidebarCollapsed,
      tierThemeId: tierThemeRef.current,
      title,
      tiers,
    } satisfies SavedState
  }

  function openImportDialog() {
    importFileRef.current?.click()
  }

  function openImageUploadDialog(itemId: string) {
    pendingUploadItemIdRef.current = itemId
    setMenuOpenId(null)
    imageUploadRef.current?.click()
  }

  function downloadListFile() {
    const snapshot = createSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json',
    })
    const link = document.createElement('a')
    link.download = `${slugify(title || 'tier-list')}.tierlist.json`
    link.href = URL.createObjectURL(blob)
    link.click()
    URL.revokeObjectURL(link.href)
    setNotice({
      message: 'Saved the current list as a JSON file.',
      tone: 'success',
    })
  }

  async function importListFile(file: File | null) {
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Partial<SavedState>
      const nextState = hydrateSavedState(parsed)
      const nextProviderSelection = filterProviderSelection(nextState.providerSelection, providerAvailability)

      setTitle(nextState.title)
      setListContext(nextState.listContext)
      setCompactMode(nextState.compactMode)
      setSidebarCollapsed(nextState.sidebarCollapsed)
      setProviderSelection(nextProviderSelection)
      setTierThemeId(nextState.tierThemeId)
      setTiers(nextState.tiers)
      setItemsById(nextState.itemsById)
      boardStateRef.current = nextState.board
      setBoard(nextState.board)
      setMenuOpenId(null)
      setProviderMenuOpen(false)
      setThemeMenuOpen(false)
      setTitleSuggestions([])
      setSelectedSuggestionIds([])
      setSuggestionError('')
      setManualItemsInput('')
      closeImagePicker()
      setNotice({
        message: `Imported "${nextState.title}" with ${Object.keys(nextState.itemsById).length} items.`,
        tone: 'success',
      })
    } catch {
      setNotice({
        message: 'Import failed. Use a tier list JSON file exported from this app.',
        tone: 'error',
      })
    }
  }

  async function findRelatedItemsFromTitle() {
    const trimmedTitle = title.trim()

    if (!trimmedTitle) {
      setNotice({
        message: 'Give the tier list a title first so the item finder knows what to generate.',
        tone: 'warning',
      })
      return
    }

    setFindingSuggestions(true)
    setSuggestionError('')

    try {
      const response = await fetch('/api/items/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listContext,
          limit: 18,
          title: trimmedTitle,
        }),
      })
      const payload = (await response.json()) as SuggestItemsResponse | { error?: string }
      const errorMessage = 'error' in payload ? payload.error : undefined

      if (!response.ok || !('items' in payload)) {
        throw new Error(errorMessage || `Unable to generate related items for ${trimmedTitle}.`)
      }

      const suggestions = dedupeSuggestionItems(payload.items).map((item) => ({
        ...item,
        id: createId('suggestion'),
      }))

      setTitleSuggestions(suggestions)
      setSelectedSuggestionIds(suggestions.map((item) => item.id))
      setNotice({
        message: `Found ${suggestions.length} related item${suggestions.length === 1 ? '' : 's'} for "${trimmedTitle}". Pick what to add to the pool.`,
        tone: 'success',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to generate related items for ${trimmedTitle}.`
      setTitleSuggestions([])
      setSelectedSuggestionIds([])
      setSuggestionError(message)
      setNotice({ message, tone: 'error' })
    } finally {
      setFindingSuggestions(false)
    }
  }

  function toggleSuggestionSelection(suggestionId: string) {
    setSelectedSuggestionIds((current) =>
      current.includes(suggestionId)
        ? current.filter((id) => id !== suggestionId)
        : [...current, suggestionId],
    )
  }

  function selectAllSuggestions() {
    setSelectedSuggestionIds(
      titleSuggestions
        .filter((item) => !existingItemKeys.has(itemKeyFor(item.name, item.context)))
        .map((item) => item.id),
    )
  }

  function clearSuggestionSelection() {
    setSelectedSuggestionIds([])
  }

  function addEntriesToPool(entries: Array<{ context: string; name: string }>, sourceLabel: CountLabel) {
    const seen = new Set(Object.values(itemsRef.current).map((item) => itemKeyFor(item.name, item.context)))
    const uniqueEntries = entries.filter((entry) => {
      const name = entry.name.trim()
      const context = entry.context.trim()
      const key = itemKeyFor(name, context)

      if (!name || seen.has(key)) {
        return false
      }

      seen.add(key)
      return true
    })

    if (!uniqueEntries.length) {
      setNotice({
        message: 'Those items are already on the board.',
        tone: 'warning',
      })
      return
    }

    const nextEntries = uniqueEntries.map((entry) => {
      const id = createId('item')
      return [id, { context: entry.context.trim(), id, imageStatus: 'idle' as const, name: entry.name.trim(), tierId: null }] as const
    })
    const nextItems = Object.fromEntries(nextEntries)
    const nextIds = nextEntries.map(([id]) => id)

    setItemsById((current) => {
      const merged = { ...current, ...nextItems }
      itemsRef.current = merged
      return merged
    })
    updateBoard((current) => ({ ...current, [POOL_ID]: [...getContainerItems(current, POOL_ID), ...nextIds] }))

    if (backendReady === false) {
      setNotice({
        message: `Added ${nextIds.length} ${formatCountLabel(nextIds.length, sourceLabel)} to the pool. The backend is offline, so images were not auto-picked.`,
        tone: 'warning',
      })
      return
    }

    setNotice({
      message: `Added ${nextIds.length} ${formatCountLabel(nextIds.length, sourceLabel)} to the pool. Auto-picking images now...`,
      tone: 'info',
    })
    void autoLookupNewItems(nextIds)
  }

  function addSuggestedItems(mode: 'all' | 'selected') {
    const selectedIds = new Set(mode === 'all' ? titleSuggestions.map((item) => item.id) : selectedSuggestionIds)
    const entries = titleSuggestions
      .filter((item) => selectedIds.has(item.id))
      .filter((item) => !existingItemKeys.has(itemKeyFor(item.name, item.context)))
      .map((item) => ({ context: item.context, name: item.name }))

    if (!entries.length) {
      setNotice({
        message: mode === 'all' ? 'There are no new suggested items left to add.' : 'Pick at least one suggested item first.',
        tone: 'warning',
      })
      return
    }

    addEntriesToPool(entries, mode === 'all' ? { plural: 'suggested items', singular: 'suggested item' } : { plural: 'selected items', singular: 'selected item' })
    setSelectedSuggestionIds((current) => current.filter((id) => !selectedIds.has(id)))
  }

  function addManualItems() {
    const entries = parseManualEntries(manualItemsInput)

    if (!entries.length) {
      setNotice({
        message: 'Type at least one item first. One per line works best, and simple lists can be comma-separated.',
        tone: 'warning',
      })
      return
    }

    addEntriesToPool(entries, { plural: 'manual items', singular: 'manual item' })
    setManualItemsInput('')
  }

  async function fetchLookupPayload(itemId: string) {
    const item = itemsRef.current[itemId]
    if (!item) return null

    const response = await fetch('/api/images/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemContext: item.context,
        itemName: item.name,
        listContext: listContextRef.current,
        rankerProviders: providerSelectionRef.current.rankers,
        sourceProviders: providerSelectionRef.current.sources,
      }),
    })
    const payload = (await response.json()) as LookupResponse | { error?: string }
    const errorMessage = 'error' in payload ? payload.error : undefined

    if (!response.ok || !('result' in payload)) {
      throw new Error(errorMessage || `Unable to find an image for ${item.name}.`)
    }

    return payload
  }

  function closeImagePicker() {
    setPickerState({
      candidates: [],
      error: '',
      itemId: null,
      loading: false,
      query: '',
      recommendedId: null,
    })
  }

  async function lookupImageForItem(itemId: string, silent = false) {
    const item = itemsRef.current[itemId]
    if (!item) return false
    setMenuOpenId(null)
    patchItem(itemId, { imageError: '', imageStatus: 'loading' })
    try {
      const payload = await fetchLookupPayload(itemId)
      if (!payload) return false
      patchItem(itemId, { image: payload.result, imageError: '', imageStatus: 'ready' })
      if (!silent) {
        setNotice({
          message: `${item.name} matched with ${payload.result.provider} using ${matchMethodLabel(payload.result.matchMethod)}.`,
          tone: payload.result.matchMethod === 'heuristic' ? 'warning' : 'success',
        })
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to find an image for ${item.name}.`
      patchItem(itemId, { imageError: message, imageStatus: 'error' })
      if (!silent) setNotice({ message, tone: 'error' })
      return false
    }
  }

  async function openImagePicker(itemId: string) {
    const item = itemsRef.current[itemId]
    if (!item) return

    setMenuOpenId(null)
    setPickerState({
      candidates: [],
      error: '',
      itemId,
      loading: true,
      query: '',
      recommendedId: null,
    })

    try {
      const payload = await fetchLookupPayload(itemId)

      if (!payload) {
        closeImagePicker()
        return
      }

      setPickerState({
        candidates: payload.candidates?.length ? payload.candidates : [payload.result],
        error: '',
        itemId,
        loading: false,
        query: payload.query,
        recommendedId: payload.result.id,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unable to find images for ${item.name}.`

      setPickerState({
        candidates: [],
        error: message,
        itemId,
        loading: false,
        query: '',
        recommendedId: null,
      })
    }
  }

  function chooseImageCandidate(itemId: string, candidate: ImageResult) {
    const item = itemsRef.current[itemId]

    if (!item) {
      closeImagePicker()
      return
    }

    patchItem(itemId, {
      image: {
        ...candidate,
        matchMethod: 'manual',
        reason: 'Picked manually from image search results.',
      },
      imageError: '',
      imageStatus: 'ready',
    })

    closeImagePicker()
    setNotice({
      message: `${item.name} updated with a manual image pick from ${candidate.provider}.`,
      tone: 'success',
    })
  }

  async function handleImageUploadSelection(file: File | null) {
    const itemId = pendingUploadItemIdRef.current
    pendingUploadItemIdRef.current = null

    if (!itemId || !file) {
      return
    }

    await applyImageFileToItem(itemId, file)
  }

  async function applyImageFileToItem(itemId: string, file: File) {
    setMenuOpenId(null)

    const item = itemsRef.current[itemId]
    if (!item) {
      return
    }

    patchItem(itemId, { imageError: '', imageStatus: 'loading' })

    try {
      const previewUrl = await resizeImageFile(file)
      patchItem(itemId, {
        image: createCustomImageResult(item, previewUrl),
        imageError: '',
        imageStatus: 'ready',
      })
      setNotice({
        message: `${item.name} updated with your uploaded image.`,
        tone: 'success',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to use that image for ${item.name}.`
      patchItem(itemId, { imageError: message, imageStatus: 'error' })
      setNotice({ message, tone: 'error' })
    }
  }

  function handleImageDrop(itemId: string, files: FileList | null) {
    const file = Array.from(files || []).find((entry) => entry.type.startsWith('image/')) || null

    if (!file) {
      setNotice({
        message: 'Drop an image file onto a card to replace its picture.',
        tone: 'warning',
      })
      return
    }

    void applyImageFileToItem(itemId, file)
  }

  async function addDroppedImagesToPool(files: FileList | null) {
    const imageFiles = getImageFiles(files)

    if (!imageFiles.length) {
      setNotice({
        message: 'Drop one or more image files into the pool to create new items.',
        tone: 'warning',
      })
      return
    }

    setMenuOpenId(null)

    const pendingEntries = imageFiles.map((file, index) => {
      const id = createId('item')
      const item: TierItem = {
        context: '',
        id,
        imageStatus: 'loading',
        name: filenameToItemName(file.name, index + 1),
        tierId: null,
      }

      return { file, item }
    })

    const nextItems = Object.fromEntries(
      pendingEntries.map((entry) => [entry.item.id, entry.item] as const),
    )
    const nextIds = pendingEntries.map((entry) => entry.item.id)

    setItemsById((current) => {
      const merged = { ...current, ...nextItems }
      itemsRef.current = merged
      return merged
    })
    updateBoard((current) => ({
      ...current,
      [POOL_ID]: [...getContainerItems(current, POOL_ID), ...nextIds],
    }))
    setNotice({
      message: `Adding ${pendingEntries.length} dropped image${pendingEntries.length === 1 ? '' : 's'} to the pool...`,
      tone: 'info',
    })

    let ready = 0
    let failed = 0
    let cursor = 0
    const concurrency = Math.min(3, pendingEntries.length)

    async function worker() {
      while (cursor < pendingEntries.length) {
        const entry = pendingEntries[cursor]
        cursor += 1

        try {
          const previewUrl = await resizeImageFile(entry.file)
          patchItem(entry.item.id, {
            image: createCustomImageResult(entry.item, previewUrl),
            imageError: '',
            imageStatus: 'ready',
          })
          ready += 1
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : `Unable to use ${entry.file.name} as an image item.`
          patchItem(entry.item.id, {
            imageError: message,
            imageStatus: 'error',
          })
          failed += 1
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    setNotice({
      message: failed
        ? `Added ${pendingEntries.length} image items to the pool. ${ready} are ready and ${failed} need attention.`
        : `Added ${pendingEntries.length} image item${pendingEntries.length === 1 ? '' : 's'} to the pool.`,
      tone: failed ? 'warning' : 'success',
    })
  }

  function toggleSourceProvider(provider: SourceProvider) {
    if (provider === 'google' && !providerAvailability.google) {
      setNotice({
        message: 'Google Images is not configured yet. Add `GOOGLE_API_KEY` and `GOOGLE_CSE_ID` to enable it here.',
        tone: 'warning',
      })
      return
    }

    let blocked = false

    setProviderSelection((current) => {
      const active = current.sources.includes(provider)

      if (active && current.sources.length === 1) {
        blocked = true
        return current
      }

      const nextSources = SOURCE_PROVIDER_ORDER.filter((entry) =>
        active ? entry !== provider && current.sources.includes(entry) : entry === provider || current.sources.includes(entry),
      )

      return { ...current, sources: nextSources }
    })

    if (blocked) {
      setNotice({
        message: 'Keep at least one image source enabled.',
        tone: 'warning',
      })
    }
  }

  function toggleRankerProvider(provider: RankerProvider) {
    if (provider === 'local' && !providerAvailability.local) {
      setNotice({
        message: 'Local CLIP is disabled for this server.',
        tone: 'warning',
      })
      return
    }

    if (provider === 'gemini' && !providerAvailability.gemini) {
      setNotice({
        message: 'Gemini is not configured yet. Add `GEMINI_API_KEY` to enable it here.',
        tone: 'warning',
      })
      return
    }

    if (provider === 'groq' && !providerAvailability.groq) {
      setNotice({
        message: 'Groq is not configured yet. Add `GROQ_API_KEY` to enable it here.',
        tone: 'warning',
      })
      return
    }

    setProviderSelection((current) => {
      const nextRankers = RANKER_PROVIDER_ORDER.filter((entry) =>
        current.rankers.includes(provider)
          ? entry !== provider && current.rankers.includes(entry)
          : entry === provider || current.rankers.includes(entry),
      )

      return { ...current, rankers: nextRankers }
    })
  }

  async function lookupAllImages() {
    const itemIds = Object.keys(itemsRef.current)
    if (!itemIds.length) {
      setNotice({ message: 'Add a few items before running the image matcher.', tone: 'warning' })
      return
    }
    setBulkRunning(true)
    setNotice({ message: `Searching ${itemIds.length} items with ${selectionSummary(providerSelectionRef.current).toLowerCase()}...`, tone: 'info' })
    let cursor = 0
    let completed = 0
    const concurrency = Math.min(3, itemIds.length)
    async function worker() {
      while (cursor < itemIds.length) {
        const itemId = itemIds[cursor]
        cursor += 1
        await lookupImageForItem(itemId, true)
        completed += 1
        setNotice({ message: `Matched ${completed} of ${itemIds.length} items.`, tone: completed === itemIds.length ? 'success' : 'info' })
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    setBulkRunning(false)
    setNotice({ message: 'Image matching finished across the active matcher stack.', tone: 'success' })
  }

  async function autoLookupNewItems(itemIds: string[]) {
    if (!itemIds.length || backendReady === false) {
      return
    }

    setAutoPickingItems(true)
    let cursor = 0
    let matched = 0
    let failed = 0
    const concurrency = Math.min(3, itemIds.length)

    try {
      async function worker() {
        while (cursor < itemIds.length) {
          const itemId = itemIds[cursor]
          cursor += 1
          const ok = await lookupImageForItem(itemId, true)
          if (ok) matched += 1
          else failed += 1
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      setNotice({
        message: failed ? `Added ${itemIds.length} items. Auto-picked ${matched} image${matched === 1 ? '' : 's'} and left ${failed} for manual review.` : `Added ${itemIds.length} item${itemIds.length === 1 ? '' : 's'} and auto-picked image${itemIds.length === 1 ? '' : 's'}.`,
        tone: failed ? 'warning' : 'success',
      })
    } finally {
      setAutoPickingItems(false)
    }
  }

  async function captureBoardImage() {
    if (!boardExportRef.current) {
      throw new Error('The tier board is not ready to export yet.')
    }

    setMenuOpenId(null)
    await waitForNextPaint()

    return toPng(boardExportRef.current, {
      cacheBust: true,
      filter: (node) => !(node instanceof HTMLElement && node.classList.contains('lane-add-button')),
      pixelRatio: 2,
    })
  }

  async function exportBoard() {
    try {
      const dataUrl = await captureBoardImage()
      const link = document.createElement('a')
      link.download = `${slugify(title || 'tier-list')}.png`
      link.href = dataUrl
      link.click()
      setNotice({ message: 'Exported the tier board as a PNG without the pool.', tone: 'success' })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Export failed. Some remote images may not expose CORS headers for canvas export.'
      setNotice({ message, tone: 'error' })
    }
  }

  async function shareBoardToDiscord() {
    if (backendReady === false) {
      setNotice({
        message: 'Discord sharing needs the backend online.',
        tone: 'warning',
      })
      return
    }

    if (!discordConfigured) {
      setNotice({
        message: 'Discord bot sharing is not configured yet. Add `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` on the server.',
        tone: 'warning',
      })
      return
    }

    setSharingToDiscord(true)

    try {
      const imageDataUrl = await captureBoardImage()
      const response = await fetch('/api/discord/share', {
        body: JSON.stringify({
          imageDataUrl,
          listContext,
          title,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const payload = (await response.json()) as DiscordShareResponse | { error?: string }
      const errorMessage = 'error' in payload ? payload.error : undefined

      if (!response.ok || !('ok' in payload)) {
        throw new Error(errorMessage || 'Unable to share this tier list to Discord.')
      }

      setNotice({
        message: `Shared "${title || 'Untitled tier list'}" to Discord.`,
        tone: 'success',
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to share this tier list to Discord.'
      setNotice({ message, tone: 'error' })
    } finally {
      setSharingToDiscord(false)
    }
  }

  function clearPlacements() {
    const allIds = Object.keys(itemsRef.current)
    const nextBoard = { ...createBoard(tiers), [POOL_ID]: allIds }
    boardStateRef.current = nextBoard
    setBoard(nextBoard)
    setItemsById((current) => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, { ...item, tierId: null }])))
    setNotice({ message: 'Moved every card back to the pool.', tone: 'info' })
  }

  function clearAll() {
    const nextState = createBaseState()
    localStorage.removeItem(STORAGE_KEY)
    setTitle(nextState.title)
    setListContext(nextState.listContext)
    setCompactMode(nextState.compactMode)
    setSidebarCollapsed(nextState.sidebarCollapsed)
    setProviderSelection(filterProviderSelection(nextState.providerSelection, providerAvailability))
    setTierThemeId(nextState.tierThemeId)
    setTiers(nextState.tiers)
    itemsRef.current = nextState.itemsById
    setItemsById(nextState.itemsById)
    boardStateRef.current = nextState.board
    setBoard(nextState.board)
    setActiveId(null)
    resetTierDragState()
    setMenuOpenId(null)
    setProviderMenuOpen(false)
    setThemeMenuOpen(false)
    setTitleSuggestions([])
    setSelectedSuggestionIds([])
    setSuggestionError('')
    setManualItemsInput('')
    pendingUploadItemIdRef.current = null
    closeImagePicker()
    storageWarningShownRef.current = false
    setNotice({
      message: 'Cleared the entire tier list and restored the default board.',
      tone: 'success',
    })
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => !current)
    setMenuOpenId(null)
    setProviderMenuOpen(false)
    setThemeMenuOpen(false)
  }

  function applyTierTheme(themeId: Exclude<TierThemeId, 'custom'>) {
    setTierThemeId(themeId)
    setTiers((current) => withTierThemeColors(current, themeId))
    setThemeMenuOpen(false)
    setNotice({
      message: `${tierThemeLabel(themeId)} theme applied across the tier stack.`,
      tone: 'success',
    })
  }

  function useCustomTierColors() {
    setTierThemeId('custom')
    setThemeMenuOpen(false)
    setNotice({
      message: 'Tier colors are now in custom mode. Manual color edits will stay as-is.',
      tone: 'info',
    })
  }

  function addTier() {
    const id = createId('tier')
    const nextTier: TierConfig = { color: '#2f6bff', id, label: `Tier ${tiers.length + 1}` }
    setTiers((current) => withTierThemeColors([...current, nextTier], tierThemeRef.current))
    updateBoard((current) => ({ ...current, [id]: [] }))
  }

  function updateTier(tierId: string, field: keyof Pick<TierConfig, 'color' | 'label'>, value: string) {
    setTiers((current) => current.map((tier) => (tier.id === tierId ? { ...tier, [field]: value } : tier)))

    if (field === 'color' && tierThemeRef.current !== 'custom') {
      setTierThemeId('custom')
    }
  }

  function resetTierDragState() {
    setDraggingTierId(null)
    setTierDropTargetId(null)
  }

  function handleTierHeaderDragStart(event: React.DragEvent<HTMLElement>, tierId: string) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tierId)
    setMenuOpenId(null)
    setDraggingTierId(tierId)
    setTierDropTargetId(tierId)
  }

  function handleTierHeaderDragOver(event: React.DragEvent<HTMLElement>, tierId: string) {
    if (!draggingTierId) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    if (tierDropTargetId !== tierId) {
      setTierDropTargetId(tierId)
    }
  }

  function handleTierHeaderDrop(event: React.DragEvent<HTMLElement>, targetTierId: string) {
    if (!draggingTierId) {
      return
    }

    event.preventDefault()

    if (draggingTierId === targetTierId) {
      resetTierDragState()
      return
    }

    setTiers((current) => {
      const activeIndex = current.findIndex((tier) => tier.id === draggingTierId)
      const targetIndex = current.findIndex((tier) => tier.id === targetTierId)

      if (activeIndex === -1 || targetIndex === -1) {
        return current
      }

      return withTierThemeColors(arrayMove(current, activeIndex, targetIndex), tierThemeRef.current)
    })
    resetTierDragState()
  }

  function removeTier(tierId: string) {
    const idsToMove = getContainerItems(boardStateRef.current, tierId)
    const nextTiers = withTierThemeColors(tiers.filter((tier) => tier.id !== tierId), tierThemeRef.current)
    setTiers(nextTiers)
    updateBoard((current) => {
      const nextBoard = createBoard(nextTiers)
      for (const [containerId, itemIds] of Object.entries(current)) {
        if (containerId === tierId || containerId === POOL_ID) continue
        nextBoard[containerId] = [...itemIds]
      }
      nextBoard[POOL_ID] = [...getContainerItems(current, POOL_ID), ...idsToMove]
      return nextBoard
    })
    setItemsById((current) => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, { ...item, tierId: item.tierId === tierId ? null : item.tierId }])))

    if (draggingTierId === tierId || tierDropTargetId === tierId) {
      resetTierDragState()
    }
  }

  function removeItem(itemId: string) {
    setMenuOpenId((current) => (current === itemId ? null : current))
    if (pickerState.itemId === itemId) {
      closeImagePicker()
    }
    setItemsById((current) => {
      const next = { ...current }
      delete next[itemId]
      return next
    })
    updateBoard((current) => removeItemFromBoard(current, itemId))
  }

  function resetDragState() {
    lastOverId.current = null
    setActiveId(null)
  }

  function handleDragStart(event: DragStartEvent) {
    const itemId = String(event.active.id)
    setMenuOpenId(null)
    if (!itemsRef.current[itemId]) {
      resetDragState()
      return
    }
    setActiveId(itemId)
    lastOverId.current = event.active.id
  }

  function handleDragOver(event: DragOverEvent) {
    if (event.over?.id != null) lastOverId.current = event.over.id
  }

  function handleDragCancel() { resetDragState() }

  function handleDragEnd(event: DragEndEvent) {
    const activeItemId = String(event.active.id)
    const overTargetId = String(event.over?.id ?? lastOverId.current ?? '')
    if (!overTargetId) {
      resetDragState()
      return
    }
    try {
      const currentBoard = boardStateRef.current
      const activeContainer = findContainer(currentBoard, activeItemId)
      const overContainer = findContainer(currentBoard, overTargetId)
      if (!activeContainer || !overContainer) {
        resetDragState()
        return
      }
      if (activeContainer === overContainer) {
        updateBoard((current) => {
          const currentItems = getContainerItems(current, overContainer)
          const activeIndex = currentItems.indexOf(activeItemId)
          const overIndex = overTargetId === overContainer ? currentItems.length - 1 : currentItems.indexOf(overTargetId)
          if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return current
          return { ...current, [overContainer]: arrayMove(currentItems, activeIndex, overIndex) }
        })
      } else {
        updateBoard((current) => moveItemToContainer(current, activeItemId, activeContainer, overContainer, overTargetId))
      }
      patchItem(activeItemId, { tierId: overContainer === POOL_ID ? null : overContainer })
      resetDragState()
    } catch (error) {
      console.error('Drag-and-drop failed.', error)
      resetDragState()
      setNotice({ message: 'That drop action hit an invalid board state. The board was restored safely.', tone: 'warning' })
    }
  }
  return (
    <div className="app-shell" onPointerDown={() => { setMenuOpenId(null); setProviderMenuOpen(false); setThemeMenuOpen(false) }}>
      <header className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Forge Tierlist</span>
          <h1>Build rankings with drag-and-drop cards and auto-picked images.</h1>
          <p>The app searches public image sources with optional Google Images, then uses local AI first with optional Gemini and Groq reranking for tougher matches.</p>
        </div>
        <div className="hero-stats">
          <Stat label="Items" value={String(Object.keys(itemsById).length)} />
          <Stat label="Tiers" value={String(tiers.length)} />
          <Stat label="Mode" value={lookupMode} />
        </div>
      </header>
      <main className={`workspace ${sidebarCollapsed ? 'workspace-sidebar-collapsed' : ''}`}>
        <input accept=".json,application/json" className="visually-hidden" onChange={(event) => { void importListFile(event.currentTarget.files?.[0] || null); event.currentTarget.value = '' }} ref={importFileRef} type="file" />
        <input accept="image/png,image/jpeg,image/webp,image/gif,image/avif" className="visually-hidden" onChange={(event) => { void handleImageUploadSelection(event.currentTarget.files?.[0] || null); event.currentTarget.value = '' }} ref={imageUploadRef} type="file" />
        <aside className={`controls ${sidebarCollapsed ? 'controls-collapsed' : ''}`}>
          {sidebarCollapsed ? (
            <div className="controls-rail">
              <span className="controls-rail-title">Control Bay</span>
              <button aria-label="Open sidebar controls" className="ghost-button sidebar-toggle sidebar-toggle-collapsed" onClick={toggleSidebar} type="button">Open</button>
            </div>
          ) : (
            <div className="sidebar-shell">
              <div className="sidebar-head">
                <div className="sidebar-copy">
                  <span className="sidebar-kicker">Control Bay</span>
                  <strong>List setup, finder, and status</strong>
                </div>
                <button aria-label="Collapse sidebar controls" className="ghost-button sidebar-toggle" onClick={toggleSidebar} type="button">Hide</button>
              </div>
              <div className="controls-body">
                <Panel title="List Setup" action={<div className="button-row"><button className="ghost-button" onClick={clearPlacements} type="button">Reset placements</button><button className="ghost-button ghost-button-danger" onClick={clearAll} type="button">Clear all</button></div>}>
                  <label className="field"><span>List title</span><input onChange={(event) => setTitle(event.target.value)} placeholder="Best platformers ever made" type="text" value={title} /></label>
                  <label className="field"><span>Context for image matching</span><textarea onChange={(event) => setListContext(event.target.value)} placeholder="Nintendo characters, pizza toppings, horror films, wrestling themes..." rows={4} value={listContext} /></label>
                </Panel>
                <Panel title="Item Finder" action={<button className="accent-button" disabled={findingSuggestions || !title.trim()} onClick={() => { void findRelatedItemsFromTitle() }} type="button">{findingSuggestions ? 'Finding items...' : 'Find from title'}</button>}>
                  <div className="finder-manual">
                    <label className="field">
                      <span>Add your own items</span>
                      <textarea onChange={(event) => setManualItemsInput(event.target.value)} placeholder={`Mario\nLuigi\nPrincess Peach | Mario series`} rows={5} value={manualItemsInput} />
                    </label>
                    <div className="finder-manual-toolbar">
                      <span className="finder-summary">One per line works best. Optional context: `Name | Context`, `Name - Context`, or `Name (Context)`.</span>
                      <div className="button-row">
                        <button className="ghost-button" disabled={!manualItemsInput.trim()} onClick={() => setManualItemsInput('')} type="button">Clear text</button>
                        <button className="accent-button" disabled={!manualItemsInput.trim()} onClick={addManualItems} type="button">Add typed items</button>
                      </div>
                    </div>
                  </div>
                  <div className="finder-divider" />
                  <p className="finder-copy">Use the list title and optional context to generate related items, then add the selected ones or the whole batch to the pool.</p>
                  {titleSuggestions.length ? (
                    <>
                      <div className="finder-toolbar">
                        <span className="finder-summary">{titleSuggestions.length} suggestions found, {addableSuggestionCount} still addable.</span>
                        <div className="button-row">
                          <button className="ghost-button" disabled={!addableSuggestionCount} onClick={selectAllSuggestions} type="button">Select all</button>
                          <button className="ghost-button" disabled={!selectedSuggestionIds.length} onClick={clearSuggestionSelection} type="button">Clear selection</button>
                          <button className="ghost-button" disabled={!selectedAddableSuggestionCount} onClick={() => addSuggestedItems('selected')} type="button">Add selected</button>
                          <button className="accent-button" disabled={!addableSuggestionCount} onClick={() => addSuggestedItems('all')} type="button">Add all</button>
                        </div>
                      </div>
                      <div className="finder-grid">
                        {titleSuggestions.map((suggestion) => {
                          const alreadyAdded = existingItemKeys.has(itemKeyFor(suggestion.name, suggestion.context))
                          const selected = selectedSuggestionIds.includes(suggestion.id)

                          return (
                            <button className={`finder-card ${selected ? 'finder-card-selected' : ''} ${alreadyAdded ? 'finder-card-disabled' : ''}`} disabled={alreadyAdded} key={suggestion.id} onClick={() => toggleSuggestionSelection(suggestion.id)} type="button">
                              <span className={`finder-card-flag ${alreadyAdded ? 'finder-card-flag-muted' : selected ? 'finder-card-flag-active' : ''}`}>{alreadyAdded ? 'In pool' : selected ? 'Selected' : 'Pick'}</span>
                              <strong>{suggestion.name}</strong>
                              {suggestion.context ? <span>{suggestion.context}</span> : <span>Uses the list title as context.</span>}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <div className={`finder-state ${suggestionError ? 'finder-state-error' : ''}`}>{suggestionError || 'Set a title, then generate a batch of related items to review before adding them.'}</div>
                  )}
                  <div className="button-row"><button className="accent-button" disabled={bulkRunning || autoPickingItems || !Object.keys(itemsById).length} onClick={() => { void lookupAllImages() }} type="button">{bulkRunning || autoPickingItems ? 'Matching images...' : 'Find images for all'}</button></div>
                </Panel>
                <div className={`notice notice-${notice.tone}`}><strong>{backendReady === false ? 'Backend offline.' : 'Status.'}</strong><span>{notice.message}</span></div>
                <div className="meta-card"><p>Current image APIs: {selectionSummary(providerSelection)}.</p><p>Choose sources and AI rerankers from the `Image APIs` dropdown. With no AI rankers selected, the app falls back to metadata-only matching.</p><p>Discord share: {discordConfigured ? 'enabled for the current board.' : 'disabled until the bot token and channel ID are added on the server.'}</p></div>
              </div>
            </div>
          )}
        </aside>
        <section className="board-column">
          <div className="board-toolbar">
            <div><span className="board-title">{title || 'Untitled tier list'}</span><p className="board-subtitle">Drag cards between the pool and each lane. Edit tier names and colors in the lane headers, then use the drag handle there to reorder tiers.</p></div>
            <div className="toolbar-actions">
              <div className="toolbar-menu-shell" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <button className={`ghost-button ${providerMenuOpen ? 'ghost-button-active' : ''}`} onClick={() => { setThemeMenuOpen(false); setProviderMenuOpen((current) => !current) }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} type="button">Image APIs</button>
                {providerMenuOpen ? (
                  <div className="toolbar-menu-panel">
                    <div className="toolbar-menu-header">
                      <strong>Image APIs</strong>
                      <span>{selectionSummary(providerSelection)}</span>
                    </div>
                    <div className="provider-menu-section">
                      <span className="provider-menu-label">Search Sources</span>
                      {SOURCE_PROVIDER_ORDER.map((provider) => {
                        const disabled = provider === 'google' ? !providerAvailability.google : false

                        return (
                        <label className={`provider-option ${disabled ? 'provider-option-disabled' : ''}`} key={provider}>
                          <input checked={providerSelection.sources.includes(provider)} disabled={disabled} onChange={() => toggleSourceProvider(provider)} type="checkbox" />
                          <span className="provider-option-copy">
                            <strong>{sourceProviderLabel(provider)}</strong>
                            <small>{sourceProviderDescription(provider, disabled)}</small>
                          </span>
                        </label>
                        )
                      })}
                    </div>
                    <div className="provider-menu-section">
                      <span className="provider-menu-label">AI Rankers</span>
                      {RANKER_PROVIDER_ORDER.map((provider) => {
                        const disabled = provider === 'local' ? !providerAvailability.local : provider === 'gemini' ? !providerAvailability.gemini : !providerAvailability.groq

                        return (
                          <label className={`provider-option ${disabled ? 'provider-option-disabled' : ''}`} key={provider}>
                            <input checked={providerSelection.rankers.includes(provider)} disabled={disabled} onChange={() => toggleRankerProvider(provider)} type="checkbox" />
                            <span className="provider-option-copy">
                              <strong>{rankerProviderLabel(provider)}</strong>
                              <small>{rankerProviderDescription(provider, disabled)}</small>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="toolbar-menu-shell" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <button className={`ghost-button ${themeMenuOpen ? 'ghost-button-active' : ''}`} onClick={() => { setProviderMenuOpen(false); setThemeMenuOpen((current) => !current) }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} type="button">Tier Theme</button>
                {themeMenuOpen ? (
                  <div className="toolbar-menu-panel theme-menu-panel">
                    <div className="toolbar-menu-header">
                      <strong>Tier Theme</strong>
                      <span>{tierThemeLabel(tierThemeId)}</span>
                    </div>
                    <div className="theme-menu-grid">
                      <button className={`theme-option ${tierThemeId === 'custom' ? 'theme-option-active' : ''}`} onClick={useCustomTierColors} type="button">
                        <span className="theme-option-swatch theme-option-swatch-custom" />
                        <span className="theme-option-copy">
                          <strong>Custom</strong>
                          <small>Keep the current colors exactly as they are.</small>
                        </span>
                      </button>
                      {TIER_THEME_ORDER.map((themeId) => (
                        <button className={`theme-option ${tierThemeId === themeId ? 'theme-option-active' : ''}`} key={themeId} onClick={() => applyTierTheme(themeId)} type="button">
                          <span className="theme-option-swatch" style={{ '--theme-gradient': tierThemeGradient(themeId) } as CSSProperties} />
                          <span className="theme-option-copy">
                            <strong>{tierThemeLabel(themeId)}</strong>
                            <small>{TIER_THEME_PRESETS[themeId].description}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <button className="ghost-button" onClick={downloadListFile} type="button">Save list</button>
              <button className="ghost-button" onClick={openImportDialog} type="button">Import list</button>
              <button className={`ghost-button ${compactMode ? 'ghost-button-active' : ''}`} onClick={() => setCompactMode((current) => !current)} type="button">{compactMode ? 'Standard cards' : 'Compact mode'}</button>
              <button className="ghost-button" disabled={sharingToDiscord} onClick={() => void shareBoardToDiscord()} type="button">{sharingToDiscord ? 'Sharing...' : 'Share to Discord'}</button>
              <button className="accent-button" onClick={() => void exportBoard()} type="button">Export PNG</button>
            </div>
          </div>
          <div className={`board-surface ${compactMode ? 'board-surface-compact' : ''}`}>
            <DndContext collisionDetection={collisionDetectionStrategy} onDragCancel={handleDragCancel} onDragEnd={handleDragEnd} onDragOver={handleDragOver} onDragStart={handleDragStart} sensors={sensors}>
              <div className="board-shell" ref={boardExportRef}>
                {tiers.map((tier) => (
                  <TierLane color={tier.color} emptyMessage={`Drop cards into ${tier.label}.`} header={<TierEditorHeader count={getContainerItems(board, tier.id).length} dropTarget={Boolean(draggingTierId) && tierDropTargetId === tier.id && draggingTierId !== tier.id} onColorChange={(value) => updateTier(tier.id, 'color', value)} onDragEnd={resetTierDragState} onDragOver={(event) => handleTierHeaderDragOver(event, tier.id)} onDragStart={(event) => handleTierHeaderDragStart(event, tier.id)} onDrop={(event) => handleTierHeaderDrop(event, tier.id)} onLabelChange={(value) => updateTier(tier.id, 'label', value)} onRemove={() => removeTier(tier.id)} removable={tiers.length > 1} tier={tier} dragging={draggingTierId === tier.id} />} id={tier.id} items={mapIdsToItems(board[tier.id] || [], itemsById)} key={tier.id} menuOpenId={menuOpenId} onDropImage={handleImageDrop} onLookup={(itemId) => { void lookupImageForItem(itemId) }} onOpenPicker={(itemId) => { void openImagePicker(itemId) }} onRemove={removeItem} onToggleMenu={(itemId) => setMenuOpenId((current) => current === itemId ? null : itemId)} onUpload={openImageUploadDialog} />
                ))}
                <button className="lane-add-button" onClick={addTier} type="button">Add tier underneath</button>
              </div>
              <div className="pool-island-wrap">
                <TierLane color="#7a808e" emptyMessage="Drop cards here or drop image files to create new items." header={<div className="lane-label-basic"><span className="lane-label-title">Pool</span><strong className="lane-label-count">{poolItems.length}</strong></div>} id={POOL_ID} isPool items={poolItems} menuOpenId={menuOpenId} onDropFiles={(files) => { void addDroppedImagesToPool(files) }} onDropImage={handleImageDrop} onLookup={(itemId) => { void lookupImageForItem(itemId) }} onOpenPicker={(itemId) => { void openImagePicker(itemId) }} onRemove={removeItem} onToggleMenu={(itemId) => setMenuOpenId((current) => current === itemId ? null : itemId)} onUpload={openImageUploadDialog} />
              </div>
              <DragOverlay>{activeItem ? <CardShell item={activeItem} overlay /> : null}</DragOverlay>
            </DndContext>
          </div>
        </section>
      </main>
      {pickerItem ? <ImagePickerModal candidates={pickerState.candidates} currentImage={pickerItem.image} error={pickerState.error} item={pickerItem} loading={pickerState.loading} onChoose={(candidate) => chooseImageCandidate(pickerItem.id, candidate)} onClose={closeImagePicker} query={pickerState.query} recommendedId={pickerState.recommendedId} /> : null}
    </div>
  )
}

function Panel({ action, children, title }: { action?: ReactNode; children: ReactNode; title: string }) {
  return <section className="panel"><div className="panel-header"><h2>{title}</h2>{action}</div><div className="panel-body">{children}</div></section>
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat-card"><span>{label}</span><strong>{value}</strong></div>
}

function TierEditorHeader({ count, dragging = false, dropTarget = false, onColorChange, onDragEnd, onDragOver, onDragStart, onDrop, onLabelChange, onRemove, removable, tier }: { count: number; dragging?: boolean; dropTarget?: boolean; onColorChange: (value: string) => void; onDragEnd: () => void; onDragOver: (event: React.DragEvent<HTMLElement>) => void; onDragStart: (event: React.DragEvent<HTMLElement>) => void; onDrop: (event: React.DragEvent<HTMLElement>) => void; onLabelChange: (value: string) => void; onRemove: () => void; removable: boolean; tier: TierConfig }) {
  return (
    <div className={`tier-lane-header ${dragging ? 'tier-lane-header-dragging' : ''} ${dropTarget ? 'tier-lane-header-target' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
      <div className="tier-lane-top">
        <div aria-label={`Reorder ${tier.label}`} className="tier-drag-handle" draggable onDragEnd={onDragEnd} onDragStart={onDragStart} role="button" tabIndex={0}>::</div>
        <strong className="tier-count-chip">{count}</strong>
      </div>
      <input aria-label={`${tier.label} label`} className="tier-label-input" onChange={(event) => onLabelChange(event.target.value)} type="text" value={tier.label} />
      <div className="tier-lane-tools">
        <input aria-label={`${tier.label} color`} className="color-picker tier-color-picker" onChange={(event) => onColorChange(event.target.value)} type="color" value={tier.color} />
        <button aria-label={`Remove ${tier.label}`} className="icon-button tier-remove-button" disabled={!removable} onClick={onRemove} type="button">x</button>
      </div>
    </div>
  )
}

function TierLane({ color, emptyMessage, header, id, isPool = false, items, menuOpenId, onDropFiles, onDropImage, onLookup, onOpenPicker, onRemove, onToggleMenu, onUpload }: LaneProps) {
  const { isOver, setNodeRef } = useDroppable({ id })
  const [isFileOver, setIsFileOver] = useState(false)
  const fileDragDepthRef = useRef(0)

  function resetLaneFileDropState() {
    fileDragDepthRef.current = 0
    setIsFileOver(false)
  }

  function handleLaneDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!isPool || !onDropFiles || !hasImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    fileDragDepthRef.current += 1
    setIsFileOver(true)
  }

  function handleLaneDragOver(event: React.DragEvent<HTMLElement>) {
    if (!isPool || !onDropFiles || !hasImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!isFileOver) {
      setIsFileOver(true)
    }
  }

  function handleLaneDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!isPool || !onDropFiles || !hasImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)

    if (fileDragDepthRef.current === 0) {
      setIsFileOver(false)
    }
  }

  function handleLaneDrop(event: React.DragEvent<HTMLElement>) {
    if (!isPool || !onDropFiles || !hasImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    resetLaneFileDropState()
    onDropFiles(event.dataTransfer.files)
  }

  return (
    <section className={`lane ${isOver ? 'lane-over' : ''} ${isPool ? 'lane-pool' : ''} ${isFileOver ? 'lane-file-over' : ''}`} onDragEnter={handleLaneDragEnter} onDragLeave={handleLaneDragLeave} onDragOver={handleLaneDragOver} onDrop={handleLaneDrop} ref={setNodeRef} style={{ '--lane-color': color } as CSSProperties}>
      <div className="lane-label">{header}</div>
      <SortableContext items={items.map((item) => item.id)} strategy={rectSortingStrategy}>
        <div className="lane-grid">
          {items.map((item) => <SortableCard item={item} key={item.id} menuOpen={menuOpenId === item.id} onDropImage={onDropImage} onLookup={onLookup} onOpenPicker={onOpenPicker} onRemove={onRemove} onToggleMenu={onToggleMenu} onUpload={onUpload} />)}
          {!items.length ? <div className="lane-empty">{emptyMessage}</div> : null}
        </div>
      </SortableContext>
      {isPool && isFileOver ? <div className="lane-drop-hint"><strong>Drop images to add cards</strong><span>Each file becomes a new pool item using the filename as its title.</span></div> : null}
    </section>
  )
}

function SortableCard({ item, menuOpen = false, onDropImage, onLookup, onOpenPicker, onRemove, onToggleMenu, onUpload }: { item: TierItem; menuOpen?: boolean; onDropImage: (itemId: string, files: FileList | null) => void; onLookup: (itemId: string) => void; onOpenPicker: (itemId: string) => void; onRemove: (itemId: string) => void; onToggleMenu: (itemId: string) => void; onUpload: (itemId: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  return <div ref={setNodeRef} style={{ opacity: isDragging ? 0.4 : 1, transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}><CardShell item={item} menuOpen={menuOpen} onDropImage={onDropImage} onLookup={onLookup} onOpenPicker={onOpenPicker} onRemove={onRemove} onToggleMenu={onToggleMenu} onUpload={onUpload} /></div>
}

function CardShell({ item, menuOpen = false, onDropImage, onLookup, onOpenPicker, onRemove, onToggleMenu, onUpload, overlay = false }: CardShellProps) {
  const [isFileOver, setIsFileOver] = useState(false)
  const dragDepthRef = useRef(0)

  function resetFileDropState() {
    dragDepthRef.current = 0
    setIsFileOver(false)
  }

  function handleDragEnter(event: React.DragEvent<HTMLElement>) {
    if (overlay || !hasSingleImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setIsFileOver(true)
  }

  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (overlay || !hasSingleImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (!isFileOver) {
      setIsFileOver(true)
    }
  }

  function handleDragLeave(event: React.DragEvent<HTMLElement>) {
    if (overlay || !hasSingleImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setIsFileOver(false)
    }
  }

  function handleDrop(event: React.DragEvent<HTMLElement>) {
    if (overlay || !hasSingleImageFilePayload(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    resetFileDropState()
    onDropImage?.(item.id, event.dataTransfer.files)
  }

  return (
    <article className={`card ${overlay ? 'card-overlay' : ''} ${isFileOver ? 'card-file-over' : ''}`} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop}>
      <div className="card-image">
        {item.image?.previewUrl ? <img alt={item.image.title} crossOrigin="anonymous" src={item.image.previewUrl} /> : <div className="card-fallback">{initialsFor(item.name)}</div>}
        {item.imageStatus === 'loading' ? <span className="card-badge">Searching</span> : null}
        {!overlay && isFileOver ? <div className="card-drop-hint"><strong>Drop image</strong><span>Replace {item.name}</span></div> : null}
        {!overlay ? <button aria-label={`Open actions for ${item.name}`} className="card-menu-trigger" onClick={(event) => { event.stopPropagation(); onToggleMenu?.(item.id) }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }} type="button">...</button> : null}
      </div>
      <div className="card-body">
        <div className="card-copy"><h3>{item.name}</h3>{item.context ? <p>{item.context}</p> : null}</div>
        {!overlay ? <p className="card-drop-copy">Drag an image file onto this card to upload it instantly.</p> : null}
        {item.imageError ? <p className="card-error">{item.imageError}</p> : null}
        {!overlay && menuOpen ? (
          <div className="card-menu" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <button onClick={() => onLookup?.(item.id)} type="button">{item.image ? 'Refresh image' : 'Auto-pick image'}</button>
            <button onClick={() => onUpload?.(item.id)} type="button">{item.image ? 'Upload replacement' : 'Upload image'}</button>
            <button onClick={() => onOpenPicker?.(item.id)} type="button">Choose image</button>
            {item.image && hasSourceLink(item.image) ? <a href={item.image.sourceUrl} rel="noreferrer" target="_blank">Open source</a> : null}
            <button className="card-menu-danger" onClick={() => onRemove?.(item.id)} type="button">Remove item</button>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function ImagePickerModal({ candidates, currentImage, error, item, loading, onChoose, onClose, query, recommendedId }: { candidates: ImageResult[]; currentImage?: ImageResult; error: string; item: TierItem; loading: boolean; onChoose: (candidate: ImageResult) => void; onClose: () => void; query: string; recommendedId: string | null }) {
  return (
    <div className="picker-overlay" onClick={onClose} onPointerDown={onClose} role="presentation">
      <section className="picker-modal" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        <div className="picker-header">
          <div>
            <span className="picker-eyebrow">Image Picker</span>
            <h2>{item.name}</h2>
            {item.context ? <p>{item.context}</p> : null}
            {query ? <p className="picker-query">Search: {query}</p> : null}
          </div>
          <button className="icon-button picker-close" onClick={onClose} type="button">x</button>
        </div>
        {loading ? <div className="picker-state">Searching images...</div> : null}
        {!loading && error ? <div className="picker-state picker-state-error">{error}</div> : null}
        {!loading && !error ? (
          <div className="picker-grid">
            {candidates.map((candidate) => {
              const isCurrent = currentImage?.previewUrl === candidate.previewUrl
              const isRecommended = candidate.id === recommendedId

              return (
                <button className={`picker-card ${isCurrent ? 'picker-card-current' : ''}`} key={candidate.id} onClick={() => onChoose(candidate)} type="button">
                  <div className="picker-card-image">
                    <img alt={candidate.title} src={candidate.previewUrl} />
                    <div className="picker-card-flags">
                      {isRecommended ? <span className="picker-flag">Recommended</span> : null}
                      {isCurrent ? <span className="picker-flag picker-flag-muted">Current</span> : null}
                    </div>
                  </div>
                  <div className="picker-card-body">
                    <strong>{candidate.title}</strong>
                    <span>{candidate.provider}</span>
                    <span>{matchSummary(candidate)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        ) : null}
      </section>
    </div>
  )
}
function createBaseState(): SavedState {
  const tiers = withTierThemeColors(DEFAULT_TIERS, DEFAULT_TIER_THEME_ID)
  return { board: createBoard(tiers), compactMode: false, itemsById: {}, listContext: '', providerSelection: DEFAULT_PROVIDER_SELECTION, sidebarCollapsed: false, tierThemeId: DEFAULT_TIER_THEME_ID, title: 'Untitled tier list', tiers }
}

function hydrateSavedState(parsed: Partial<SavedState> | null | undefined): SavedState {
  const baseState = createBaseState()
  const tiers = Array.isArray(parsed?.tiers) && parsed.tiers.length ? parsed.tiers : DEFAULT_TIERS
  const itemsById = sanitizeItems(parsed?.itemsById)
  const board = normalizeBoard(parsed?.board || createBoard(tiers), tiers, itemsById)
  const tierThemeId = sanitizeTierThemeId(parsed?.tierThemeId)

  return {
    board,
    compactMode: Boolean(parsed?.compactMode),
    itemsById,
    listContext: typeof parsed?.listContext === 'string' ? parsed.listContext : '',
    providerSelection: sanitizeProviderSelection(parsed?.providerSelection),
    sidebarCollapsed: Boolean(parsed?.sidebarCollapsed),
    tierThemeId,
    title: typeof parsed?.title === 'string' ? parsed.title : baseState.title,
    tiers,
  }
}

function loadSavedState(): SavedState {
  const baseState = createBaseState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return baseState
    const parsed = JSON.parse(raw) as Partial<SavedState>
    return hydrateSavedState(parsed)
  } catch {
    return baseState
  }
}

function sanitizeItems(value: unknown): Record<string, TierItem> {
  if (!value || typeof value !== 'object') return {}
  const entries = Object.entries(value as Record<string, TierItem>)
    .filter(([, item]) => item && typeof item.name === 'string')
    .map(([id, item]) => [
      id,
      {
        context: typeof item.context === 'string' ? item.context : '',
        id,
        image: item.image && typeof item.image.previewUrl === 'string' ? { ...item.image, id: typeof item.image.id === 'string' ? item.image.id : `${id}:image` } : undefined,
        imageError: typeof item.imageError === 'string' ? item.imageError : '',
        imageStatus: item.imageStatus || 'idle',
        name: item.name,
        tierId: typeof item.tierId === 'string' ? item.tierId : null,
      },
    ])
  return Object.fromEntries(entries)
}

function sanitizeProviderSelection(value: unknown): ProviderSelection {
  if (!value || typeof value !== 'object') {
    return DEFAULT_PROVIDER_SELECTION
  }

  const rawSources = Array.isArray((value as ProviderSelection).sources) ? (value as ProviderSelection).sources : DEFAULT_PROVIDER_SELECTION.sources
  const rawRankers = Array.isArray((value as ProviderSelection).rankers) ? (value as ProviderSelection).rankers : DEFAULT_PROVIDER_SELECTION.rankers
  const sourceSet = new Set(rawSources.filter(isSourceProvider))
  const rankerSet = new Set(rawRankers.filter(isRankerProvider))
  const sources = SOURCE_PROVIDER_ORDER.filter((provider) => sourceSet.has(provider))
  const rankers = RANKER_PROVIDER_ORDER.filter((provider) => rankerSet.has(provider))

  return {
    rankers,
    sources: sources.length ? sources : DEFAULT_PROVIDER_SELECTION.sources,
  }
}

function sanitizeTierThemeId(value: unknown): TierThemeId {
  return typeof value === 'string' && (value === 'custom' || TIER_THEME_ORDER.includes(value as Exclude<TierThemeId, 'custom'>))
    ? (value as TierThemeId)
    : 'custom'
}

function tierThemeLabel(themeId: TierThemeId) {
  return themeId === 'custom' ? 'Custom' : TIER_THEME_PRESETS[themeId].label
}

function tierThemeGradient(themeId: Exclude<TierThemeId, 'custom'>) {
  return `linear-gradient(90deg, ${TIER_THEME_PRESETS[themeId].colors.join(', ')})`
}

function withTierThemeColors(tiers: TierConfig[], themeId: TierThemeId) {
  if (themeId === 'custom') {
    return tiers
  }

  const colors = sampleThemeColors(themeId, tiers.length)
  return tiers.map((tier, index) => ({ ...tier, color: colors[index] || tier.color }))
}

function sampleThemeColors(themeId: Exclude<TierThemeId, 'custom'>, count: number) {
  const stops = TIER_THEME_PRESETS[themeId].colors.map(hexToRgb)

  if (!stops.length || count <= 0) {
    return []
  }

  if (count === 1) {
    return [rgbToHex(stops[0])]
  }

  return Array.from({ length: count }, (_, index) => {
    const position = index / Math.max(1, count - 1)
    return rgbToHex(sampleGradient(stops, position))
  })
}

function sampleGradient(stops: Array<{ blue: number; green: number; red: number }>, position: number) {
  if (stops.length === 1) {
    return stops[0]
  }

  const safePosition = clamp(position, 0, 1)
  const segmentLength = 1 / (stops.length - 1)
  const segmentIndex = Math.min(stops.length - 2, Math.floor(safePosition / segmentLength))
  const localStart = stops[segmentIndex]
  const localEnd = stops[segmentIndex + 1]
  const segmentPosition = (safePosition - segmentIndex * segmentLength) / segmentLength

  return {
    blue: Math.round(lerp(localStart.blue, localEnd.blue, segmentPosition)),
    green: Math.round(lerp(localStart.green, localEnd.green, segmentPosition)),
    red: Math.round(lerp(localStart.red, localEnd.red, segmentPosition)),
  }
}

function hexToRgb(value: string) {
  const normalized = value.replace('#', '').trim()
  const expanded = normalized.length === 3 ? normalized.split('').map((entry) => `${entry}${entry}`).join('') : normalized.padEnd(6, '0').slice(0, 6)

  return {
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    red: Number.parseInt(expanded.slice(0, 2), 16),
  }
}

function rgbToHex(color: { blue: number; green: number; red: number }) {
  return `#${toHexChannel(color.red)}${toHexChannel(color.green)}${toHexChannel(color.blue)}`
}

function toHexChannel(value: number) {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
}

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function filterProviderSelection(selection: ProviderSelection, availability: { gemini: boolean; google: boolean; groq: boolean; local: boolean }): ProviderSelection {
  const sources = selection.sources.filter((provider) => provider !== 'google' || availability.google)
  const rankers = selection.rankers.filter((provider) => provider === 'local' ? availability.local : provider === 'gemini' ? availability.gemini : availability.groq)

  return {
    rankers,
    sources: sources.length ? sources : SOURCE_PROVIDER_ORDER.filter((provider) => provider !== 'google'),
  }
}

function createCustomImageResult(item: TierItem, previewUrl: string): ImageResult {
  return {
    attribution: 'Uploaded from your device.',
    confidence: 1,
    creator: '',
    id: `${item.id}:custom-image`,
    license: 'Private upload',
    matchMethod: 'manual',
    previewUrl,
    provider: 'Custom upload',
    reason: 'Uploaded manually.',
    sourceUrl: '',
    title: `${item.name} custom image`,
  }
}

async function resizeImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file to upload.')
  }

  const dataUrl = await readFileAsDataUrl(file)
  const image = await loadImageElement(dataUrl)
  const maxEdge = 720
  const longestEdge = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1)
  const scale = Math.min(1, maxEdge / longestEdge)
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('This browser could not process the uploaded image.')
  }

  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/webp', 0.86)
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Unable to read that image file.'))
    }
    reader.onerror = () => reject(new Error('Unable to read that image file.'))
    reader.readAsDataURL(file)
  })
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to load that image file.'))
    image.src = src
  })
}

function getImageFiles(value: FileList | null | undefined) { return Array.from(value || []).filter((file) => file.type.startsWith('image/')) }
function getDraggedImageFileCount(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return 0
  }

  const itemEntries = Array.from(dataTransfer.items || []).filter((item) => item.kind === 'file')

  if (itemEntries.length) {
    return itemEntries.filter((item) => item.type.startsWith('image/')).length
  }

  return getImageFiles(dataTransfer.files).length
}
function hasImageFilePayload(dataTransfer: DataTransfer | null) { return getDraggedImageFileCount(dataTransfer) > 0 }
function hasSingleImageFilePayload(dataTransfer: DataTransfer | null) { return getDraggedImageFileCount(dataTransfer) === 1 }
function filenameToItemName(filename: string, fallbackIndex: number) {
  const base = filename
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!base) {
    return `Uploaded image ${fallbackIndex}`
  }

  return base.replace(/\b[a-z]/g, (character) => character.toUpperCase())
}

function createBoard(tiers: TierConfig[]): BoardState { return { [POOL_ID]: [], ...Object.fromEntries(tiers.map((tier) => [tier.id, []])) } }

function normalizeBoard(board: BoardState, tiers: TierConfig[], itemsById: Record<string, TierItem>): BoardState {
  const next = createBoard(tiers)
  const seen = new Set<string>()
  const allowedContainers = new Set([POOL_ID, ...tiers.map((tier) => tier.id)])
  for (const [containerId, itemIds] of Object.entries(board)) {
    if (!allowedContainers.has(containerId) || !Array.isArray(itemIds)) continue
    next[containerId] = itemIds.filter((itemId) => {
      if (seen.has(itemId) || !itemsById[itemId]) return false
      seen.add(itemId)
      return true
    })
  }
  for (const itemId of Object.keys(itemsById)) if (!seen.has(itemId)) next[POOL_ID].push(itemId)
  return next
}

function mapIdsToItems(ids: string[], itemsById: Record<string, TierItem>) { return ids.flatMap((id) => (itemsById[id] ? [itemsById[id]] : [])) }
function createId(prefix: string) { return `${prefix}-${globalThis.crypto.randomUUID()}` }
function removeItemFromBoard(board: BoardState, itemId: string) { return Object.fromEntries(Object.entries(board).map(([containerId, itemIds]) => [containerId, itemIds.filter((currentId) => currentId !== itemId)])) }
function getContainerItems(board: BoardState, containerId: string) { return Array.isArray(board[containerId]) ? board[containerId] : [] }
function findContainer(board: BoardState, id: string) { if (Array.isArray(board[id])) return id; return Object.keys(board).find((containerId) => getContainerItems(board, containerId).includes(id)) || null }
function moveItemToContainer(board: BoardState, itemId: string, fromContainer: string, toContainer: string, overId: string) {
  const next: BoardState = Object.fromEntries(Object.entries(board).map(([containerId, itemIds]) => [containerId, [...itemIds]]))
  if (!Array.isArray(next[fromContainer]) || !Array.isArray(next[toContainer])) return next
  const sourceIds = getContainerItems(next, fromContainer).filter((currentId) => currentId !== itemId)
  const targetIds = getContainerItems(next, toContainer).filter((currentId) => currentId !== itemId)
  const insertAt = overId === toContainer ? targetIds.length : targetIds.indexOf(overId)
  next[fromContainer] = sourceIds
  targetIds.splice(insertAt === -1 ? targetIds.length : insertAt, 0, itemId)
  next[toContainer] = targetIds
  return next
}
function initialsFor(value: string) { return value.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') }
function slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') }
function hasSourceLink(image: ImageResult) { return Boolean(image.sourceUrl) && !image.sourceUrl.startsWith('data:') }
function itemKeyFor(name: string, context: string) { return `${name.trim().toLowerCase()}|${context.trim().toLowerCase()}` }
function formatCountLabel(count: number, labels: CountLabel) { return count === 1 ? labels.singular : labels.plural }
function dedupeSuggestionItems(items: Array<{ context: string; name: string }>) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const name = item.name.trim()
    const context = item.context.trim()
    const key = itemKeyFor(name, context)

    if (!name || seen.has(key)) {
      return false
    }

  seen.add(key)
  return true
  }).map((item) => ({ context: item.context.trim(), name: item.name.trim() }))
}
function parseManualEntries(value: string) {
  return dedupeSuggestionItems(
    value
      .split(/\r?\n|;/)
      .flatMap(expandManualEntryLine)
      .map(parseManualEntry)
      .filter((item) => item.name),
  )
}
function expandManualEntryLine(line: string) {
  const trimmed = line.trim()

  if (!trimmed) {
    return []
  }

  if (shouldSplitManualCommaList(trimmed)) {
    return trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  }

  return [trimmed]
}
function shouldSplitManualCommaList(value: string) {
  return value.includes(',') && !value.includes('|') && !value.includes(' - ')
}
function parseManualEntry(value: string) {
  const trimmed = value.trim()
  const pipeIndex = trimmed.lastIndexOf('|')

  if (pipeIndex > 0) {
    return {
      context: trimmed.slice(pipeIndex + 1).trim(),
      name: trimmed.slice(0, pipeIndex).trim(),
    }
  }

  const dashIndex = trimmed.lastIndexOf(' - ')

  if (dashIndex > 0) {
    return {
      context: trimmed.slice(dashIndex + 3).trim(),
      name: trimmed.slice(0, dashIndex).trim(),
    }
  }

  const parenMatch = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(trimmed)

  if (parenMatch) {
    return {
      context: parenMatch[2].trim(),
      name: parenMatch[1].trim(),
    }
  }

  return { context: '', name: trimmed }
}
function isLegacyDefaultProviderSelection(selection: ProviderSelection) {
  return arraysEqual(selection.sources, LEGACY_PROVIDER_SELECTION.sources) && arraysEqual(selection.rankers, LEGACY_PROVIDER_SELECTION.rankers)
}
function arraysEqual<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function matchMethodLabel(method: MatchMethod) { switch (method) { case 'local-ai': return 'local AI scoring'; case 'gemini': return 'Gemini fallback'; case 'groq': return 'Groq fallback'; default: return 'heuristic fallback' } }
function matchMethodShortLabel(method: MatchMethod) { switch (method) { case 'local-ai': return 'Local AI'; case 'gemini': return 'Gemini'; case 'groq': return 'Groq'; case 'manual': return 'Manual'; default: return 'Heuristic' } }
function matchSummary(image: ImageResult) { return image.matchMethod === 'manual' ? 'Manual pick' : `${matchMethodShortLabel(image.matchMethod)} / ${Math.round(image.confidence * 100)}%` }
function isSourceProvider(value: unknown): value is SourceProvider { return typeof value === 'string' && SOURCE_PROVIDER_ORDER.includes(value as SourceProvider) }
function isRankerProvider(value: unknown): value is RankerProvider { return typeof value === 'string' && RANKER_PROVIDER_ORDER.includes(value as RankerProvider) }
function sourceProviderLabel(provider: SourceProvider) { switch (provider) { case 'commons': return 'Wikimedia Commons'; case 'wikipedia': return 'Wikipedia'; case 'google': return 'Google Images'; default: return 'Openverse' } }
function sourceProviderDescription(provider: SourceProvider, disabled = false) { if (disabled) return 'Unavailable until GOOGLE_API_KEY and GOOGLE_CSE_ID are set.'; switch (provider) { case 'commons': return 'Best for file pages and commons uploads.'; case 'wikipedia': return 'Pulls lead article thumbnails from Wikipedia.'; case 'google': return 'Searches Google image results through Programmable Search.'; default: return 'Brings in broader open-license image results.' } }
function rankerProviderLabel(provider: RankerProvider) { switch (provider) { case 'local': return 'Local CLIP'; case 'gemini': return 'Gemini'; default: return 'Groq' } }
function rankerProviderDescription(provider: RankerProvider, disabled = false) { if (disabled) return provider === 'local' ? 'Disabled on this server.' : provider === 'gemini' ? 'Unavailable until GEMINI_API_KEY is set.' : 'Unavailable until GROQ_API_KEY is set.'; switch (provider) { case 'local': return 'Runs on-device before any hosted fallback.'; case 'gemini': return 'Hosted multimodal reranker for harder matches.'; default: return 'Hosted fallback reranker after public image search.' } }
function selectionSummary(selection: ProviderSelection) { return `${selection.sources.length === SOURCE_PROVIDER_ORDER.length ? 'All sources' : selection.sources.map(sourceProviderLabel).join(' + ')} / ${selection.rankers.length === RANKER_PROVIDER_ORDER.length ? 'Auto AI' : selection.rankers.length ? selection.rankers.map(rankerProviderLabel).join(' + ') : 'Heuristic only'}` }

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

export default App
