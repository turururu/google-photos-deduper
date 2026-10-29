import { useEffect, useMemo, useRef, useState } from "react"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Chip from "@mui/material/Chip"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import LinearProgress from "@mui/material/LinearProgress"
import ToggleButton from "@mui/material/ToggleButton"
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup"
import Typography from "@mui/material/Typography"
import { scanIdenticalGroups, type IdenticalScan } from "../lib/identical-scan"
import { DEFAULT_PIXEL_THRESHOLDS } from "../lib/pixel-hash"
import { reviewTrash, type ReviewStatus } from "../lib/trash-review"
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
  /** Shrink the bin to exactly these photos. */
  onKeepOnly: (mediaKeys: string[]) => void
}

const LABEL: Record<ReviewStatus, { text: string; color: "success" | "warning" | "error" }> = {
  proven: { text: "identical to kept", color: "success" },
  unproven: { text: "not proven", color: "warning" },
  "no-keeper": { text: "no copy kept", color: "error" },
  conflict: { text: "kept by another group", color: "error" },
}

const MAX_ROWS = 200

export function TrashReviewDialog({ open, groups, mediaItems, keptOf, trashSet, onClose, onKeepOnly }: Props) {
  const [scan, setScan] = useState<IdenticalScan | null>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "problems">("problems")
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setScan(null)
    setError(null)
    setProgress([0, 0])
    scanIdenticalGroups(groups, mediaItems, {
      signal: ctrl.signal,
      onProgress: (d, t) => setProgress([d, t]),
    })
      .then((s) => !ctrl.signal.aborted && setScan(s))
      .catch((e) => !ctrl.signal.aborted && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !ctrl.signal.aborted && setProgress(null))
    return () => ctrl.abort()
    // groups/mediaItems are read once per open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const review = useMemo(
    () => reviewTrash(groups, mediaItems, keptOf, trashSet, scan, DEFAULT_PIXEL_THRESHOLDS),
    [groups, mediaItems, keptOf, trashSet, scan]
  )
  const shown = review.rows.filter((r) => filter === "all" || r.status !== "proven")
  const provenKeys = review.rows.filter((r) => r.status === "proven").map((r) => r.key)

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Review bin</DialogTitle>
      <DialogContent>
        {progress && <LinearProgress sx={{ mb: 1 }} />}
        {error && <Typography color="error" variant="body2">Check failed: {error}</Typography>}
        <Typography variant="body2" sx={{ mb: 1 }}>
          Checked with the default strict limits (2 s, standard pixel thresholds), so photos you selected with looser
          sliders show as not proven. {review.rows.length.toLocaleString()} photos in the bin: {review.counts.proven.toLocaleString()} identical to a
          kept photo
          {review.counts.unproven > 0 && `, ${review.counts.unproven.toLocaleString()} not proven`}
          {review.counts["no-keeper"] > 0 && `, ${review.counts["no-keeper"].toLocaleString()} with no copy kept`}
          {review.counts.conflict > 0 && `, ${review.counts.conflict.toLocaleString()} kept by another group (blocked)`}.
          {!scan && !error && " Checking pixels…"}
        </Typography>
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} sx={{ mb: 1 }}>
          <ToggleButton value="problems">Needs a look</ToggleButton>
          <ToggleButton value="all">All</ToggleButton>
        </ToggleButtonGroup>
        {shown.slice(0, MAX_ROWS).map((r) => {
          const item = mediaItems[r.key]
          const keeper = r.keeperKey ? mediaItems[r.keeperKey] : undefined
          const l = LABEL[r.status]
          return (
            <Box key={`${r.groupId}:${r.key}`} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
              <Thumb item={item} />
              <Typography variant="caption">→ kept</Typography>
              {keeper ? <Thumb item={keeper} /> : <Box sx={{ width: 80 }} />}
              <Chip size="small" color={l.color} label={l.text} />
              {r.score && (
                <Typography variant="caption" color="text.secondary">
                  bits {r.score.hamming} · colour {r.score.colorMae.toFixed(1)} · local {r.score.cellDiff}
                </Typography>
              )}
            </Box>
          )
        })}
        {shown.length > MAX_ROWS && (
          <Typography variant="caption">Showing {MAX_ROWS} of {shown.length.toLocaleString()}.</Typography>
        )}
        {shown.length === 0 && scan && <Typography variant="body2">Nothing needs a look.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          disabled={!scan || provenKeys.length === 0 || provenKeys.length === review.rows.length}
          onClick={() => { onKeepOnly(provenKeys); onClose() }}>
          Trash only the {provenKeys.length.toLocaleString()} identical
        </Button>
      </DialogActions>
    </Dialog>
  )
}
