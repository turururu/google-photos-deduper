import Box from "@mui/material/Box"
import { buildThumbUrl } from "../lib/photo-url"
import type { GpdMediaItem } from "../lib/types"
import { useBlobUrl } from "./useBlobUrl"

export function Thumb({ item, size = 80 }: { item: GpdMediaItem; size?: number }) {
  const { blobUrl } = useBlobUrl(buildThumbUrl(item.thumb, { height: 200 }))
  return (
    <Box
      component="img"
      src={blobUrl}
      sx={{ height: size, width: size, objectFit: "cover", borderRadius: 0.5, bgcolor: "action.hover" }}
    />
  )
}
