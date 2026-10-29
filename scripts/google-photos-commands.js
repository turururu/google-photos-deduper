// MAIN world command handler for Google Photos pages.
// This script runs in the page's JS context (injected via <script> tag)
// and has access to GPTK globals: window.gptkApi, window.gptkCore, window.gptkApiUtils.
//
// Communication with the extension happens via window.postMessage.
// The bridge content script (google-photos-bridge.ts) relays these to chrome.runtime.

const GPD_APP_ID = "GPD"

// Number of items per API request for batch operations (trash, restore).
// Matches GPTK's default operationSize. Large single requests cause HTTP 504.
const BATCH_SIZE = 250

function postResult(command, requestId, data) {
  window.postMessage({
    app: GPD_APP_ID,
    action: "gptkResult",
    command,
    requestId,
    success: true,
    data
  })
}

function postError(command, requestId, error) {
  window.postMessage({
    app: GPD_APP_ID,
    action: "gptkResult",
    command,
    requestId,
    success: false,
    error: String(error)
  })
}

// Number of media items per result chunk.
//
// Chrome caps a single extension message at 64MiB. Real-world media items
// serialize to ~460 bytes each, so a 190k-item library produces ~84MB — the
// oversize chrome.runtime.sendMessage in the bridge throws synchronously, the
// result never reaches the app, and the scan hangs on "Fetching media items"
// forever. 10k items is ~4.6MB, leaving room for items far larger than average.
const RESULT_CHUNK_SIZE = 10000

// Sends an array result as a sequence of gptkResultChunk messages.
// Always sends at least one chunk so an empty result still completes.
function postResultChunked(command, requestId, items) {
  const totalChunks = Math.max(1, Math.ceil(items.length / RESULT_CHUNK_SIZE))
  for (let i = 0; i < totalChunks; i++) {
    window.postMessage({
      app: GPD_APP_ID,
      action: "gptkResultChunk",
      command,
      requestId,
      chunkIndex: i,
      totalChunks,
      data: items.slice(i * RESULT_CHUNK_SIZE, (i + 1) * RESULT_CHUNK_SIZE)
    })
  }
  console.log(
    `[GPD] sent ${items.length} items for ${command} in ${totalChunks} chunk(s)`
  )
}

// command is optional; when provided, the app can route progress to the right handler.
// extra carries optional fields such as the fetch position dates.
function postProgress(requestId, itemsProcessed, message, command, extra) {
  window.postMessage({
    app: GPD_APP_ID,
    action: "gptkProgress",
    requestId,
    itemsProcessed,
    message,
    ...(command !== undefined ? { command } : {}),
    ...(extra || {})
  })
}

