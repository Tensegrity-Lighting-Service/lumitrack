// Audio waveform + local playback (CONCEPTION.md §12.11 wavesurfer.js).
// PSN carries no audio: monitoring happens here in the browser, following
// the sidecar's transport state rather than driving it — play/pause mirror
// `playing`, and position is only force-corrected past a drift threshold so
// normal wavesurfer playback isn't fighting a 30 Hz setTime every tick.
import { useEffect, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { fileSrc } from '../fileSrc'
import { sidecar } from '../sidecar'

const DRIFT_THRESHOLD_S = 0.2

export function Waveform({ audioPath, tMs, playing }: {
  audioPath: string
  tMs: number
  playing: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 48,
      waveColor: '#4f6df5',
      progressColor: '#8a92a6',
      cursorColor: '#e8e8ec',
      cursorWidth: 1,
      url: fileSrc(audioPath),
      interact: true,
    })
    wsRef.current = ws
    ws.on('interaction', () => {
      sidecar.seek(ws.getCurrentTime() * 1000)
    })
    return () => {
      ws.destroy()
      wsRef.current = null
    }
  }, [audioPath])

  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    if (playing && !ws.isPlaying()) ws.play()
    if (!playing && ws.isPlaying()) ws.pause()
  }, [playing])

  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    const targetS = tMs / 1000
    if (Math.abs(ws.getCurrentTime() - targetS) > DRIFT_THRESHOLD_S) {
      ws.setTime(targetS)
    }
  }, [tMs])

  return <div className="waveform" ref={containerRef} />
}
