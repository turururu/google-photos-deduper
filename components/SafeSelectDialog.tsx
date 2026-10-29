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
import {
  passingGroupIds,
  scanIdenticalGroups,
  type IdenticalScan,
} from "../lib/identical-scan"
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
  /** Replaces the current selection with exactly these group ids. */
  onApply: (groupIds: string[]) => void
}

/**
 * Finds practically identical groups (metadata + pixel check) and lets the
 * user tune the strictness while looking at the loosest groups that would
 * pass. Selecting never trashes anything.
 */
export function SafeSelectDialog({ open, groups, mediaItems, onClose, onApply }: Props) {
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

  const passing = useMemo(
    () => (scan ? passingGroupIds(scan, { maxHamming, maxColorMae, maxCellDiff }) : []),
    [scan, maxHamming, maxColorMae, maxCellDiff]
  )

  // Show the loosest passing groups: if those look identical, stricter ones are too.
  const sample = useMemo(() => {
    if (!scan) return []
    const ok = new Set(passing)
    const byId = new Map(groups.map((g) => [g.id, g]))
    return scan.scores
      .filter((s) => ok.has(s.groupId))
      .sort((a, b) => b.maxCellDiff - a.maxCellDiff)
      .slice(0, SAMPLE_SIZE)
      .map((s) => ({ score: s, group: byId.get(s.groupId)! }))
  }, [scan, passing, groups])

  const [done, total] = progress
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Select practically identical groups</DialogTitle>
      <DialogContent>
        {error && <Typography color="error">{error}</Typography>}
        {!scan && !error && (
          <Box sx={{ py: 3 }}>
            <Typography variant="body2" gutterBottom>
              Comparing pixels of candidate groups… {done.toLocaleString()} / {total.toLocaleString()}
            </Typography>
            <LinearProgress variant={total ? "determinate" : "indeterminate"} value={total ? (done / total) * 100 : 0} />
          </Box>
        )}
        {scan && (
          <>
            <Typography variant="body2" sx={{ mb: 2 }}>
              {scan.candidateCount.toLocaleString()} of {groups.length.toLocaleString()} groups
              passed the metadata check (2–4 photos, taken within 2 s, same shape, no videos). <strong>{passing.length.toLocaleString()}</strong> also match pixel for pixel.
              Everything else stays for manual review.
            </Typography>
            {scan.rejected && Object.keys(scan.rejected).length > 0 && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 2 }}>
                Groups failing each metadata rule (a group can fail several):{" "}
                {Object.entries(scan.rejected)
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
              Loosest {sample.length} groups (by local difference) that would be selected — check none differ:
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
              {sample.map(({ group, score }) => (
                <Box key={group.id} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 0.5 }}>
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    {group.mediaKeys.map((k) => mediaItems[k] && <Thumb key={k} item={mediaItems[k]} />)}
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Δ {score.maxHamming} bits · {score.maxColorMae.toFixed(1)} colour · {score.maxCellDiff.toFixed(0)} local
                  </Typography>
                </Box>
              ))}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!scan || passing.length === 0}
          onClick={() => { onApply(passing); onClose() }}>
          Select only {passing.length.toLocaleString()} identical groups
        </Button>
      </DialogActions>
    </Dialog>
  )
}
