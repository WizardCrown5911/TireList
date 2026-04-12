import { useEffect, useMemo, useRef, useState } from 'react'

type AdSlotProps = {
  className?: string
  format?: 'auto' | 'fluid' | 'rectangle'
  label?: string
  minHeight?: number
  slot: string
}

declare global {
  interface Window {
    adsbygoogle?: unknown[]
  }
}

const ADSENSE_CLIENT = (import.meta.env.VITE_ADSENSE_CLIENT || '').trim()
const ADSENSE_SCRIPT_ID = 'forge-tierlist-adsense-script'

export function AdSlot({ className = '', format = 'auto', label = 'Ad', minHeight = 0, slot }: AdSlotProps) {
  const adRef = useRef<HTMLModElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const combinedClassName = `ad-shell ${className}`.trim()
  const normalizedSlot = slot.trim()

  const adStyle = useMemo(() => {
    if (format === 'rectangle') {
      return { display: 'block', minHeight: `${Math.max(minHeight, 250)}px` }
    }

    return { display: 'block', minHeight: `${Math.max(minHeight, 90)}px` }
  }, [format, minHeight])

  useEffect(() => {
    let cancelled = false

    if (!ADSENSE_CLIENT || !normalizedSlot) {
      return () => {}
    }

    ensureAdSenseScript()
      .then(() => {
        if (!cancelled) {
          setReady(true)
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'AdSense could not load.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [normalizedSlot])

  useEffect(() => {
    if (!ready || !adRef.current || !ADSENSE_CLIENT || !normalizedSlot) {
      return
    }

    if (adRef.current.dataset.adsbygoogleStatus) {
      return
    }

    try {
      ;(window.adsbygoogle = window.adsbygoogle || []).push({})
    } catch (pushError) {
      console.warn('AdSense could not render this placement.', pushError)
    }
  }, [normalizedSlot, ready])

  if (!ADSENSE_CLIENT || !normalizedSlot) {
    return null
  }

  return (
    <aside className={combinedClassName}>
      <span className="ad-shell-label">{label}</span>
      <ins
        ref={adRef}
        className="adsbygoogle ad-slot"
        style={adStyle}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-format={format === 'rectangle' ? undefined : format}
        data-ad-layout={format === 'fluid' ? 'in-article' : undefined}
        data-ad-slot={normalizedSlot}
        data-full-width-responsive={format === 'auto' ? 'true' : undefined}
      />
      {error ? <small className="ad-shell-error">{error}</small> : null}
    </aside>
  )
}

function ensureAdSenseScript() {
  const existingScript = document.getElementById(ADSENSE_SCRIPT_ID) as HTMLScriptElement | null

  if (existingScript) {
    if (existingScript.dataset.loaded === 'true') {
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      existingScript.addEventListener('load', () => resolve(), { once: true })
      existingScript.addEventListener('error', () => reject(new Error('AdSense script failed to load.')), { once: true })
    })
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.id = ADSENSE_SCRIPT_ID
    script.async = true
    script.crossOrigin = 'anonymous'
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      resolve()
    }, { once: true })
    script.addEventListener('error', () => reject(new Error('AdSense script failed to load.')), { once: true })
    document.head.appendChild(script)
  })
}
