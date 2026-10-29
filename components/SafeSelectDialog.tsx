import { useEffect, useMemo, useRef, useState } from "react"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import LinearProgress from "@mui/material/LinearProgress"
import Slider from "@mui/material/Slider"
import Typography from "@mui/material/Typography"
import { buildThumbUrl } from "../lib/photo-url"
import { scanIdenticalGroups, type IdenticalScan } from "../lib/identical-scan"
import { planAll, type GroupPlan } from "../lib/identical-plan"
import type { KeepOrder } from "../lib/duplicate-detector"
import { DEFAULT_PIXEL_THRESHOLDS } from "../lib/pixel-hash"
import type { DuplicateGroup, GpdMediaItem } from "../lib/types"
import { useBlobUrl } from "./useBlobUrl"

const SAMPLE_SIZE = 24

function Thumb({ item }: { item: GpdMediaItem }) {
  const { blobUrl } = useBlobUrl(buildThumbUrl(item.thumb, { height: 200 }))
  return (
    <Box
      component="img"
      src={blobUrl}
      sx={{ height: 80, width: 80, objectFit: "cover", borderRadius: 0.5, bgcolor: "action.hover" }}
    />
  )
}

interface Props {
  open: boolean
  groups: DuplicateGroup[]
  mediaItems: Record<string, GpdMediaItem>
  onClose: () => void
  keepOrder: KeepOrder
  keptOverrides: Record<string, Set<string>>
  /** Replaces the selection with these groups and fixes each one's kept set. */
  onApply: (plans: GroupPlan[]) => void
}

/**
 * Finds practically identical groups (metadata + pixel check) and lets the
 * user tune the strictness while looking at the loosest groups that would
 * pass. Selecting never trashes anything.
 */
export function SafeSelectDialog({ open, groups, mediaItems, keepOrder, keptOverrides, onClose, onApply }: Props) {
  const [progress, setProgress] = useState<[number, number]>([0, 0])
  const [scan, setScan] = useState<IdenticalScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [maxHamming, setMaxHamming] = useState(DEFAULT_PIXEL_THRESHOLDS.maxHamming)
  const [maxColorMae, setMaxColorMae] = useState(DEFAULT_PIXEL_THRESHOLDS.maxColorMae)
  const [maxCellDiff, setMaxCellDiff] = useState(DEFAULT_PIXEL_THRESHOLDS.maxCellDiff)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setScan(null)
    setError(null)
    scanIdenticalGroups(groups, mediaItems, {
      signal: ctrl.signal,
      onProgress: (d, t) => setProgress([d, t]),
    })
      .then(setScan)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setError(String(e))
      })
    return () => ctrl.abort()
    // groups/mediaItems intentionally read once per open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const plans = useMemo(
    () =>
      scan
        ? planAll(groups, mediaItems, scan, { maxHamming, maxColorMae, maxCellDiff }, { keepOrder, keptOverrides })
        : [],
    // overrides are read once per scan/threshold change; fine while the dialog is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scan, maxHamming, maxColorMae, maxCellDiff, keepOrder]
  )
  const fullyCount = plans.filter((p) => p.fully).length
  const mixedCount = plans.length - fullyCount
  const trashCount = plans.reduce((n, p) => n + p.trash.length, 0)

  // Loosest matches first: if those look identical, stricter ones are too.
  const sample = useMemo(
    () =>
      plans
        .flatMap((p) => p.trash.map((t) => ({ ...t, groupId: p.groupId })))
        .sort((a, b) => b.score.cellDiff - a.score.cellDiff)
        .slice(0, SAMPLE_SIZE),
    [plans]
  )

  const [done, total] = progress
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Select practically identical groups</DialogTitle>
      <DialogContent>
        {error && <Typography color="error">{error}</Typography>}
        {!scan && !error && (
          <Box sx={{ py: 3 }}>
            <Typography variant="body2" gutterBottom>
              Comparing pixels within groups… {done.toLocaleString()} / {total.toLocaleString()}
            </Typography>
            <LinearProgress variant={total ? "determinate" : "indeterminate"} value={total ? (done / total) * 100 : 0} />
          </Box>
        )}
        {scan && (
          <>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Each photo is compared with the photos that stay, within each group (taken within 2 s, same
              shape, no videos, favorites never trashed). <strong>{fullyCount.toLocaleString()}</strong> groups are
              fully identical, <strong>{mixedCount.toLocaleString()}</strong> are mixed (identical copies are
              selected, the different photos stay). <strong>{trashCount.toLocaleString()}</strong> photos would
              go to trash. Safety rests on this pixel check alone, not on the group similarity.
            </Typography>
            {Object.keys(scan.skipped).length > 0 && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 2 }}>
                Groups not compared:{" "}
                {Object.entries(scan.skipped)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => `${k} ${n.toLocaleString()}`)
                  .join(" · ")}
              </Typography>
            )}
            <Typography variant="caption">Max structure difference: {maxHamming} / 64 bits</Typography>
            <Slider size="small" min={0} max={8} step={1} value={maxHamming}
              onChange={(_, v) => setMaxHamming(v as number)} />
            <Typography variant="caption">Max colour difference: {maxColorMae} / 255</Typography>
            <Slider size="small" min={0} max={16} step={1} value={maxColorMae}
              onChange={(_, v) => setMaxColorMae(v as number)} />
            <Typography variant="caption">Max local difference: {maxCellDiff} / 255 (catches blinks, small changes)</Typography>
            <Slider size="small" min={4} max={64} step={2} value={maxCellDiff}
              onChange={(_, v) => setMaxCellDiff(v as number)} />
            <Typography variant="body2" color="warning.main" sx={{ mt: 1 }}>
              Previews are small and cannot show a blink. Open a few groups and use Flicker compare before
              trusting this.
            </Typography>
            <Typography variant="subtitle2" sx={{ mt: 1, mb: 1 }}>
              Loosest {sample.length} matches (kept photo left, trashed photo right) — check none differ:
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
              {sample.map((t) => (
                <Box key={t.key} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 0.5 }}>
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    {mediaItems[t.keptKey] && <Thumb item={mediaItems[t.keptKey]} />}
                    {mediaItems[t.key] && <Thumb item={mediaItems[t.key]} />}
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Δ {t.score.hamming} bits · {t.score.colorMae.toFixed(1)} colour · {t.score.cellDiff.toFixed(0)} local
                  </Typography>
                </Box>
              ))}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!scan || plans.length === 0}
          onClick={() => { onApply(plans); onClose() }}>
          Select {plans.length.toLocaleString()} groups ({trashCount.toLocaleString()} photos)
        </Button>
      </DialogActions>
    </Dialog>
  )
}
