import CloseIcon from "@mui/icons-material/Close"
import Alert from "@mui/material/Alert"
import AppBar from "@mui/material/AppBar"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import CircularProgress from "@mui/material/CircularProgress"
import LinearProgress from "@mui/material/LinearProgress"
import CssBaseline from "@mui/material/CssBaseline"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogContentText from "@mui/material/DialogContentText"
import DialogTitle from "@mui/material/DialogTitle"
import IconButton from "@mui/material/IconButton"
import Snackbar from "@mui/material/Snackbar"
import { ThemeProvider } from "@mui/material/styles"
import Toolbar from "@mui/material/Toolbar"
import Typography from "@mui/material/Typography"
import confetti from "canvas-confetti"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"

import { ActionBar } from "../components/ActionBar"
import { DuplicateGroups } from "../components/DuplicateGroups"
import { ScanConfig } from "../components/ScanConfig"
import { ScanProgress } from "../components/ScanProgress"
import { appReducer } from "../lib/app-reducer"
import type { AppAction, AppState } from "../lib/app-reducer"
import { debug } from "../lib/debug"
import {
  fullDetectDuplicates,
  smartDetectDuplicates,
  type IncrementalDelta
} from "../lib/duplicate-detector"
import type { DetectionProgress } from "../lib/duplicate-detector"
import { ViewControls } from "../components/ViewControls"
import { applyViewPrefs, effectiveSelection, trashScope, persistablePrefs, DEFAULT_VIEW_PREFS, type ViewPrefs } from "../lib/group-view"
import { buildClips, writeGroupClips } from "../lib/timelapse"
import { buildContactSheets } from "../lib/contact-sheet"
import { scanIdenticalGroups } from "../lib/identical-scan"
import { provenIdentical, applyPlans } from "../lib/identical-plan"
import { DEFAULT_PIXEL_THRESHOLDS } from "../lib/pixel-hash"
import { SafeSelectDialog } from "../components/SafeSelectDialog"
import { TrashRestoreDialog, type TrashItem } from "../components/TrashRestoreDialog"
import { appendTrashLog, markRestored, trashLogToCsv, type TrashLogEntry } from "../lib/trash-log"
import { summarizeTrash } from "../lib/trash-summary"
import { buildTrashBatch, keepPhotos } from "../lib/trash-batch"
import { reviewTrash } from "../lib/trash-review"
import { TrashReviewDialog } from "../components/TrashReviewDialog"
import { selectDefaultKeep, type KeepOrder } from "../lib/duplicate-detector"
import { ScanLogger } from "../lib/scan-log"
import theme from "../lib/theme"
import { APP_ID, DEFAULT_SETTINGS } from "../lib/types"
import { areScanResultsValid, canResumeScan, carryOverSelection, scanMetaFor } from "../lib/scan-results"
import {
  countFullyTrashedGroups,
  toggleWholeGroupTrashed
} from "../lib/kept-overrides"
import type {
  AppMessage,
  DuplicateGroup,
  GpdMediaItem,
  GptkProgressMessage,
  GptkResultChunkMessage,
  GptkResultMessage,
  HealthCheckResultMessage,
  ScanSettings,
  StoredState
} from "../lib/types"

// ============================================================
// Helpers
// ============================================================

// Initial healthCheck retries. The first probe often fails on a freshly
// opened app tab because the bridge content script on photos.google.com has
// not finished loading yet, or because the MV3 service worker is still
// spinning up from idle. Backoff: 400ms, 800ms, 1600ms, 3200ms (5 attempts).
const HEALTH_CHECK_MAX_ATTEMPTS = 5

// How long the fetch phase may go without any sign of life before the app
// gives up. The page script times each pagination request out after 60s, so
// silence well past that means the result was lost in transit rather than
// merely slow — most often a message that never arrived (#147). Without this
// the app waits forever and the scan looks frozen mid-count.
const FETCH_WATCHDOG_MS = 150_000

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function sendToServiceWorker(message: AppMessage): void {
  chrome.runtime.sendMessage(message)
}

// ============================================================
// App component
// ============================================================