function chunkArray(arr, size) {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

// ============================================================
// Command: getAllMediaItems
// Fetches all media items from the library via GPTK pagination.
// ============================================================

async function getAllMediaItems(requestId, args) {
  const gptkApi = window.gptkApi
  if (!gptkApi) {
    postError(
      "getAllMediaItems",
      requestId,
      "GPTK API not available. Reload the Google Photos page."
    )
    return
  }

  // sinceTimestamp: stop paginating once we reach items already in the cache
  let sinceTimestamp =
    args && args.sinceTimestamp ? args.sinceTimestamp : null

  // Per-page timeout. Google's pagination endpoint occasionally hangs without
  // ever rejecting fetch(), which used to lock the UI on "Fetching media
  // items" indefinitely. A timeout lets us surface a real error to the user.
  const PAGE_TIMEOUT_MS = 60_000

  function withTimeout(promise, ms, label) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out after ${Math.round(ms / 1000)}s. Google's API likely stalled — please re-scan.`
            )
          ),
        ms
      )
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }

  try {
    let nextPageId = null
    const mediaItems = []
    let reachedCache = false

    // Accounts after the first are addressed via a /u/{index}/ path prefix;
    // computed once since it's invariant for the whole scan.
    const accountUrlPrefix =
      window.location.pathname.match(/^\/u\/\d+\//)?.[0] || "/"

    // Google started rejecting the upload-date listing (EzkLib) with an error
    // envelope ("Missing payload in parsed response"), which aborted every scan
    // on page one. The taken-date timeline (lcxiM) still works and returns the
    // same item shape, so fall back to it for the whole scan. It is not ordered
    // by upload date, so the incremental watermark cannot be used there — the
    // app merges a full fetch with its cache, so correctness is unaffected.
    // Use the taken-date timeline from the start: the upload-date request
    // now fails after 3 retries (~minutes of dead time) before any fallback.
    let useTakenDate = typeof gptkApi.getItemsByTakenDate === "function"
    if (useTakenDate) sinceTimestamp = null
    const fetchPage = (pageId) =>
      useTakenDate
        ? gptkApi.getItemsByTakenDate(null, null, pageId)
        : gptkApi.getItemsByUploadedDate(pageId)

    do {
      let page
      try {
        page = await withTimeout(
          fetchPage(nextPageId),
          PAGE_TIMEOUT_MS,
          "Fetching page from Google Photos"
        )
      } catch (err) {
        if (
          !useTakenDate ||
          nextPageId !== null ||
          typeof gptkApi.getItemsByUploadedDate !== "function"
        )
          throw err
        console.warn(
          "[GPD] taken-date listing failed, falling back to upload-date:",
          err
        )
        useTakenDate = false
        page = await withTimeout(
          fetchPage(null),
          PAGE_TIMEOUT_MS,
          "Fetching page from Google Photos"
        )
      }
      if (!page) {
        console.warn("GPD: Empty page response, stopping pagination")
        break
      }
      if (page.items && page.items.length > 0) {
        for (const item of page.items) {
          // Items are sorted newest-first — stop when we hit the cached watermark
          if (
            sinceTimestamp !== null &&
            item.creationTimestamp <= sinceTimestamp
          ) {
            reachedCache = true
            break
          }
          mediaItems.push({
            mediaKey: item.mediaKey,
            dedupKey: item.dedupKey,
            thumb: item.thumb,
            timestamp: item.timestamp,
            creationTimestamp: item.creationTimestamp,
            resWidth: item.resWidth,
            resHeight: item.resHeight,
            duration: item.duration,
            isOwned: item.isOwned,
            isOriginalQuality: item.isOriginalQuality ?? null,
            // GPTK omits this rather than sending false; normalise to a boolean
            // so downstream keep-selection can test it plainly.
            isFavorite: item.isFavorite === true,
            fileName: item.descriptionShort || null,
            productUrl: "https://photos.google.com" + accountUrlPrefix + "photo/" + item.mediaKey
          })
        }
      }
      nextPageId = page.nextPageId || null

      // Report how far back the fetch has reached. Items arrive newest-first by
      // upload date, so the last item of the page is the oldest seen so far.
      // Only finite, non-zero values are sent — some items carry no usable date
      // and would otherwise render as 1 Jan 1970.
      const oldest = mediaItems[mediaItems.length - 1]
      const position = {}
      if (oldest) {
        if (!useTakenDate && Number.isFinite(oldest.creationTimestamp) && oldest.creationTimestamp > 0)
          position.oldestUploadedAt = oldest.creationTimestamp
        if (Number.isFinite(oldest.timestamp) && oldest.timestamp > 0)
          position.oldestTakenAt = oldest.timestamp
      }

      postProgress(
        requestId,
        mediaItems.length,
        `Fetched ${mediaItems.length} items`,
        undefined,
        position
      )

      if (reachedCache) break
    } while (nextPageId)

    postResultChunked("getAllMediaItems", requestId, mediaItems)
  } catch (error) {
    postError("getAllMediaItems", requestId, error)
  }
}

// ============================================================
// Command: trashItems
// Moves items to trash via GPTK's batch API (no DOM clicking).
// ============================================================

