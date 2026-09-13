export const MAX_QUEUED_BYTES = 4 * 1024 * 1024

// Bound a slow peer's memory use. Native multiplexing applies socket backpressure to the source.
export function boundedWrite(destination, data, source) {
  if (destination.destroyed || destination.closed) return false
  if ((destination.writableLength || 0) + data.length > MAX_QUEUED_BYTES) {
    destination.destroy()
    return false
  }
  const ok = destination.write(data)
  if (!ok && source?.pause && destination.once) {
    source.pause()
    const resume = () => {
      destination.removeListener('close', resume)
      destination.removeListener('drain', resume)
      if (!source.destroyed) source.resume()
    }
    destination.once('drain', resume)
    destination.once('close', resume)
  }
  return ok
}
