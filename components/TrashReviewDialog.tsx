import { useEffect, useMemo, useState } from "react"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Chip from "@mui/material/Chip"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import LinearProgress from "@mui/material/LinearProgress"
import Slider from "@mui/material/Slider"
import ToggleButton from "@mui/material/ToggleButton"
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup"
import Typography from "@mui/material/Typography"
import { EmbeddingCache } from "../lib/embedding-cache"
import { DEFAULT_REVIEW_LIMITS, reviewTrash, type ReviewStatus } from "../lib/trash-review"
import type { DuplicateGroup, GpdMediaItem } from "../lib/types"
import { Thumb } from "./Thumb"

interface Props {
  open: boolean
  /** Groups that have something in the bin. */
  groups: DuplicateGroup[]
  mediaItems: Record<string, GpdMediaItem>
  keptOf: (g: DuplicateGroup) => Set<string>
  /** mediaKeys currently in the bin. */
  trashSet: Set<string>
  onClose: () => void
  /** Shrink the bin to exactly these photos (anything left out becomes kept in its group). */
  onKeepOnly: (mediaKeys: string[]) => void
}

const LABEL: Record<ReviewStatus, { text: string; color: "success" | "warning" | "error" }> = {
  matched: { text: "close match stays", color: "success" },
  "no-match": { text: "no close match stays", color: "warning" },
  "no-keeper": { text: "no copy stays", color: "error" },
  conflict: { text: "kept by another group", color: "error" },
}