async function trashItems(requestId, args) {
  // Call api.moveItemsToTrash directly instead of gptkApiUtils.moveToTrash,
  // because the latter goes through executeWithConcurrency which checks
  // gptkCore.isProcessRunning (always false when called from extension).
  const api = window.gptkApiUtils?.api
  if (!api) {
    postError(
      "trashItems",
      requestId,
      "GPTK API not available. Reload the Google Photos page."
    )
    return
  }

  try {
    const dedupKeys = args.dedupKeys
    const mediaKeysToTrash = args.mediaKeysToTrash || []
    const total = dedupKeys.length
    const chunks = chunkArray(dedupKeys, BATCH_SIZE)
    console.log(
      `[GPD] trash: ${total} items, ${chunks.length} chunk(s) of ${BATCH_SIZE}`
    )

    // Chunk to avoid HTTP 504 Gateway Timeout on large batches (fixes #107).
    // If a chunk fails (e.g. an item was already deleted since the scan), bisect
    // to isolate the offending items so the rest still get trashed.
    const MAX_SKIPPED = Math.max(20, Math.ceil(total * 0.05))
    const trashedDedup = new Set()
    const skippedDedup = []
    let firstError = null
    let stopped = false
    const trashBisect = async (keys) => {
      if (keys.length === 0 || stopped) return
      try {
        await api.moveItemsToTrash(keys)
        for (const k of keys) trashedDedup.add(k)
      } catch (err) {
        firstError = firstError || err
        if (keys.length === 1) {
          skippedDedup.push(keys[0])
          // Nothing succeeding at all looks like an outage, not deleted items.
          if (
            skippedDedup.length > MAX_SKIPPED ||
            (trashedDedup.size === 0 && skippedDedup.length >= 3)
          )
            stopped = true
          return
        }
        const mid = Math.floor(keys.length / 2)
        await trashBisect(keys.slice(0, mid))
        await trashBisect(keys.slice(mid))
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      await trashBisect(chunks[i])
      postProgress(
        requestId,
        trashedDedup.size + skippedDedup.length,
        `Moved ${trashedDedup.size} of ${total} items to trash`,
        "trashItems"
      )
    }

    if (stopped && trashedDedup.size === 0) throw firstError

    const skippedSet = new Set(skippedDedup)
    const trashedKeys = []
    const skippedKeys = []
    dedupKeys.forEach((dk, i) => {
      const mk = mediaKeysToTrash[i]
      if (mk === undefined) return
      ;(skippedSet.has(dk) ? skippedKeys : trashedKeys).push(mk)
    })
    console.log(
      `[GPD] trash complete: ${trashedDedup.size} moved, ${skippedDedup.length} skipped`
    )
    postResult("trashItems", requestId, {
      trashedCount: trashedDedup.size,
      trashedKeys,
      skippedKeys,
      // Set when too many items failed and the run stopped early; what was
      // trashed so far is still reported so it can be undone.
      stoppedEarly: stopped ? String(firstError?.message ?? firstError) : undefined
    })
  } catch (error) {
    console.error("[GPD] trash error:", error)
    postError("trashItems", requestId, error)
  }
}

// ============================================================
// Command: restoreItems
// Restores items from trash via GPTK's batch API.
// ============================================================

async function restoreItems(requestId, args) {
  // Call api.restoreFromTrash directly (same reason as trashItems —
  // executeWithConcurrency checks isProcessRunning which is always false here).
  const api = window.gptkApiUtils?.api
  if (!api) {
    postError(
      "restoreItems",
      requestId,
      "GPTK API not available. Reload the Google Photos page."
    )
    return
  }

  try {
    const dedupKeys = args.dedupKeys
    const total = dedupKeys.length
    const chunks = chunkArray(dedupKeys, BATCH_SIZE)
    console.log(
      `[GPD] restore: ${total} items, ${chunks.length} chunk(s) of ${BATCH_SIZE}`
    )

    // Chunk to avoid HTTP 504 Gateway Timeout on large batches.
    let restored = 0
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      await api.restoreFromTrash(chunk)
      restored += chunk.length
      console.log(
        `[GPD] restore chunk ${i + 1}/${chunks.length}: ${restored}/${total} done`
      )
      postProgress(
        requestId,
        restored,
        `Restored ${restored} of ${total} items`,
        "restoreItems"
      )
    }

    console.log(`[GPD] restore complete: ${total} items restored`)
    postResult("restoreItems", requestId, { restoredCount: total })
  } catch (error) {
    console.error("[GPD] restore error:", error)
    postError("restoreItems", requestId, error)
  }
}

