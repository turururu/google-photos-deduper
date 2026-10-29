import { useEffect, useMemo, useState } from "react"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Checkbox from "@mui/material/Checkbox"
import CircularProgress from "@mui/material/CircularProgress"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import Typography from "@mui/material/Typography"
import { buildThumbUrl } from "../lib/photo-url"

export interface TrashItem {
  mediaKey: string
  dedupKey: string
  thumb: string
  timestamp?: number
  creationTimestamp?: number
  resWidth?: number
  resHeight?: number
}

interface Props {
  open: boolean
  items: TrashItem[]
  loading: boolean
  error: string | null
  hasMore: boolean
  restoring: boolean
  restoreMessage: string | null
  onLoadMore: () => void
  onRestore: (dedupKeys: string[]) => void
  onClose: () => void
}

export function TrashRestoreDialog({
  open, items, loading, error, hasMore, restoring, restoreMessage, onLoadMore, onRestore, onClose
}: Props) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!open) setPicked(new Set())
  }, [open])
  // Items disappear from the list once restored; drop their picks.
  const known = useMemo(() => new Set(items.map((i) => i.mediaKey)), [items])
  const selected = [...picked].filter((k) => known.has(k))
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Restore from Google Photos trash</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Your Google Photos trash, newest first. This includes anything trashed outside this tool.
          Restored photos return to your library; re-scan to see them in groups again.
        </Typography>
        {error && <Typography color="error">{error}</Typography>}
        {restoreMessage && <Typography color="success.main">{restoreMessage}</Typography>}
        <Box sx={{ display: "flex", gap: 1, my: 1 }}>
          <Button size="small" disabled={restoring} onClick={() => setPicked(new Set(items.map((i) => i.mediaKey)))}>
            Select all loaded ({items.length})
          </Button>
          <Button size="small" disabled={restoring} onClick={() => setPicked(new Set())}>
            Select none
          </Button>
        </Box>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 1 }}>
          {items.map((i) => (
            <Box
              key={i.mediaKey}
              onClick={() => !restoring && toggle(i.mediaKey)}
              sx={{ position: "relative", cursor: "pointer", outline: picked.has(i.mediaKey) ? "3px solid #1976d2" : "none" }}>
              <img
                src={buildThumbUrl(i.thumb, { height: 160 })}
                loading="lazy"
                style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }}
              />
              <Checkbox
                size="small"
                checked={picked.has(i.mediaKey)}
                sx={{ position: "absolute", top: 0, left: 0, bgcolor: "rgba(255,255,255,0.7)", p: 0.25 }}
              />
              <Typography variant="caption" display="block">
                {i.timestamp ? new Date(i.timestamp).toLocaleDateString() : ""}
              </Typography>
            </Box>
          ))}
        </Box>
        {loading && <CircularProgress size={24} sx={{ mt: 2 }} />}
        {!loading && hasMore && (
          <Button sx={{ mt: 2 }} onClick={onLoadMore}>Load more</Button>
        )}
        {!loading && !error && items.length === 0 && <Typography>Trash is empty.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          disabled={restoring || selected.length === 0}
          onClick={() => onRestore(items.filter((i) => picked.has(i.mediaKey)).map((i) => i.dedupKey))}>
          {restoring ? "Restoring…" : `Restore ${selected.length} selected`}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