const MAX_ROWS = 200
const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`

function Side({ item, role, empty = "nothing" }: { item?: GpdMediaItem; role: "trash" | "stay"; empty?: string }) {
  const color = role === "trash" ? "error.main" : "success.main"
  return (
    <Box sx={{ width: 120 }}>
      <Typography variant="caption" sx={{ color, fontWeight: 600, display: "block" }}>
        {role === "trash" ? "MOVES TO TRASH" : "STAYS"}
      </Typography>
      {item ? (
        <>
          <Box sx={{ border: 2, borderColor: color, borderRadius: 0.5, lineHeight: 0, width: "fit-content" }}>
            <Thumb item={item} size={116} />
          </Box>
          <Typography variant="caption" color="text.secondary" component="div" noWrap title={item.fileName}>
            {item.fileName ?? ""}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            {item.resWidth && item.resHeight ? `${item.resWidth}×${item.resHeight}` : "size unknown"}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            {Number.isFinite(item.timestamp) ? new Date(item.timestamp).toLocaleString() : "no taken time"}
          </Typography>
        </>
      ) : (
        <Box sx={{ height: 116, display: "flex", alignItems: "center" }}>
          <Typography variant="caption" color="error">{empty}</Typography>
        </Box>
      )}
    </Box>
  )
}

export function TrashReviewDialog({ open, groups, mediaItems, keptOf, trashSet, onClose, onKeepOnly }: Props) {
  const [embeddings, setEmbeddings] = useState<Map<string, Float32Array> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "problems">("problems")
  const [minSimilarity, setMinSimilarity] = useState(DEFAULT_REVIEW_LIMITS.minSimilarity)
  const [maxResDiff, setMaxResDiff] = useState(DEFAULT_REVIEW_LIMITS.maxResDiff)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setEmbeddings(null)
    setError(null)
    ;(async () => {
      const cache = await EmbeddingCache.open()
      try {
        const keys = [...new Set(groups.flatMap((g) => g.mediaKeys))]
        const vecs = await cache.getMany(keys)
        const map = new Map<string, Float32Array>()
        keys.forEach((k, i) => vecs[i] && map.set(k, vecs[i]!))
        if (!cancelled) setEmbeddings(map)
      } finally {
        cache.close()
      }
    })().catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
      setEmbeddings(null) // release the vectors when the dialog closes
    }
    // groups are read once per open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const review = useMemo(
    () => reviewTrash(groups, mediaItems, keptOf, trashSet, embeddings, { minSimilarity, maxResDiff }),
    [groups, mediaItems, keptOf, trashSet, embeddings, minSimilarity, maxResDiff]
  )
  // Candidates: least similar first (never compared at the very top).
  const shown = review.rows
    .filter((r) => filter === "all" || r.status !== "matched")
    .sort((a, b) => filter === "all" ? 0 : (a.similarity ?? -1) - (b.similarity ?? -1))
  const spread = useMemo(() => {
    const bins = { "≥99%": 0, "98–99%": 0, "97–98%": 0, "<97%": 0, "not compared": 0 }
    for (const r of review.rows) {
      const s = r.similarity
      if (s === undefined) bins["not compared"]++
      else if (s >= 0.99) bins["≥99%"]++
      else if (s >= 0.98) bins["98–99%"]++
      else if (s >= 0.97) bins["97–98%"]++
      else bins["<97%"]++
    }
    return Object.entries(bins).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n.toLocaleString()}`).join(" · ")
  }, [review])
  const binKeys = review.rows.map((r) => r.key)
  const matchedKeys = review.rows.filter((r) => r.status === "matched").map((r) => r.key)
  const loading = !embeddings && !error

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Review bin</DialogTitle>
      <DialogContent>
        {loading && <LinearProgress sx={{ mb: 1 }} />}
        {error && <Typography color="error" variant="body2">Could not load similarities: {error}</Typography>}
        <Typography variant="body2" sx={{ mb: 1 }}>
          Every photo going to the trash is compared with the photos of its group that stay. It counts as covered when
          one of them looks the same and has about the same resolution.{" "}
          {review.rows.length.toLocaleString()} in the bin: {review.counts.matched.toLocaleString()} covered
          {review.counts["no-match"] > 0 && `, ${review.counts["no-match"].toLocaleString()} with no close match`}
          {review.counts["no-keeper"] > 0 && `, ${review.counts["no-keeper"].toLocaleString()} with no copy staying`}
          {review.counts.conflict > 0 && `, ${review.counts.conflict.toLocaleString()} kept by another group (blocked)`}.
        </Typography>
        {!loading && <Typography variant="caption" color="text.secondary" component="div">Similarity to the closest photo that stays — {spread}</Typography>}
        <Typography variant="caption" component="div">Close match = at least {pct(minSimilarity)} similar</Typography>
        <Slider size="small" min={0.9} max={1} step={0.005} value={minSimilarity}
          onChange={(_, v) => setMinSimilarity(v as number)} />
        <Typography variant="caption" component="div">Resolution within {pct(maxResDiff, 0)} of each other</Typography>
        <Slider size="small" min={0} max={0.2} step={0.01} value={maxResDiff}
          onChange={(_, v) => setMaxResDiff(v as number)} />
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} sx={{ my: 1 }}>
          <ToggleButton value="problems">Candidates to restore</ToggleButton>
          <ToggleButton value="all">All</ToggleButton>
        </ToggleButtonGroup>
        {shown.slice(0, MAX_ROWS).map((r) => {
          const l = LABEL[r.status]
          return (
            <Box key={`${r.groupId}:${r.key}`} sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1, borderTop: 1, borderColor: "divider" }}>
              <Side item={mediaItems[r.key]} role="trash" />
              <Typography>→</Typography>
              <Side
                item={r.keeperKey ? mediaItems[r.keeperKey] : undefined}
                role="stay"
                empty={r.status === "conflict" ? "this photo is kept by another group" : "no photo stays"}
              />
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, alignItems: "flex-start" }}>
                <Chip size="small" color={l.color} label={l.text} />
                {(r.status === "matched" || r.status === "no-match") && (
                  <Typography variant="caption" color="text.secondary">
                    {r.similarity === undefined ? "not compared: no embedding" : `${pct(r.similarity)} similar`}
                    {r.resDiff === undefined ? " · resolution unknown" : ` · resolution ${pct(r.resDiff)} apart`}
                  </Typography>
                )}
                <Button size="small" onClick={() => onKeepOnly(binKeys.filter((k) => k !== r.key))}>
                  {r.status === "conflict" ? "Keep it (fixes the conflict)" : "Keep this one (don't trash)"}
                </Button>
              </Box>
            </Box>
          )
        })}
        {shown.length > MAX_ROWS && (
          <Typography variant="caption">Showing {MAX_ROWS} of {shown.length.toLocaleString()}.</Typography>
        )}
        {shown.length === 0 && !loading && <Typography variant="body2">Nothing needs a look.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          disabled={loading || matchedKeys.length === 0 || matchedKeys.length === review.rows.length}
          onClick={() => { onKeepOnly(matchedKeys); onClose() }}>
          Keep the {(review.rows.length - matchedKeys.length).toLocaleString()} without a close match (trash only the {matchedKeys.length.toLocaleString()} covered)
        </Button>
      </DialogActions>
    </Dialog>
  )
}
