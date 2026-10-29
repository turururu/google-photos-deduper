import Alert from "@mui/material/Alert"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import ToggleButton from "@mui/material/ToggleButton"
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup"
import FormControlLabel from "@mui/material/FormControlLabel"
import MenuItem from "@mui/material/MenuItem"
import Select from "@mui/material/Select"
import Slider from "@mui/material/Slider"
import Switch from "@mui/material/Switch"
import TextField from "@mui/material/TextField"
import Typography from "@mui/material/Typography"
import { DEFAULT_VIEW_PREFS, type SortKey, type ViewPrefs } from "../lib/group-view"

const SORT_LABELS: Record<SortKey, string> = {
  "similarity-desc": "Most similar first",
  "similarity-asc": "Least similar first",
  "size-desc": "Largest groups first",
  "removable-desc": "Most to remove first",
  "taken-desc": "Newest photos first",
  "taken-asc": "Oldest photos first",
}

const STALE_DAYS = 7

export function describeScanAge(scanDate: number, now = Date.now()) {
  const days = Math.floor((now - scanDate) / 86_400_000)
  const when = new Date(scanDate).toLocaleString()
  return {
    days,
    stale: days >= STALE_DAYS,
    text: `Scanned ${when} · ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`,
  }
}

interface Props {
  prefs: ViewPrefs
  onChange: (next: ViewPrefs) => void
  shown: number
  total: number
  trashScopeCount: number
  scanDate?: number
  reviewedCount: number
  onSelectShown: () => void
  keepOrder: "oldest" | "newest"
  onKeepOrderChange: (o: "oldest" | "newest") => void
  onOpenTrash: () => void
}

export function ViewControls({ prefs, onChange, shown, total, trashScopeCount, scanDate, reviewedCount, onSelectShown, keepOrder, onKeepOrderChange, onOpenTrash }: Props) {
  const set = (p: Partial<ViewPrefs>) => onChange({ ...prefs, ...p })
  const age = scanDate ? describeScanAge(scanDate) : null
  const filtered = shown !== total
  return (
    <Box sx={{ py: 1.5 }}>
      {age && (
        <Typography variant="caption" color="text.secondary" data-testid="scan-age">
          {age.text}
        </Typography>
      )}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, my: 1 }}>
        <Typography variant="body2">When photos tie, keep the</Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={keepOrder}
          onChange={(_, v) => v && onKeepOrderChange(v)}>
          <ToggleButton value="oldest">Oldest upload</ToggleButton>
          <ToggleButton value="newest">Newest upload</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary">
          (after favorite, quality, resolution, file size)
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={onOpenTrash}>Restore from trash…</Button>
      </Box>
      {age?.stale && (
        <Alert severity="warning" sx={{ my: 1 }}>
          These results are {age.days} days old. Photos may have changed since — re-scan before trashing.
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary" display="block">
        Keys: J/K next/previous group · X select/unselect · R mark reviewed · V open viewer
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center", mt: 0.5 }}>
        <Select size="small" value={prefs.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
          {Object.entries(SORT_LABELS).map(([k, label]) => (
            <MenuItem key={k} value={k}>{label}</MenuItem>
          ))}
        </Select>
        <Box sx={{ width: 220 }}>
          <Typography variant="caption">
            Similarity {Math.round(prefs.minSimilarity * 100)}%–{Math.round(prefs.maxSimilarity * 100)}%
          </Typography>
          <Slider size="small" min={0.9} max={1} step={0.005}
            value={[Math.max(0.9, prefs.minSimilarity), prefs.maxSimilarity]}
            onChange={(_, v) => { const [lo, hi] = v as number[]; set({ minSimilarity: lo, maxSimilarity: hi }) }} />
        </Box>
        <FormControlLabel label="Only pairs" control={
          <Switch size="small" checked={prefs.onlyPairs} onChange={(e) => set({ onlyPairs: e.target.checked })} />} />
        <FormControlLabel label="No favorites" control={
          <Switch size="small" checked={prefs.noFavorites} onChange={(e) => set({ noFavorites: e.target.checked })} />} />
        <FormControlLabel label="Hide reviewed" control={
          <Switch size="small" checked={prefs.hideReviewed} onChange={(e) => set({ hideReviewed: e.target.checked })} />} />
        <TextField size="small" type="date" label="Taken from" InputLabelProps={{ shrink: true }}
          value={prefs.takenFrom} onChange={(e) => set({ takenFrom: e.target.value })} />
        <TextField size="small" type="date" label="Taken to" InputLabelProps={{ shrink: true }}
          value={prefs.takenTo} onChange={(e) => set({ takenTo: e.target.value })} />
        <Typography variant="body2" color="text.secondary" data-testid="reviewed-count">
          Reviewed {reviewedCount.toLocaleString()} / {total.toLocaleString()}
        </Typography>
        {filtered && (
          <>
            <Typography variant="body2" color="text.secondary">
              Showing {shown.toLocaleString()} of {total.toLocaleString()}
            </Typography>
            {trashScopeCount !== total && (
              <Typography variant="body2" color="warning.main">
                Trash only affects groups matching the filters ({trashScopeCount.toLocaleString()}).
              </Typography>
            )}
            <Button size="small" onClick={onSelectShown}>Select only shown</Button>
            <Button size="small" onClick={() => onChange({ ...DEFAULT_VIEW_PREFS, sort: prefs.sort })}>
              Clear filters
            </Button>
          </>
        )}
      </Box>
    </Box>
  )
}
