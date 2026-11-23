import { useEffect, useRef, useState } from 'react'

const AMAP_KEY = (import.meta.env.VITE_AMAP_KEY ?? '').trim()
const AMAP_SECURITY = (import.meta.env.VITE_AMAP_SECURITY_CODE ?? '').trim()

export const amapConfigured = Boolean(AMAP_KEY && AMAP_SECURITY)

declare global {
  interface Window {
    AMap?: any
    _AMapSecurityConfig?: { securityJsCode: string }
  }
}

let loader: Promise<any> | null = null

function loadAmap(): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap)
  if (loader) return loader
  loader = new Promise((resolve, reject) => {
    window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY }
    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(AMAP_KEY)}&plugin=AMap.Geocoder`
    script.async = true
    script.onload = () => {
      if (window.AMap) resolve(window.AMap)
      else reject(new Error('AMap 未挂载'))
    }
    script.onerror = () => reject(new Error('AMap 加载失败'))
    document.head.appendChild(script)
  }).catch((e) => {
    loader = null
    throw e
  })
  return loader
}

type Props = {
  origin: string
  destination: string
  onError?: () => void
}

export default function AmapRoute({ origin, destination, onError }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const onErrorRef = useRef(onError)
  const [loading, setLoading] = useState(true)
  onErrorRef.current = onError

  useEffect(() => {
    const el = ref.current
    if (!el || !amapConfigured) return
    let disposed = false
    let map: any = null
    let viewTimer: number | undefined

    const geocode = (AMap: any, name: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const geocoder = new AMap.Geocoder({ city: '全国' })
        geocoder.getLocation(name, (status: string, result: any) => {
          const item = result?.geocodes?.[0]
          if (status === 'complete' && item?.location) resolve(item.location)
          else reject(new Error(`无法定位：${name}`))
        })
      })

    const arc = (a: any, b: any) => {
      const ax = a.getLng()
      const ay = a.getLat()
      const bx = b.getLng()
      const by = b.getLat()
      const mx = (ax + bx) / 2
      const my = (ay + by) / 2
      // 用垂直方向的偏移把直线弯成一条轻弧线，保留“航线”的视觉语义。
      const cx = mx - (by - ay) * 0.16
      const cy = my + (bx - ax) * 0.16
      const points: any[] = []
      for (let i = 0; i <= 40; i += 1) {
        const t = i / 40
        const u = 1 - t
        points.push(new window.AMap.LngLat(
          u * u * ax + 2 * u * t * cx + t * t * bx,
          u * u * ay + 2 * u * t * cy + t * t * by,
        ))
      }
      return points
    }

    const timer = window.setTimeout(() => {
      if (!disposed && loading) onErrorRef.current?.()
    }, 20000)

    loadAmap()
      .then(async (AMap) => {
        if (disposed || !ref.current) return
        map = new AMap.Map(ref.current, {
          zoom: 4,
          mapStyle: 'amap://styles/darkblue',
          viewMode: '2D',
          showLabel: true,
        })
        const [start, end] = await Promise.all([geocode(AMap, origin), geocode(AMap, destination)])
        if (disposed) return
        const path = arc(start, end)
        const glow = new AMap.Polyline({
          path,
          strokeColor: 'rgba(139,156,255,.18)',
          strokeWeight: 9,
          lineJoin: 'round',
          lineCap: 'round',
        })
        const line = new AMap.Polyline({
          path,
          strokeColor: '#8B9CFF',
          strokeWeight: 2,
          strokeOpacity: 0.9,
          lineJoin: 'round',
          lineCap: 'round',
          showDir: true,
        })
        const marker = (position: any, label: string, side: 'start' | 'end') =>
          new AMap.Marker({
            position,
            content: `<div class="v1-amap-pin ${side}"><i></i><span>${label.replace(/[<>&]/g, '')}</span></div>`,
            offset: new AMap.Pixel(side === 'start' ? -7 : -7, -7),
            zIndex: 10,
          })
        const startMarker = marker(start, origin, 'start')
        const endMarker = marker(end, destination, 'end')
        map.add([glow, line, startMarker, endMarker])
        const span = Math.max(Math.abs(start.getLng() - end.getLng()), Math.abs(start.getLat() - end.getLat()))
        const zoom = span > 30 ? 3 : span > 15 ? 4 : span > 8 ? 5 : span > 4 ? 6 : span > 2 ? 7 : 8
        const center = new AMap.LngLat(
          (start.getLng() + end.getLng()) / 2,
          (start.getLat() + end.getLat()) / 2,
        )
        const applyView = () => {
          if (!disposed) map?.setZoomAndCenter(zoom, center)
        }
        // 高德在容器/底图完成前会忽略视角设置；完成后再补一次。
        map.on('complete', applyView)
        applyView()
        viewTimer = window.setTimeout(applyView, 500)
        setLoading(false)
        window.clearTimeout(timer)
      })
      .catch(() => {
        if (!disposed) onErrorRef.current?.()
      })

    return () => {
      disposed = true
      window.clearTimeout(timer)
      if (viewTimer) window.clearTimeout(viewTimer)
      map?.destroy()
    }
  }, [origin, destination])

  return (
    <div className="v1-amap-wrap">
      <div ref={ref} className="v1-amap" />
      {loading && <div className="v1-amap-loading">地图加载中…</div>}
    </div>
  )
}