export default function App() {
  const [state, dispatch] = useReducer(appReducer, { status: "connecting" })
  const [storageChecked, setStorageChecked] = useState(false)
  const [settings, setSettings] = useReducer(
    (prev: ScanSettings, next: Partial<ScanSettings>) => ({ ...prev, ...next }),
    DEFAULT_SETTINGS
  )

  // Selection state: which groups are selected for trash
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    new Set()
  )


  // Kept overrides: groupId -> Set of mediaKeys the user marked as "Keep"
  const [keptOverrides, setKeptOverrides] = useState<
    Record<string, Set<string>>
  >({})

  // Confirm dialog state
  const [trashConfirm, setTrashConfirm] = useState<{
    dedupKeys: string[]
    mediaKeysToTrash: string[]
    fullyTrashedGroups: number
    unreviewedGroups: number
  } | null>(null)

  // Undo trash state: stored after a successful trash operation
  const [undoData, setUndoData] = useState<{
    dedupKeys: string[]
    count: number
    skipped?: number
    stoppedEarly?: string
    snapshot: {
      mediaItems: Record<string, GpdMediaItem>
      groups: DuplicateGroup[]
      totalItems: number
    }
  } | null>(null)

  // Refs to capture pre-trash data for undo
  const preTrashSnapshotRef = useRef<{
    mediaItems: Record<string, GpdMediaItem>
    groups: DuplicateGroup[]
    totalItems: number
  } | null>(null)
  const pendingDedupKeysRef = useRef<string[] | null>(null)

  // AbortController for the current scan (cancelled on user request or new scan)
  const scanAbortRef = useRef<AbortController | null>(null)

  // Persisted scan performance logger — survives page reloads via chrome.storage.local
  const scanLoggerRef = useRef(new ScanLogger())

  // Cached media items from previous scan, used to merge with incremental fetch
  const cachedMediaItemsRef = useRef<Record<string, GpdMediaItem> | null>(null)

  // Tracks the requestId of the active scan so stale results from previous
  // scans killed by reload can be dropped (they arrive late from the GP tab)
  const currentScanRequestIdRef = useRef<string | null>(null)

  // Reassembly buffer for chunked getAllMediaItems results, keyed by requestId.
  // Chunks are stored by index because relaying through the service worker does
  // not guarantee arrival order.
  const resultChunksRef = useRef<
    Record<string, { chunks: GpdMediaItem[][]; received: number; total: number }>
  >({})

  // Watchdog for the fetch phase — see FETCH_WATCHDOG_MS.
  const fetchWatchdogRef = useRef<number | null>(null)

  const clearFetchWatchdog = useCallback(() => {
    if (fetchWatchdogRef.current !== null) {
      window.clearTimeout(fetchWatchdogRef.current)
      fetchWatchdogRef.current = null
    }
  }, [])

  // (Re)starts the watchdog. Called on every sign of progress, so the timer
  // measures silence rather than total fetch duration — a slow scan of a huge
  // library keeps running as long as it keeps reporting.
  const armFetchWatchdog = useCallback(() => {
    clearFetchWatchdog()
    fetchWatchdogRef.current = window.setTimeout(() => {
      fetchWatchdogRef.current = null
      if (currentScanRequestIdRef.current === null) return
      console.error("[GPD] fetch watchdog fired — no progress from the Google Photos tab")
      currentScanRequestIdRef.current = null
      resultChunksRef.current = {}
      scanAbortRef.current?.abort()
      dispatch({
        type: "SCAN_ERROR",
        error:
          "Stopped hearing from the Google Photos tab while fetching your library. " +
          "Reload the Google Photos tab and try scanning again."
      })
    }, FETCH_WATCHDOG_MS)
  }, [clearFetchWatchdog])

  // Set at scan start when the saved scan can be extended with only the new photos.
  const incrementalRef = useRef<{
    prev: { groups: DuplicateGroup[]; knownKeys: Set<string>; nextSeq: number }
    selections?: StoredState["selections"]
    reviewed?: string[]
  } | null>(null)

  // Counts failed healthCheck attempts during initial connect so we can retry
  // silently before showing a disconnected error.
  const healthCheckAttemptsRef = useRef(0)

  // Holds selections loaded from storage; applied once when groups first load
  const pendingSelectionsRef = useRef<{
    selectedGroupIds: Set<string>
    keptOverrides: Record<string, Set<string>>
  } | null>(null)

  // Sync selectedGroupIds when groups change (e.g. after scan or trash)
  const stateGroups =
    state.status === "results" || state.status === "trashing"
      ? state.groups
      : null
  const groups = useMemo(() => stateGroups ?? [], [stateGroups])
  useEffect(() => {
    if (pendingSelectionsRef.current) {
      const saved = pendingSelectionsRef.current
      pendingSelectionsRef.current = null
      const validIds = new Set(groups.map((g) => g.id))
      // Restore saved selection, filtered to groups that still exist
      const next = new Set([...saved.selectedGroupIds].filter((id) => validIds.has(id)))
      setSelectedGroupIds(next)
      // Restore kept overrides, filtered to valid groups
      const filteredKept: Record<string, Set<string>> = {}
      for (const [id, keys] of Object.entries(saved.keptOverrides)) {
        if (validIds.has(id)) filteredKept[id] = keys
      }
      setKeptOverrides(filteredKept)
    } else {
      setSelectedGroupIds(new Set(groups.map((g) => g.id)))
      setKeptOverrides({})
    }
  }, [groups])

  const handleToggleGroup = useCallback((groupId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    setSelectedGroupIds(new Set(groups.map((g) => g.id)))
  }, [groups])

  const [safeSelectOpen, setSafeSelectOpen] = useState(false)
  const [viewPrefs, setViewPrefs] = useState<ViewPrefs>(DEFAULT_VIEW_PREFS)
  // Selection the "marked only" filter judges against (see ViewPrefs.selection).
  // Session-only: what Select identical decided per group, to tell partial marks from whole-group ones.
  const [identicalNotes, setIdenticalNotes] = useState<Record<string, string>>({})
  const [selSnapshot, setSelSnapshot] = useState<Set<string>>(new Set())
  const selectedRef = useRef<Set<string>>(selectedGroupIds)
  selectedRef.current = selectedGroupIds
  const [keepOrder, setKeepOrder] = useState<KeepOrder>("oldest")
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashLog, setTrashLog] = useState<TrashLogEntry[]>([])
  const trashLogLoadedRef = useRef(false)
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [trashNext, setTrashNext] = useState<string | null>(null)
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashError, setTrashError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null)
  const trashReqRef = useRef<string | null>(null)
  const restoreReqRef = useRef<{ id: string; keys: Set<string> } | null>(null)
  // Groups the user has looked at; persisted so a 13k-group review can span days.
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set())

  const handleDeselectAll = useCallback(() => {
    setSelectedGroupIds(new Set())
  }, [])

  // Listen for messages from service worker
  useEffect(() => {
    // Shared tail of a completed getAllMediaItems fetch, however it arrived
    // (chunked, or as a single legacy gptkResult).
    const completeMediaFetch = (fetched: GpdMediaItem[]) => {
      // Fetching is done; detection reports progress through its own path.
      clearFetchWatchdog()
      let items = fetched
      const cached = cachedMediaItemsRef.current
      if (cached && Object.keys(cached).length > 0) {
        // Merge: new items take precedence over cached (handles field updates)
        const newItemKeys = new Set(items.map((i) => i.mediaKey))
        const cachedOnly = Object.values(cached).filter(
          (i) => !newItemKeys.has(i.mediaKey)
        )
        items = [...items, ...cachedOnly]
        console.log(
          `[GPD] media items: ${fetched.length} new + ${cachedOnly.length} cached = ${items.length} total`
        )
        cachedMediaItemsRef.current = null
      }
      dispatch({
        type: "SCAN_MEDIA_FETCHED",
        mediaItems: items
      })
      runDuplicateDetection(
        items,
        scanAbortRef.current?.signal ?? new AbortController().signal
      )
    }

    const listener = (message: AppMessage, sender: chrome.runtime.MessageSender) => {
      if (message?.app !== APP_ID) return
      // The bridge content script sends GPTK results via chrome.runtime.sendMessage,
      // which broadcasts to ALL extension contexts — so this listener fires twice:
      // once directly from the bridge (sender.tab set) and once via the service
      // worker relay (no sender.tab). Ignore direct bridge deliveries to avoid
      // processing each result twice.
      if (sender.tab) return

      switch (message.action) {
        case "healthCheck.result": {
          const msg = message as HealthCheckResultMessage
          // Swallow early "failed" results and retry — when the app tab opens
          // before the bridge content script has fully loaded on a fresh
          // photos.google.com tab, or when the service worker has just woken
          // up from MV3 idle, the first probe often misses. Without this the
          // user sees a spurious "disconnected" flash and has to manually hit
          // Retry. We give up after a few attempts and let the reducer show
          // the error.
          if (
            !msg.success &&
            healthCheckAttemptsRef.current < HEALTH_CHECK_MAX_ATTEMPTS - 1
          ) {
            healthCheckAttemptsRef.current++
            const delay = 400 * Math.pow(2, healthCheckAttemptsRef.current - 1)
            window.setTimeout(() => {
              sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
            }, delay)
            return
          }
          if (msg.success) healthCheckAttemptsRef.current = 0
          dispatch({
            type: "HEALTH_CHECK_RESULT",
            payload: msg
          })
          break
        }
        case "gptkResultChunk": {
          const chunk = message as GptkResultChunkMessage
          if (chunk.command !== "getAllMediaItems") break
          // Drop stale chunks from scans that were killed/cancelled
          if (chunk.requestId !== currentScanRequestIdRef.current) {
            console.warn(
              `[GPD] Dropping stale result chunk for requestId ${chunk.requestId} (active: ${currentScanRequestIdRef.current})`
            )
            break
          }
          const buffers = resultChunksRef.current
          let buf = buffers[chunk.requestId]
          if (!buf) {
            buf = {
              chunks: new Array(chunk.totalChunks),
              received: 0,
              total: chunk.totalChunks
            }
            buffers[chunk.requestId] = buf
          }
          armFetchWatchdog()
          // Ignore a duplicate delivery of the same index
          if (buf.chunks[chunk.chunkIndex] !== undefined) break
          buf.chunks[chunk.chunkIndex] = chunk.data as GpdMediaItem[]
          buf.received++
          if (buf.received < buf.total) break

          delete buffers[chunk.requestId]
          const items = buf.chunks.flat()
          console.log(
            `[GPD] reassembled ${items.length} media items from ${buf.total} chunk(s)`
          )
          completeMediaFetch(items)
          break
        }
        case "gptkResult": {
          const result = message as GptkResultMessage
          if (result.command === "getAllMediaItems") {
            // Drop stale results from scans that were killed/cancelled — their
            // GPTK request may have still been in-flight and arrives late
            if (result.requestId !== currentScanRequestIdRef.current) {
              console.warn(
                `[GPD] Dropping stale getAllMediaItems result for requestId ${result.requestId} (active: ${currentScanRequestIdRef.current})`
              )
              break
            }
            if (result.success) {
              completeMediaFetch(result.data as GpdMediaItem[])
            } else {
              clearFetchWatchdog()
              dispatch({
                type: "SCAN_ERROR",
                error: result.error || "Scan failed"
              })
            }
          } else if (result.command === "listTrash") {
            if (result.requestId !== trashReqRef.current) break
            trashReqRef.current = null
            setTrashLoading(false)
            if (result.success) {
              const d = result.data as { items: TrashItem[]; nextPageId: string | null }
              setTrashItems((prev) => {
                const seen = new Set(prev.map((i) => i.mediaKey))
                return [...prev, ...d.items.filter((i) => !seen.has(i.mediaKey))]
              })
              setTrashNext(d.nextPageId)
            } else {
              setTrashError(result.error || "Could not load trash")
            }
          } else if (result.command === "fetchSizes") {
            if (result.success) {
              const d = result.data as { sizes: Record<string, number>; space?: Record<string, { spaceTaken?: number; takesUpSpace?: boolean | null }> }
              dispatch({ type: "SIZES_LOADED", sizes: d.sizes, space: d.space })
            } else {
              console.warn("[GPD] fetching file sizes failed:", result.error)
              sizesRequestRef.current = null // allow a retry on the next state change
            }
          } else if (result.command === "trashItems") {
            if (result.success) {
              const data = result.data as { trashedKeys: string[]; skippedKeys?: string[]; stoppedEarly?: string }
              const trashedKeys = data.trashedKeys || []
              dispatch({ type: "TRASH_COMPLETE", trashedKeys })
              // Set undo data from the snapshot captured before trash
              if (preTrashSnapshotRef.current && pendingDedupKeysRef.current) {
                const snapshot = preTrashSnapshotRef.current
                setTrashLog((log) => appendTrashLog(log, trashedKeys, snapshot.mediaItems))
                // Undo only what was actually trashed (items deleted since the scan are skipped).
                const dedupKeys = trashedKeys
                  .map((k) => snapshot.mediaItems[k]?.dedupKey)
                  .filter((k): k is string => !!k)
                setUndoData({
                  dedupKeys,
                  count: dedupKeys.length,
                  skipped: data.skippedKeys?.length ?? 0,
                  stoppedEarly: data.stoppedEarly,
                  snapshot
                })
                preTrashSnapshotRef.current = null
                pendingDedupKeysRef.current = null
              }
            } else {
              dispatch({
                type: "TRASH_ERROR",
                error: result.error || "Trash failed"
              })
            }
          } else if (result.command === "restoreItems") {
            if (!result.success) {
              // Optimistic restore already happened in UI; show a non-blocking alert
              console.error("GPD: Restore failed:", result.error)
            }
            const pending = restoreReqRef.current
            if (pending && pending.id === result.requestId) {
              restoreReqRef.current = null
              setRestoring(false)
              if (result.success) {
                setTrashItems((prev) => prev.filter((i) => !pending.keys.has(i.dedupKey)))
                setTrashLog((log) => markRestored(log, pending.keys))
                setRestoreMessage(`Restored ${pending.keys.size} items. Re-scan to see them in groups again.`)
              } else {
                setTrashError(result.error || "Restore failed")
              }
            }
          }
          break
        }
        case "gptkLog":
          if ((message as { level?: string }).level === "error") {
            dispatch({ type: "GP_TAB_CLOSED" })
          }
          break
        case "gptkProgress": {
          const progress = message as GptkProgressMessage
          // Any fetch progress means the GP tab is still alive — reset the
          // silence timer.
          if (
            progress.command === undefined &&
            currentScanRequestIdRef.current !== null
          ) {
            armFetchWatchdog()
          }
          if (progress.command === "trashItems") {
            console.log(`[GPD] trash progress: ${progress.itemsProcessed}`)
            dispatch({ type: "TRASH_PROGRESS", trashedSoFar: progress.itemsProcessed })
          } else if (progress.command === "restoreItems") {
            console.log(`[GPD] restore progress: ${progress.itemsProcessed}`)
          } else {
            dispatch({ type: "SCAN_PROGRESS", payload: progress })
          }
          break
        }
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [armFetchWatchdog, clearFetchWatchdog])

  // Keep refs so async callbacks always see latest values
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const stateRef = useRef(state)
  stateRef.current = state

  // Run MediaPipe duplicate detection on fetched media items
  const runDuplicateDetection = useCallback(
    async (items: GpdMediaItem[], signal: AbortSignal) => {
      const logger = scanLoggerRef.current
      await logger.start(items.length)
      try {
        const onProgressCallback = (progress: DetectionProgress) => {
          dispatch({
            type: "SCAN_PROGRESS",
            phase: progress.phase,
            totalItems: progress.total,
            payload: {
              app: APP_ID,
              action: "gptkProgress",
              requestId: "",
              itemsProcessed: progress.current,
              message: `${progress.phase}: ${progress.current}/${progress.total}`
            }
          })
        }

        // Smart mode reports how many timestamp buckets it had to split to
        // keep pairwise comparison bounded; full mode never splits.
        const { groups, bucketsSplit, delta }: { groups: DuplicateGroup[]; bucketsSplit: number; delta?: IncrementalDelta } =
          settingsRef.current.scanMode === "smart"
            ? await smartDetectDuplicates(
                items,
                settingsRef.current.similarityThreshold,
                (settingsRef.current.smartWindowSec ?? 1) * 1000,
                onProgressCallback,
                signal,
                logger
              )
            : await (async () => {
                const result = await fullDetectDuplicates(
                  items,
                  settingsRef.current.similarityThreshold,
                  onProgressCallback,
                  signal,
                  logger,
                  incrementalRef.current?.prev
                )
                return { groups: result.groups, bucketsSplit: 0, delta: result.delta }
              })()

        await logger.finalize("complete", { groupsFound: groups.length })
        currentScanRequestIdRef.current = null

        const mediaItemMap: Record<string, GpdMediaItem> = {}
        for (const item of items) {
          mediaItemMap[item.mediaKey] = item
        }

        const inc = incrementalRef.current
        incrementalRef.current = null
        chrome.storage.local.set({
          scanMeta: scanMetaFor(settingsRef.current, delta?.nextSeq ?? groups.length)
        })
        if (delta && inc) {
          // Old groups kept their ids, so their marks still apply; changed/new ones start fresh.
          const carried = carryOverSelection(
            inc.selections,
            inc.reviewed,
            groups.map((g) => g.id),
            delta.changedIds,
            delta.newIds,
            {
              before: Object.fromEntries(inc.prev.groups.map((g) => [g.id, g.mediaKeys])),
              after: Object.fromEntries(groups.map((g) => [g.id, g.mediaKeys]))
            }
          )
          pendingSelectionsRef.current = {
            selectedGroupIds: carried.selected,
            keptOverrides: carried.keptOverrides
          }
          setReviewedIds(carried.reviewed)
          console.log(
            `[GPD] incremental: ${delta.newIds.length} new, ${delta.changedIds.length} changed, ${delta.droppedIds.length} dropped groups`
          )
        } else {
          setReviewedIds(new Set()) // positional group ids: marks from a previous scan are meaningless
        }
        dispatch({
          type: "SCAN_COMPLETE",
          mediaItems: mediaItemMap,
          groups,
          bucketsSplit
        })
        // Refresh account email after scan — the email in state may be stale
        // if the user switched accounts since the last health check.
        sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
      } catch (error) {
        currentScanRequestIdRef.current = null
        if (error instanceof DOMException && error.name === "AbortError") {
          await logger.finalize("cancelled")
          dispatch({ type: "SCAN_CANCELLED" })
        } else {
          await logger.finalize("error", { error: String(error) })
          dispatch({
            type: "SCAN_ERROR",
            error: `Duplicate detection failed: ${error}`
          })
        }
      }
    },
    []
  )

  // Stop the fetch watchdog if the app tab goes away mid-scan
  useEffect(() => clearFetchWatchdog, [clearFetchWatchdog])

  // Health check on mount + recover any scan log entry orphaned by a page reload
  useEffect(() => {
    sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
    scanLoggerRef.current.recoverStale()
  }, [])

  // Load saved settings and results on mount
  useEffect(() => {
    chrome.storage.local.get(
      ["settings", "scanResults", "selections", "viewPrefs", "reviewed", "keepOrder", "trashLog"],
      (result: Partial<StoredState>) => {
        if (result.trashLog) setTrashLog(result.trashLog)
        trashLogLoadedRef.current = true
        if (result.keepOrder === "newest") setKeepOrder("newest")
        if (result.viewPrefs) setViewPrefs({ ...DEFAULT_VIEW_PREFS, ...persistablePrefs(result.viewPrefs) })
        // Group ids are positional ("group-N"), so marks are only valid for the scan they were made on.
        if (
          result.reviewed &&
          result.scanResults &&
          result.reviewed.scanDate === result.scanResults.scanDate
        ) {
          setReviewedIds(new Set(result.reviewed.ids))
        }
        if (result.settings) {
          setSettings(result.settings)
        }
        if (result.selections) {
          // Store deserialized selections before dispatching LOAD_SAVED_RESULTS so
          // the groups-change effect can apply them when groups first appear
          pendingSelectionsRef.current = {
            selectedGroupIds: new Set(result.selections.selectedGroupIds),
            keptOverrides: Object.fromEntries(
              Object.entries(result.selections.keptOverrides).map(([k, v]) => [k, new Set(v)])
            ),
          }
        }
        if (result.scanResults?.totalItems && Array.isArray(result.scanResults.groups)) {
          dispatch({
            type: "LOAD_SAVED_RESULTS",
            mediaItems: result.scanResults.mediaItems,
            groups: result.scanResults.groups,
            totalItems: result.scanResults.totalItems,
            bucketsSplit: result.scanResults.bucketsSplit,
            scanDate: result.scanResults.scanDate,
            accountEmail: result.scanResults.accountEmail
          })
        }
        setStorageChecked(true)
      }
    )
  }, [])

  // Persist scan results when they change (after scan or trash)
  const mediaItems = state.status === "results" ? state.mediaItems : null

  // Stable default kept sets (one per group, only changes when groups or mediaItems change).
  // Uses smart keep selection: original quality > higher resolution > oldest upload date.
  const defaultKeptSets = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const g of groups) {
      const groupItems = mediaItems
        ? g.mediaKeys.map((k) => mediaItems[k]).filter(Boolean)
        : []
      const defaultKey =
        groupItems.length > 0 ? selectDefaultKeep(groupItems, keepOrder) : g.originalMediaKey
      m.set(g.id, new Set([defaultKey]))
    }
    return m
  }, [groups, mediaItems, keepOrder])

  const getKept = useCallback(
    (group: DuplicateGroup): Set<string> =>
      keptOverrides[group.id] ?? defaultKeptSets.get(group.id) ?? new Set([group.originalMediaKey]),
    [keptOverrides, defaultKeptSets]
  )

  // Marking a group reviewed locks in its current keep pick, so later changes to
  // the oldest/newest toggle or newly loaded file sizes can't silently swap it.
  const handleToggleReviewed = useCallback(
    (groupId: string, value?: boolean) => {
      const has = reviewedIds.has(groupId)
      const want = value ?? !has
      if (want === has) return
      setReviewedIds((prev) => {
        const next = new Set(prev)
        if (want) next.add(groupId)
        else next.delete(groupId)
        return next
      })
      if (want) {
        const group = groups.find((g) => g.id === groupId)
        if (group)
          setKeptOverrides((prev) => (prev[groupId] ? prev : { ...prev, [groupId]: new Set(getKept(group)) }))
      }
    },
    [reviewedIds, groups, getKept]
  )

  // Per-group kept sets: overridden groups use the live override Set (changes only for
  // the toggled group); unoverridden groups reuse the stable default Set from above so
  // React.memo on DuplicateGroupRow skips re-renders for unaffected rows.
  const keptByGroupId = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const g of groups) {
      m.set(g.id, keptOverrides[g.id] ?? defaultKeptSets.get(g.id)!)
    }
    return m
  }, [groups, keptOverrides, defaultKeptSets])

  const handleToggleKept = useCallback(
    (group: DuplicateGroup, mediaKey: string) => {
      setKeptOverrides((prev) => {
        const current = prev[group.id] ?? defaultKeptSets.get(group.id) ?? new Set([group.originalMediaKey])
        // Prevent removing the last kept item
        if (current.has(mediaKey) && current.size === 1) return prev
        const next = new Set(current)
        if (next.has(mediaKey)) {
          next.delete(mediaKey)
        } else {
          next.add(mediaKey)
        }
        return { ...prev, [group.id]: next }
      })
    },
    [defaultKeptSets]
  )

  // Trash an entire group. This is the only path that leaves a group with no
  // survivor — the per-photo toggle above still refuses to remove the last
  // kept item, so a group can only be emptied deliberately.
  const handleTrashWholeGroup = useCallback((group: DuplicateGroup) => {
    setKeptOverrides((prev) => toggleWholeGroupTrashed(prev, group.id))
  }, [])

  const totalItems = state.status === "results" ? state.totalItems : 0
  const accountEmailForStorage = state.status === "results" ? state.accountEmail : undefined
  const scanDate =
    state.status === "results" || state.status === "trashing" ? state.scanDate : undefined
  const bucketsSplit =
    state.status === "results" || state.status === "trashing"
      ? state.bucketsSplit
      : 0
  useEffect(() => {
    if (!mediaItems) return
    if (groups.length > 0) {
      const newestCreationTimestamp = Object.values(mediaItems).reduce(
        (max, item) => Math.max(max, item.creationTimestamp ?? 0),
        0
      )
      chrome.storage.local.set({
        scanResults: {
          mediaItems,
          groups,
          scanDate: scanDate ?? Date.now(),
          totalItems,
          newestCreationTimestamp,
          bucketsSplit,
          accountEmail: accountEmailForStorage
        }
      })
    } else {
      // All duplicates removed — clear saved results so next open starts fresh
      chrome.storage.local.remove("scanResults")
    }
  }, [groups, mediaItems, totalItems, bucketsSplit, scanDate, accountEmailForStorage])

  // Persist selections when they change (only while results are showing)
  useEffect(() => {
    if (state.status !== "results") return
    if (groups.length === 0) {
      chrome.storage.local.remove("selections")
      return
    }
    chrome.storage.local.set({
      selections: {
        selectedGroupIds: [...selectedGroupIds],
        keptOverrides: Object.fromEntries(
          Object.entries(keptOverrides).map(([k, v]) => [k, [...v]])
        ),
      },
    })
  }, [selectedGroupIds, keptOverrides, state.status, groups.length])

  useEffect(() => {
    if (trashLogLoadedRef.current) chrome.storage.local.set({ trashLog })
  }, [trashLog])

  useEffect(() => {
    if (storageChecked) chrome.storage.local.set({ keepOrder })
  }, [keepOrder, storageChecked])

  useEffect(() => {
    if (storageChecked) chrome.storage.local.set({ viewPrefs: persistablePrefs(viewPrefs) })
  }, [viewPrefs, storageChecked])

  // Drop reviewed ids for groups that no longer exist (new scan / trashed), then persist.
  useEffect(() => {
    if (!storageChecked || state.status !== "results") return
    const valid = new Set(groups.map((g) => g.id))
    const kept = [...reviewedIds].filter((id) => valid.has(id))
    if (kept.length !== reviewedIds.size) setReviewedIds(new Set(kept))
    else chrome.storage.local.set({ reviewed: { scanDate: state.scanDate, ids: kept } })
  }, [reviewedIds, groups, storageChecked, state])

  // File sizes aren't in the library listing: fetch them once for grouped items
  // (also upgrades older saved scans without a rescan).
  const sizesRequestRef = useRef<string | null>(null)
  useEffect(() => {
    // One attempt per scan: items the API returns no size for must not retrigger this.
    if (state.status !== "results" || sizesRequestRef.current === String(state.scanDate)) return
    const missing = new Set<string>()
    for (const g of state.groups)
      for (const k of g.mediaKeys) if (state.mediaItems[k] && (state.mediaItems[k].size === undefined || state.mediaItems[k].takesUpSpace === undefined)) missing.add(k)
    if (missing.size === 0) return
    const requestId = generateRequestId()
    sizesRequestRef.current = String(state.scanDate)
    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "fetchSizes",
      requestId,
      args: { mediaKeys: [...missing] }
    })
  }, [state])

  // A new order or filter should start at the top, not mid-list where the change is invisible.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [viewPrefs])

  const shownGroups = useMemo(
    () => (mediaItems ? applyViewPrefs(groups, mediaItems, viewPrefs, reviewedIds, selSnapshot) : groups),
    [groups, mediaItems, viewPrefs, reviewedIds, selSnapshot]
  )

  // Only groups that are both selected and visible may be trashed.
  const scopeGroups = useMemo(
    () => (mediaItems ? trashScope(groups, mediaItems, viewPrefs, reviewedIds) : groups),
    [groups, mediaItems, viewPrefs, reviewedIds]
  )
  const trashableIds = useMemo(
    () => effectiveSelection(selectedGroupIds, scopeGroups),
    [selectedGroupIds, scopeGroups]
  )

  // Save settings on change
  useEffect(() => {
    chrome.storage.local.set({ settings })
  }, [settings])

  const handleStartScan = useCallback(async (opts?: { full?: boolean }) => {
    // Cancel any in-progress scan
    scanAbortRef.current?.abort()
    scanAbortRef.current = new AbortController()

    const requestId = generateRequestId()
    currentScanRequestIdRef.current = requestId
    // Drop any partially reassembled result from a previous scan
    resultChunksRef.current = {}
    const currentState = stateRef.current
    const hasGptk = currentState.status === "connected" ? currentState.hasGptk : true
    const accountEmail =
      currentState.status === "connected" || currentState.status === "results"
        ? currentState.accountEmail
        : undefined
    dispatch({ type: "SCAN_STARTED", requestId, hasGptk, accountEmail })

    console.log(
      `[GPD] starting scan: mode=${settings.scanMode}, threshold=${settings.similarityThreshold}`
    )

    // Load cached media items for incremental fetch. On a repeat scan we only
    // fetch items newer than the most-recently-seen upload timestamp.
    cachedMediaItemsRef.current = null
    incrementalRef.current = null
    let sinceTimestamp: number | undefined
    try {
      const stored = (await chrome.storage.local.get([
        "scanResults",
        "scanMeta",
        "selections",
        "reviewed"
      ])) as Partial<StoredState>
      const prev = stored.scanResults
      // "Full rescan" ignores everything saved: relist the library and compare every photo.
      if (
        !opts?.full &&
        prev?.mediaItems &&
        Object.keys(prev.mediaItems).length > 0 &&
        areScanResultsValid(prev, { accountEmail })
      ) {
        cachedMediaItemsRef.current = prev.mediaItems
        // Compute watermark if not stored (migration: first run after this deploy)
        sinceTimestamp =
          prev.newestCreationTimestamp ??
          Object.values(prev.mediaItems).reduce(
            (max, item) => Math.max(max, item.creationTimestamp ?? 0),
            0
          )
        console.log(
          `[GPD] media items cache: ${Object.keys(prev.mediaItems).length} items, fetching since ${new Date(sinceTimestamp).toISOString()}`
        )
        if (prev.groups?.length && canResumeScan(stored.scanMeta, settingsRef.current)) {
          incrementalRef.current = {
            prev: {
              groups: prev.groups,
              knownKeys: new Set(Object.keys(prev.mediaItems)),
              nextSeq: stored.scanMeta!.nextSeq
            },
            selections: stored.selections,
            reviewed:
              stored.reviewed?.scanDate === prev.scanDate ? stored.reviewed?.ids : undefined
          }
        }
      }
    } catch {
      // Cache unavailable — do full fetch
    }

    armFetchWatchdog()
    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "getAllMediaItems",
      requestId,
      args: {
        dateRange: settings.dateRange,
        sinceTimestamp
      }
    })
  }, [settings, armFetchWatchdog])

  const handleTrash = useCallback(() => {
    if (state.status !== "results") return

    const batch = buildTrashBatch(state.groups, state.mediaItems, trashableIds, getKept, reviewedIds)
    if (batch.dedupKeys.length === 0) return
    setTrashConfirm(batch)
  }, [state, trashableIds, reviewedIds, getKept])

  const [reviewBinOpen, setReviewBinOpen] = useState(false)
  // The bin always reflects the current selection, so it can be reviewed before "Move to Trash".
  const liveBatch = useMemo(
    () =>
      state.status === "results" && (reviewBinOpen || trashConfirm)
        ? buildTrashBatch(state.groups, state.mediaItems, trashableIds, getKept, reviewedIds)
        : null,
    [state, trashableIds, getKept, reviewedIds, reviewBinOpen, trashConfirm]
  )
  const binSet = useMemo(() => new Set(liveBatch?.mediaKeysToTrash ?? []), [liveBatch])
  const binGroups = useMemo(
    () => (state.status === "results" ? state.groups.filter((g) => g.mediaKeys.some((k) => binSet.has(k))) : []),
    [binSet, state]
  )
  // Photos the bin would trash that another marked group keeps: never allowed.
  const binConflicts = useMemo(
    () =>
      state.status === "results"
        ? reviewTrash(binGroups, state.mediaItems, getKept, binSet, null, DEFAULT_PIXEL_THRESHOLDS).counts.conflict
        : 0,
    [binGroups, binSet, state, getKept]
  )
  // Photos left out of `keys` are restored: they become kept in their groups, so the main view
  // agrees and the next Trash click does not queue them again.
  const handleBinKeepOnly = useCallback(
    (keys: string[]) => {
      if (state.status !== "results") return
      const trash = new Set(keys)
      const restored = new Set(binSet)
      for (const k of trash) restored.delete(k)
      const next = keepPhotos(keptOverrides, state.groups, restored, getKept)
      setKeptOverrides(next)
      if (trashConfirm)
        setTrashConfirm(
          buildTrashBatch(state.groups, state.mediaItems, trashableIds, (g) => next[g.id] ?? getKept(g), reviewedIds)
        )
    },
    [state, binSet, keptOverrides, getKept, trashableIds, reviewedIds, trashConfirm]
  )

  const [backupProgress, setBackupProgress] = useState<[number, number] | null>(null)
  const handleDownloadBackup = useCallback(async () => {
    if (!trashConfirm || state.status !== "results") return
    const items = trashConfirm.mediaKeysToTrash
      .map((k) => state.mediaItems[k])
      .filter((i): i is GpdMediaItem => !!i)
    setBackupProgress([0, items.length])
    setBackupError(null)
    try {
      await buildContactSheets(
        items,
        (filename, html) => {
          const url = URL.createObjectURL(new Blob([html], { type: "text/html" }))
          const a = document.createElement("a")
          a.href = url
          a.download = filename
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 10_000)
        },
        (done, total) => setBackupProgress([done, total])
      )
    } catch (e) {
      setBackupError(`Backup sheet failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBackupProgress(null)
    }
  }, [trashConfirm, state])

  const [backupError, setBackupError] = useState<string | null>(null)
  const videoAbortRef = useRef<AbortController | null>(null)
  const [videoProgress, setVideoProgress] = useState<[number, number] | null>(null)
  const handleDownloadVideo = useCallback(async () => {
    if (!trashConfirm || state.status !== "results") return
    const trashSet = new Set(trashConfirm.mediaKeysToTrash)
    const affected = state.groups.filter((g) => g.mediaKeys.some((k) => trashSet.has(k)))
    setBackupError(null)
    let dir: any
    try {
      // Must be the first await so the click's user activation is still valid.
      dir = await (window as any).showDirectoryPicker({ mode: "readwrite" })
    } catch {
      return // cancelled, or unsupported
    }
    setVideoProgress([0, 0])
    // A trashed photo proven identical to a kept one adds nothing to a video
    // (same frame repeated), so only those are left out. Fingerprints are
    // cached from "Select identical…".
    let provenCount = 0
    let videoGroups = affected
    try {
      const scan = await scanIdenticalGroups(affected, state.mediaItems)
      videoGroups = []
      for (const g of affected) {
        const proven = provenIdentical(g, state.mediaItems, scan.pairs[g.id] ?? [], DEFAULT_PIXEL_THRESHOLDS, trashSet)
        provenCount += proven.size
        const needsClip = g.mediaKeys.some((k) => trashSet.has(k) && !proven.has(k))
        if (needsClip) videoGroups.push({ ...g, mediaKeys: g.mediaKeys.filter((k) => !proven.has(k)) })
      }
    } catch (e) {
      console.warn("[GPD] identical check before video failed; including all groups", e)
      videoGroups = affected
    }
    const clips = buildClips(videoGroups, state.mediaItems)
    if (clips.length === 0) {
      setVideoProgress(null)
      setBackupError(
        provenCount > 0
          ? `No video needed: all ${provenCount} photos are practically identical to a kept photo.`
          : "No groups to record."
      )
      return
    }
    const total = clips.reduce((n, c) => n + c.items.length, 0)
    setVideoProgress([0, total])
    try {
      const ctrl = new AbortController()
      videoAbortRef.current = ctrl
      const r = await writeGroupClips(dir, clips, (d, t) => setVideoProgress([d, t]), ctrl.signal)
      const MB = (r.bytes / 1e6).toFixed(1)
      const sum = summarizeTrash(
        trashConfirm.mediaKeysToTrash.map((k) => state.mediaItems[k]).filter((i): i is GpdMediaItem => !!i)
      )
      const freedGB = sum.bytes / 1e9
      const net = freedGB - r.bytes / 1e9
      setBackupError(
        `${r.aborted ? "Stopped. " : ""}Saved ${r.files} of ${clips.length} dated videos (${MB} MB) to the folder. In that folder run: sh set-dates.sh (sets file dates to the originals), then drag them into photos.google.com. Uploading them uses ${MB} MB again: net saving about ${net.toFixed(2)} GB (sizes known for ${sum.known} of ${sum.items} trashed photos).` +
          (r.dated ? "" : " This browser can't embed dates (WebM): dates may be wrong; the filename carries the taken date.") +
          (provenCount > 0 ? ` ${provenCount} identical photos were left out.` : "")
      )
    } catch (e) {
      console.error("[GPD] video backup failed", e)
      setBackupError(`Video backup failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      videoAbortRef.current = null
      setVideoProgress(null)
    }
  }, [trashConfirm, state])

  const handleTrashConfirmed = useCallback(() => {
    if (!trashConfirm || state.status !== "results") return
    const { dedupKeys, mediaKeysToTrash } = trashConfirm
    setTrashConfirm(null)

    const requestId = generateRequestId()

    // Capture snapshot for undo
    preTrashSnapshotRef.current = {
      mediaItems: state.mediaItems,
      groups: state.groups,
      totalItems: state.totalItems
    }
    pendingDedupKeysRef.current = dedupKeys

    dispatch({
      type: "TRASH_STARTED",
      totalToTrash: dedupKeys.length,
      mediaItems: state.mediaItems,
      groups: state.groups,
      totalItems: state.totalItems
    })

    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "trashItems",
      requestId,
      args: { dedupKeys, mediaKeysToTrash }
    })
  }, [trashConfirm, state])

  const handleCancelScan = useCallback(() => {
    scanAbortRef.current?.abort()
    clearFetchWatchdog()
    currentScanRequestIdRef.current = null
    resultChunksRef.current = {}
    dispatch({ type: "SCAN_CANCELLED" })
  }, [clearFetchWatchdog])

  const handleReset = useCallback(() => {
    clearFetchWatchdog()
    currentScanRequestIdRef.current = null
    resultChunksRef.current = {}
    dispatch({ type: "RESET" })
    healthCheckAttemptsRef.current = 0
    sendToServiceWorker({ app: APP_ID, action: "healthCheck" })
  }, [clearFetchWatchdog])

  const handleUndo = useCallback(() => {
    if (!undoData) return
    // Optimistically restore the UI to the pre-trash state
    dispatch({
      type: "RESTORE_SNAPSHOT",
      mediaItems: undoData.snapshot.mediaItems,
      groups: undoData.snapshot.groups,
      totalItems: undoData.snapshot.totalItems
    })
    // Call GPTK to restore from trash
    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "restoreItems",
      requestId: generateRequestId(),
      args: { dedupKeys: undoData.dedupKeys }
    })
    setTrashLog((log) => markRestored(log, undoData.dedupKeys))
    setUndoData(null)
  }, [undoData])

  const loadTrash = useCallback((pageId: string | null) => {
    const requestId = generateRequestId()
    trashReqRef.current = requestId
    setTrashLoading(true)
    setTrashError(null)
    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "listTrash",
      requestId,
      args: { pageId, max: 2000 }
    })
    window.setTimeout(() => {
      if (trashReqRef.current === requestId) {
        trashReqRef.current = null
        setTrashLoading(false)
        setTrashError("Timed out loading the trash. Is a Google Photos tab open?")
      }
    }, 90_000)
  }, [])

  const handleOpenTrash = useCallback(() => {
    setTrashOpen(true)
    setRestoreMessage(null)
    setTrashItems([])
    setTrashNext(null)
    loadTrash(null)
  }, [loadTrash])

  const handleRestoreFromTrash = useCallback((dedupKeys: string[]) => {
    const requestId = generateRequestId()
    restoreReqRef.current = { id: requestId, keys: new Set(dedupKeys) }
    setRestoring(true)
    setTrashError(null)
    sendToServiceWorker({
      app: APP_ID,
      action: "gptkCommand",
      command: "restoreItems",
      requestId,
      args: { dedupKeys }
    })
    window.setTimeout(() => {
      if (restoreReqRef.current?.id === requestId) {
        restoreReqRef.current = null
        setRestoring(false)
        setTrashError("No confirmation from Google Photos. Check the trash at photos.google.com/trash.")
      }
    }, 5 * 60_000)
  }, [])

  const handleUndoClose = useCallback(() => {
    setUndoData(null)
  }, [])

  // Fire confetti when trash completes
  useEffect(() => {
    if (!undoData) return
    confetti({
      particleCount: 200,
      spread: 100,
      origin: { y: 0.7 }
    })
  }, [undoData])

  // Compute duplicate count for ActionBar
  const duplicateCount =
    state.status === "results"
      ? groups.reduce((sum, group) => {
          if (!trashableIds.has(group.id)) return sum
          const keptSet = keptByGroupId.get(group.id)!
          return sum + group.mediaKeys.filter((k) => !keptSet.has(k)).length
        }, 0)
      : 0

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />

      {/* Sticky header */}
      <AppBar position="sticky">
        <Toolbar>
          <Typography variant="h6" fontWeight={600} sx={{ flexGrow: 1 }}>
            Google Photos Deduper
          </Typography>
          {"accountEmail" in state && state.accountEmail && (
            <Typography variant="body2" sx={{ opacity: 0.8 }}>
              Signed in as {state.accountEmail}
            </Typography>
          )}
        </Toolbar>
      </AppBar>

      {/* Main content */}
      <Box
        component="main"
        sx={{ maxWidth: 1200, mx: "auto", px: 3, minHeight: "60vh" }}>
        {state.status === "connecting" && (
          <Box sx={{ display: "flex", justifyContent: "center", pt: 10 }}>
            <CircularProgress disableShrink />
          </Box>
        )}

        {state.status === "disconnected" && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              pt: 8,
              gap: 2
            }}>
            <Alert severity="error" sx={{ maxWidth: 480, width: "100%" }}>
              {state.error}
            </Alert>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                href="https://photos.google.com/login"
                target="_blank"
                rel="noopener noreferrer">
                Open Google Photos
              </Button>
              <Button variant="outlined" onClick={handleReset}>
                Retry Connection
              </Button>
            </Box>
            <Typography variant="caption" color="text.secondary">
              Return here once Google Photos is open and you're signed in.
            </Typography>
          </Box>
        )}

        {state.status === "connected" && (
          <ScanConfig
            settings={settings}
            onSettingsChange={setSettings}
            onStartScan={handleStartScan}
            hasGptk={state.hasGptk}
          />
        )}

        {state.status === "scanning" && (
          <ScanProgress
            phase={state.phase}
            itemsProcessed={state.itemsProcessed}
            totalEstimate={state.totalEstimate}
            message={state.message}
            onCancel={handleCancelScan}
            oldestUploadedAt={state.oldestUploadedAt}
            oldestTakenAt={state.oldestTakenAt}
          />
        )}

        {state.status === "results" && groups.length === 0 && storageChecked && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              pt: 8,
              gap: 2
            }}>
            <Typography variant="h6" color="text.secondary">
              No duplicates found in your library.
            </Typography>
            <Button variant="contained" onClick={handleReset}>
              Back to Scan
            </Button>
          </Box>
        )}

        {state.status === "results" && groups.length > 0 && (
          <>
            <ActionBar
              totalItems={state.totalItems}
              groupCount={groups.length}
              duplicateCount={duplicateCount}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
              onSelectIdentical={() => setSafeSelectOpen(true)}
              onTrash={handleTrash}
              onReviewBin={() => setReviewBinOpen(true)}
              onRescan={handleReset}
            />
            <SafeSelectDialog
              open={safeSelectOpen}
              scanWindowSec={settings.scanMode === "smart" ? settings.smartWindowSec ?? 1 : undefined}
              groups={shownGroups}
              allGroups={groups}
              mediaItems={state.mediaItems}
              keepOrder={keepOrder}
              keptOverrides={keptOverrides}
              onClose={() => setSafeSelectOpen(false)}
              onApply={(plans, replace) => {
                const r = applyPlans(selectedGroupIds, keptOverrides, plans, { replace })
                setSelectedGroupIds(r.selected)
                setKeptOverrides(r.kept)
                setIdenticalNotes((prev) => ({
                  ...(replace ? {} : prev),
                  ...Object.fromEntries(
                    plans.map((p) => [p.groupId, `identical: ${p.trash.length} trashed, ${p.kept.length} kept`])
                  ),
                }))
              }}
            />
            <TrashRestoreDialog
              open={trashOpen}
              items={trashItems}
              loading={trashLoading}
              error={trashError}
              hasMore={!!trashNext}
              restoring={restoring}
              restoreMessage={restoreMessage}
              onLoadMore={() => loadTrash(trashNext)}
              onRestore={handleRestoreFromTrash}
              loggedCount={trashLog.filter((e) => !e.restored).length}
              onRestoreLogged={() => handleRestoreFromTrash(trashLog.filter((e) => !e.restored).map((e) => e.dedupKey))}
              onExportLog={() => {
                const url = URL.createObjectURL(new Blob([trashLogToCsv(trashLog)], { type: "text/csv" }))
                const a = document.createElement("a")
                a.href = url
                a.download = `trashed-by-deduper-${new Date().toISOString().slice(0, 10)}.csv`
                a.click()
                setTimeout(() => URL.revokeObjectURL(url), 10_000)
              }}
              onClose={() => setTrashOpen(false)}
            />
            <ViewControls
              prefs={viewPrefs}
              onChange={(next) => {
                if (next.selection !== "all" && viewPrefs.selection === "all") setSelSnapshot(new Set(selectedRef.current))
                setViewPrefs(next)
              }}
              selectedCount={selectedGroupIds.size}
              onRefreshSelection={() => setSelSnapshot(new Set(selectedRef.current))}
              shown={shownGroups.length}
              total={groups.length}
              trashScopeCount={scopeGroups.length}
              scanDate={state.scanDate}
              reviewedCount={reviewedIds.size}
              onSelectShown={() => setSelectedGroupIds(new Set(shownGroups.map((g) => g.id)))}
              keepOrder={keepOrder}
              onKeepOrderChange={setKeepOrder}
              onOpenTrash={handleOpenTrash}
            />
            {shownGroups.length === 0 && (
              <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
                No groups match the current filters.
              </Typography>
            )}
            {shownGroups.length > 0 && <DuplicateGroups
              groups={shownGroups}
              mediaItems={state.mediaItems}
              selectedGroupIds={selectedGroupIds}
              onToggleGroup={handleToggleGroup}
              keptByGroupId={keptByGroupId}
              onToggleKept={handleToggleKept}
              onTrashWholeGroup={handleTrashWholeGroup}
              reviewedIds={reviewedIds}
              identicalNotes={identicalNotes}
              onToggleReviewed={handleToggleReviewed}
              bucketsSplit={state.bucketsSplit}
            />}
          </>
        )}

        {state.status === "trashing" && (
          <Box sx={{ maxWidth: 480, mx: "auto", p: 4 }}>
            <Typography variant="h5" fontWeight={600} gutterBottom>
              Moving to Trash
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
              <CircularProgress size={14} thickness={5} />
              <Typography variant="body2" color="text.secondary">
                {state.trashedSoFar > 0
                  ? `${state.trashedSoFar.toLocaleString()} of ${state.totalToTrash.toLocaleString()} moved`
                  : "Starting…"}
              </Typography>
            </Box>
            <LinearProgress
              variant={state.trashedSoFar > 0 ? "determinate" : "indeterminate"}
              value={Math.round((state.trashedSoFar / state.totalToTrash) * 100)}
            />
          </Box>
        )}
      </Box>

      {/* Trash confirm dialog */}
      <Dialog open={!!trashConfirm} onClose={() => setTrashConfirm(null)}>
        <DialogTitle>Move to Trash</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Move {trashConfirm?.dedupKeys.length} duplicate
            {trashConfirm?.dedupKeys.length !== 1 ? "s" : ""} to trash? You can
            restore them from the Google Photos trash.
          </DialogContentText>
          {!!trashConfirm && state.status === "results" && (() => {
            const sum = summarizeTrash(
              trashConfirm.mediaKeysToTrash.map((k) => state.mediaItems[k]).filter((i): i is GpdMediaItem => !!i)
            )
            return (
              <DialogContentText sx={{ mt: 1 }} variant="body2">
                About {(sum.bytes / 1e9).toFixed(2)} GB counted against your storage, freed once Trash is
                emptied ({sum.known.toLocaleString()} of {sum.items.toLocaleString()} items with known size).
              </DialogContentText>
            )
          })()}
          {!!trashConfirm && trashConfirm.unreviewedGroups > 0 && (
            <DialogContentText sx={{ mt: 2 }} color="warning.main">
              {trashConfirm.unreviewedGroups.toLocaleString()} of these groups were never reviewed.
            </DialogContentText>
          )}
          <DialogContentText sx={{ mt: 2 }} variant="body2">
            Optional backups: a thumbnail sheet, or one small time-motion video per group, saved
            into a folder you choose and dated like the original photos (real-time recording: about 1 s per 4 photos, so filter to a batch first for large cleanups).
            Drag the folder's files into Google Photos afterwards. Photos practically identical to a kept photo are
            left out. Recommended: trash the identical groups first (Select identical…). Keep this tab in front while recording.
          </DialogContentText>
          {backupError && (
            <DialogContentText sx={{ mt: 1 }} color="error">{backupError}</DialogContentText>
          )}
          {binConflicts > 0 && (
            <DialogContentText sx={{ mt: 2 }} color="error">
              {binConflicts} photo{binConflicts !== 1 ? "s are" : " is"} marked in one group but kept by another. Open
              Review bin to see them; trashing is blocked until that is fixed.
            </DialogContentText>
          )}
          {!!trashConfirm?.fullyTrashedGroups && (
            <DialogContentText sx={{ mt: 2 }} color="error">
              {trashConfirm.fullyTrashedGroups} group
              {trashConfirm.fullyTrashedGroups !== 1 ? "s" : ""} will be removed
              entirely — no copy will be kept.
            </DialogContentText>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTrashConfirm(null)}>Cancel</Button>
          {videoProgress !== null && videoAbortRef.current && (
            <Button color="warning" onClick={() => videoAbortRef.current?.abort()}>
              Cancel recording
            </Button>
          )}
          <Button onClick={() => setReviewBinOpen(true)} disabled={videoProgress !== null}>Review bin</Button>
          <Button onClick={handleDownloadVideo} disabled={videoProgress !== null}>
            {videoProgress
              ? `Recording ${videoProgress[0]}/${videoProgress[1]}…`
              : "Save dated videos to folder"}
          </Button>
          <Button onClick={handleDownloadBackup} disabled={backupProgress !== null}>
            {backupProgress
              ? `Preparing ${backupProgress[0]}/${backupProgress[1]}…`
              : "Download backup sheet"}
          </Button>
          <Button
            onClick={handleTrashConfirmed}
            disabled={backupProgress !== null || videoProgress !== null || binConflicts > 0 || !trashConfirm?.dedupKeys.length}
            variant="contained"
            color="error">
            Move to Trash
          </Button>
        </DialogActions>
      </Dialog>

      {state.status === "results" && (
        <TrashReviewDialog
          open={reviewBinOpen}
          groups={binGroups}
          mediaItems={state.mediaItems}
          keptOf={getKept}
          trashSet={binSet}
          onClose={() => setReviewBinOpen(false)}
          onKeepOnly={handleBinKeepOnly}
        />
      )}

      {/* Undo trash snackbar */}
      <Snackbar
        open={!!undoData}
        autoHideDuration={null}
        onClose={handleUndoClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message={
          undoData
            ? `${undoData.count} item${undoData.count !== 1 ? "s" : ""} moved to trash` +
              (undoData.skipped ? ` · ${undoData.skipped} skipped (already deleted?)` : "") +
              (undoData.stoppedEarly ? ` · stopped early: ${undoData.stoppedEarly}` : "")
            : ""
        }
        action={
          <>
            <Button color="secondary" size="small" onClick={handleUndo}>
              Undo
            </Button>
            <IconButton size="small" color="inherit" onClick={handleUndoClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      />
    </ThemeProvider>
  )
}
