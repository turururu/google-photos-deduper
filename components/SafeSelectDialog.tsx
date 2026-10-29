import { useEffect, useMemo, useRef, useState } from "react"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import LinearProgress from "@mui/material/LinearProgress"
import Checkbox from "@mui/material/Checkbox"
import FormControlLabel from "@mui/material/FormControlLabel"
import Slider from "@mui/material/Slider"
import Typography from "@mui/material/Typography"
import { buildThumbUrl } from "../lib/photo-url"
import { scanIdenticalGroups, type IdenticalScan } from "../lib/identical-scan"
import { summarizeTrash } from "../lib/trash-summary"
import { planAll, filterPlans, type GroupPlan } from "../lib/identical-plan"
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
  /** Every group (not just the shown ones), to tell real similarity from the pre-fix fake value. */
  allGroups: DuplicateGroup[]
  mediaItems: Record<string, GpdMediaItem>
  onClose: () => void
  keepOrder: KeepOrder
  keptOverrides: Record<string, Set<string>>
  /** Adds these groups to the selection and fixes each one's kept set. */
  onApply: (plans: GroupPlan[]) => void
}

/**
 * Finds practically identical groups (metadata + pixel check) and lets the
 * user tune the strictness while looking at the loosest groups that would
 * pass. Selecting never trashes anything.
 */
export function SafeSelectDialog({ open, groups, mediaItems, keepOrder, keptOverrides, allGroups, onClose, onApply }: Props) {
  const [progress, setProgress] = useState<[number, number]>([0, 0])
  const [scan, setScan] = useState<IdenticalScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [maxHamming, setMaxHamming] = useState(DEFAULT_PIXEL_THRESHOLDS.maxHamming)
  const [maxColorMae, setMaxColorMae] = useState(DEFAULT_PIXEL_THRESHOLDS.maxColorMae)
  const [maxCellDiff, setMaxCellDiff] = useState(DEFAULT_PIXEL_THRESHOLDS.maxCellDiff)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  const [includeMixed, setIncludeMixed] = useState(false)
  const [minSimilarity, setMinSimilarity] = useState(0.99)
  // Scans from before real similarity was stored give every group the same value.
  const similarityIsReal = useMemo(
    () => new Set(allGroups.map((g) => g.similarity.toFixed(4))).size > 1,
    [allGroups]
  )
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

  const allPlans = useMemo(
    () =>
      scan
        ? planAll(groups, mediaItems, scan, { maxHamming, maxColorMae, maxCellDiff }, { keepOrder, keptOverrides })
        : [],
    // overrides are read once per scan/threshold change; fine while the dialog is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scan, maxHamming, maxColorMae, maxCellDiff, keepOrder]
  )
  const plans = useMemo(
    () => filterPlans(allPlans, groups, { includeMixed, minSimilarity: similarityIsReal ? minSimilarity : null }),
    [allPlans, groups, includeMixed, minSimilarity, similarityIsReal]
  )
  const fullyCount = plans.filter((p) => p.fully).length
  const mixedCount = plans.length - fullyCount
  const hiddenCount = allPlans.length - plans.length
  const freed = useMemo(
    () => summarizeTrash(plans.flatMap((p) => p.trash.map((t) => mediaItems[t.key]).filter(Boolean))),
    [plans, mediaItems]
  )
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
            <Typography variant="body2" sx={{ mb: 1 }}>
              Selects groups where every extra photo is practically identical to the photo that stays
              (taken within 2 s, same shape, no videos; favorites never trashed).{" "}
              <strong>{fullyCount.toLocaleString()}</strong> groups
              {includeMixed && <>, plus <strong>{mixedCount.toLocaleString()}</strong> mixed groups (only the identical copies are selected)</>}
              {" "}— <strong>{trashCount.toLocaleString()}</strong> photos would go to trash, freeing about{" "}
              {(freed.bytes / 1e9).toFixed(2)} GB ({freed.known.toLocaleString()} of {freed.items.toLocaleString()} with
              known size; photos that don't count toward quota free nothing).
              {hiddenCount > 0 && <> {hiddenCount.toLocaleString()} more groups are hidden by the options below.</>}
            </Typography>
            <FormControlLabel
              control={<Checkbox size="small" checked={includeMixed} onChange={(e) => setIncludeMixed(e.target.checked)} />}
              label="Also pick identical copies inside mixed groups (the different photos stay)"
            />
            {similarityIsReal ? (
              <>
                <Typography variant="caption" component="div">Minimum group similarity: {Math.round(minSimilarity * 1000) / 10}%</Typography>
                <Slider size="small" min={0.9} max={1} step={0.005} value={minSimilarity}
                  onChange={(_, v) => setMinSimilarity(v as number)} />
              </>
            ) : (
              <Typography variant="caption" color="warning.main" component="div">
                These groups have no real similarity value (older scan): rescan to enable the similarity floor.
              </Typography>
            )}
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
        <Button size="small" disabled={!scan}
          onClick={() => {
            const sim = new Map(groups.map((g) => [g.id, g.similarity]))
            const desc = (k: string) => ({ key: k, taken: mediaItems[k]?.timestamp, file: mediaItems[k]?.fileName })
            // lowest-similarity groups first: those are the ones worth checking
            const data = [...allPlans]
              .sort((x, y) => (sim.get(x.groupId) ?? 1) - (sim.get(y.groupId) ?? 1))
              .slice(0, 30)
              .map((p) => ({
                groupId: p.groupId,
                similarity: sim.get(p.groupId),
                fully: p.fully,
                kept: p.kept.map(desc),
                trash: p.trash.map((t) => ({ ...desc(t.key), keptKey: t.keptKey, score: t.score })),
              }))
            navigator.clipboard.writeText(JSON.stringify(data, null, 1)).then(
              () => setCopyMsg("Copied"),
              (e) => setCopyMsg(`Copy failed: ${e}`)
            )
          }}>
          {copyMsg ?? "Copy debug data"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!scan || plans.length === 0}
          onClick={() => { onApply(plans); onClose() }}>
          Select {plans.length.toLocaleString()} groups ({trashCount.toLocaleString()} photos)
        </Button>
      </DialogActions>
    </Dialog>
  )
}