// ============================================================
// Command: listTrash
// One page-run of the Google Photos trash (newest first), up to args.max items.
// ============================================================

async function listTrash(requestId, args) {
  try {
    const max = args.max || 3000
    let pageId = args.pageId || null
    const items = []
    do {
      const page = await Promise.race([
        window.gptkApi.getTrashItems(pageId),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("Fetching trash timed out")), 60_000)
        )
      ])
      for (const it of page?.items || []) {
        items.push({
          mediaKey: it.mediaKey,
          dedupKey: it.dedupKey,
          thumb: it.thumb,
          timestamp: it.timestamp,
          creationTimestamp: it.creationTimestamp,
          resWidth: it.resWidth,
          resHeight: it.resHeight,
          duration: it.duration
        })
      }
      pageId = page?.nextPageId || null
    } while (pageId && items.length < max)
    postResult("listTrash", requestId, { items, nextPageId: pageId })
  } catch (error) {
    console.error("[GPD] listTrash error:", error)
    postError("listTrash", requestId, error)
  }
}

// ============================================================
// Command: healthCheck
// Verifies GPTK is loaded and WIZ_global_data is available.
// ============================================================

function healthCheck(requestId) {
  const hasGptk = typeof window.gptkApi !== "undefined"
  const hasWizData = typeof window.WIZ_global_data !== "undefined"
  // oPEP7c is the signed-in account email in WIZ_global_data
  const accountEmail = hasWizData ? window.WIZ_global_data.oPEP7c || "" : ""
  postResult("healthCheck", requestId, { hasGptk, hasWizData, accountEmail })
}

// ============================================================
// Command: fetchSizes
// File size in bytes is not in the library listing; fetch it for the given keys.
// ============================================================

async function fetchSizes(requestId, args) {
  try {
    const keys = args.mediaKeys || []
    const sizes = {}
    const space = {}
    for (const chunk of chunkArray(keys, 500)) {
      const infos = await window.gptkApi.getBatchMediaInfo(chunk)
      for (const info of infos || []) {
        if (!info?.mediaKey) continue
        if (typeof info.size === "number") sizes[info.mediaKey] = info.size
        space[info.mediaKey] = {
          spaceTaken: typeof info.spaceTaken === "number" ? info.spaceTaken : undefined,
          takesUpSpace: info.takesUpSpace ?? null
        }
      }
    }
    postResult("fetchSizes", requestId, { sizes, space })
  } catch (error) {
    console.error("[GPD] fetchSizes error:", error)
    postError("fetchSizes", requestId, error)
  }
}

// ============================================================
// Message listener
// ============================================================

window.addEventListener("message", async (event) => {
  if (event.source !== window) return
  const msg = event.data
  if (msg?.app !== GPD_APP_ID || msg?.action !== "gptkCommand") return

  const { command, requestId, args } = msg
  console.log("GPD: Received command", command, requestId)

  switch (command) {
    case "getAllMediaItems":
      await getAllMediaItems(requestId, args)
      break
    case "trashItems":
      await trashItems(requestId, args)
      break
    case "restoreItems":
      await restoreItems(requestId, args)
      break
    case "listTrash":
      await listTrash(requestId, args)
      break
    case "fetchSizes":
      await fetchSizes(requestId, args)
      break
    case "healthCheck":
      healthCheck(requestId)
      break
    default:
      postError(command, requestId, `Unknown command: ${command}`)
  }
})

console.log("GPD: Command handler loaded")
