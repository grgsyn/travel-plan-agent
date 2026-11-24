import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import SettingsPanel from './Settings'
import AmapRoute, { amapConfigured } from './AmapRoute'

/** ---------------- 类型 ---------------- */

type RunEvent = {
  schema_version: number
  run_id: string
  plan_version: number
  event_id: string
  seq: number
  occurred_at: string
  event_type: string
  stage: string
  actor: string
  parent_id: string | null
  payload: Record<string, any>
}

type Item = {
  slot: string
  start_time: string
  end_time: string
  type: string
  title: string
  cost: number
  duration_min: number
  note: string
}

type Day = { date: string; items: Item[]; day_cost: number; notes: string[] }

type Issue = { severity: 'blocker' | 'warning'; code: string; message: string }

type CostItem = { key: string; label: string; amount: number; share: number }

type Summary = {
  cost: { total: number; budget: number; items: CostItem[] }
  source: { kind: string; label: string; fetched_at: string; note: string }
  warning_groups: { category: string; label: string; items: string[] }[]
}

type IssueLedgerItem = {
  code: string
  severity?: string
  owner?: string
  status?: string
  acceptance?: string
  first_seen_version?: number
  fixed_in_version?: number | null
}

type TeamTask = { owner?: string; status?: string; rework?: string[]; changes?: DeliveryChange[] }

type DeliveryChange = {
  base_version?: number
  plan_version?: number
  fields?: { kind: string; date?: string; before?: unknown; after?: unknown }[]
  rationale?: string
}

type LlmStats = {
  calls?: number
  max_calls?: number | null
  input_chars?: number
  output_chars?: number
  latency_ms?: number
  usage_available?: boolean
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

type Result = {
  plan_id: string
  brief: {
    destination: string
    origin: string
    budget_total: number
    start_date: string
    end_date: string
    travelers: number
  }
  itinerary: { days: Day[]; total_cost: number; budget_total: number; warnings: string[] }
  critique: { passed: boolean; issues: Issue[]; suggestions: string[] }
  revision: number
  errors: string[]
  version?: number
  summary?: Summary
  document?: { title: string; overview: string; days: { date: string; summary: string }[]; practical_notes?: string[] } | null
  team_tasks?: Record<string, TeamTask>
  issue_ledger?: IssueLedgerItem[]
  approved_version?: number | null
  team_state?: 'approved' | 'detached' | null
  llm_stats?: LlmStats
  share?: string
}

type InterruptInfo = {
  type: string
  message?: string
  question?: string
  from?: string
  total?: number
  budget?: number
  over?: number
  ratio?: number
  options: { value: string; label: string }[]
  plan_id: string
  suggested_max_calls?: number
}

type VersionInfo = {
  version: number
  created_at: string
  source: string
  note: string
  total_cost: number
  day_count: number
  passed: boolean
  blockers: number
}

type Phase = 'form' | 'running' | 'interrupt' | 'done' | 'error' | 'stopped'
type Screen = 'home' | 'demand' | 'followup' | 'running' | 'plan' | 'share'

type FollowUpOption = { label: string; value: string; note?: string }
type FollowUpQuestion = {
  kind: 'infer' | 'ask'
  title: string
  why: string
  confidence: '高' | '中' | '低'
  options: FollowUpOption[]
  allow_custom: boolean
}
type FollowAnswer = { title: string; label: string }
type QuestionError = { message: string; retryable: boolean; code?: string }
type FollowupDraft = {
  v: 1
  form: Form
  briefText: string
  followups: FollowUpQuestion[]
  answers: Record<number, FollowAnswer>
  drafts: Record<number, string>
  index: number
}

type Form = {
  origin: string
  destination: string
  start_date: string
  end_date: string
  travelers: number
  budget_total: number
  elder: boolean
  child: boolean
  preferences: string[]
  pace: '轻松' | '适中' | '紧凑'
}

/** ---------------- 基础设施 ---------------- */

const TOKEN_KEY = 'trip.accessToken'
const FOLLOWUP_DRAFT_KEY = 'trip.followupDraft.v1'
let onAuthRequired: (() => void) | null = null

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY) ?? ''
  const headers = new Headers(init?.headers ?? {})
  if (token) headers.set('X-Access-Token', token)
  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) onAuthRequired?.()
  return res
}

function describeError(e: unknown): string {
  if (e instanceof TypeError) return '连不上后端服务。请确认服务已启动，然后重试。'
  const text = String(e)
  const http = text.match(/^HTTP (\d{3})$/)
  if (http) return `后端返回 ${http[1]}，请稍后重试；若持续出现，检查设置里的模型配置。`
  return text
}

async function consume(res: Response, onEvent: (name: string, data: any) => void) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let name = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (data) onEvent(name, JSON.parse(data))
    }
  }
}

function hhmm(t: string) {
  const m = t.match(/(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : t.slice(0, 5)
}

function minutesOf(t: string) {
  const m = t.match(/(\d{2}):(\d{2})/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}

function weekday(d: string) {
  return '日一二三四五六'[new Date(d + 'T00:00:00').getDay()]
}

function money(n: number) {
  return `¥${Math.round(n).toLocaleString('zh-CN')}`
}

function dayCount(form: Form) {
  const a = new Date(form.start_date + 'T00:00:00').getTime()
  const b = new Date(form.end_date + 'T00:00:00').getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1
  return Math.round((b - a) / 86400000) + 1
}

const TEAM_ROLES = ['orchestrator', 'logistics', 'local_expert', 'critic_agent', 'writer']

const ACTOR_LABEL: Record<string, string> = {
  orchestrator: '主控',
  logistics: '交通住宿',
  local_expert: '本地体验',
  critic_agent: '独立评审',
  writer: '文案',
  user: '你',
  system: '系统',
}

const ROLE_INITIAL: Record<string, string> = {
  orchestrator: '主',
  logistics: '交',
  local_expert: '本',
  critic_agent: '审',
  writer: '文',
}

const ROLE_COLOR: Record<string, string> = {
  orchestrator: '#8b9cff',
  logistics: '#f0b872',
  local_expert: '#6fe3c0',
  critic_agent: '#c0a8ff',
  writer: '#9ec5fe',
}

const TYPE_LABEL: Record<string, string> = {
  transport: '交通',
  transfer: '接驳',
  sight: '景点',
  meal: '餐食',
  hotel: '住宿',
  rest: '休息',
  free: '自由时间',
}

const ENTRY_ROLES = [
  { initial: '主', color: '#8b9cff', job: '拆解任务' },
  { initial: '交', color: '#f0b872', job: '选航班与酒店' },
  { initial: '本', color: '#6fe3c0', job: '排逐日行程' },
  { initial: '审', color: '#c0a8ff', job: '复核硬约束' },
  { initial: '文', color: '#9ec5fe', job: '整合成稿' },
]

const PREFERENCES = ['美食', '人文', '自然', '购物', '慢节奏', '夜景']
const PACE = ['轻松', '适中', '紧凑'] as const

const DEFAULT_FORM: Form = {
  origin: '上海',
  destination: '成都',
  start_date: '2026-11-20',
  end_date: '2026-11-24',
  travelers: 2,
  budget_total: 8000,
  elder: true,
  child: false,
  preferences: ['美食', '人文'],
  pace: '适中',
}

/** ---------------- 小组件 ---------------- */

function Station({ role, state }: { role: string; state: 'idle' | 'running' | 'done' }) {
  return (
    <div className={`v1-station ${state}`}>
      <span className="v1-station-idx">{String(TEAM_ROLES.indexOf(role) + 1).padStart(2, '0')}</span>
      <span className="v1-station-dot" style={{ background: ROLE_COLOR[role] }}>
        {ROLE_INITIAL[role]}
      </span>
      <span className="v1-station-role">{ACTOR_LABEL[role] ?? role}</span>
      <span className="v1-station-state">
        {state === 'done' ? '已交付' : state === 'running' ? '进行中' : '待命'}
      </span>
    </div>
  )
}

function Bar({ value, tone = 'indigo' }: { value: number; tone?: 'indigo' | 'mint' | 'amber' | 'rose' }) {
  return (
    <div className="v1-bar">
      <i className={`v1-bar-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

/** ---------------- 主应用 ---------------- */


function ParticleField() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const pointer = { x: -9999, y: -9999 }
    let w = 0
    let h = 0
    let parts: { x: number; y: number; vx: number; vy: number; r: number; a: number }[] = []
    let raf = 0
    let running = true

    const build = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.min(110, Math.round((w * h) / 16000))
      parts = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: Math.random() * 1.1 + 0.4,
        a: Math.random() * 0.35 + 0.18,
      }))
      if (reduce) drawOnce()
    }

    const drawOnce = () => {
      ctx.clearRect(0, 0, w, h)
      for (const part of parts) {
        ctx.beginPath()
        ctx.arc(part.x, part.y, part.r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(196,208,238,' + part.a + ')'
        ctx.fill()
      }
    }

    const frame = () => {
      if (!running) return
      ctx.clearRect(0, 0, w, h)
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        part.x += part.vx
        part.y += part.vy
        if (part.x < -12) part.x = w + 12
        if (part.x > w + 12) part.x = -12
        if (part.y < -12) part.y = h + 12
        if (part.y > h + 12) part.y = -12

        const dx = part.x - pointer.x
        const dy = part.y - pointer.y
        const d2 = dx * dx + dy * dy
        if (d2 < 16000 && d2 > 1) {
          const d = Math.sqrt(d2)
          const f = (1 - d2 / 16000) * 0.9
          part.x += (dx / d) * f
          part.y += (dy / d) * f
        }

        for (let j = i + 1; j < parts.length; j++) {
          const other = parts[j]
          const ax = part.x - other.x
          const ay = part.y - other.y
          const dist2 = ax * ax + ay * ay
          if (dist2 < 11000) {
            const alpha = (1 - dist2 / 11000) * 0.12
            ctx.strokeStyle = 'rgba(139,156,255,' + alpha + ')'
            ctx.lineWidth = 0.6
            ctx.beginPath()
            ctx.moveTo(part.x, part.y)
            ctx.lineTo(other.x, other.y)
            ctx.stroke()
          }
        }

        ctx.beginPath()
        ctx.arc(part.x, part.y, part.r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(196,208,238,' + part.a + ')'
        ctx.fill()
      }
      raf = requestAnimationFrame(frame)
    }

    const onResize = () => build()
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
    }
    const onLeave = () => {
      pointer.x = -9999
      pointer.y = -9999
    }
    const onVisibility = () => {
      running = !document.hidden
      if (running && !reduce) {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(frame)
      }
    }

    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('mouseleave', onLeave)
    document.addEventListener('visibilitychange', onVisibility)
    build()
    if (!reduce) raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return <canvas ref={ref} className="v1-particles" aria-hidden="true" />
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [bound, setBound] = useState(false)
  const [phase, setPhase] = useState<Phase>('form')
  const [form, setForm] = useState<Form>(DEFAULT_FORM)
  const [briefText, setBriefText] = useState('')
  const [followups, setFollowups] = useState<FollowUpQuestion[]>([])
  const [followIndex, setFollowIndex] = useState(0)
  const [followAnswers, setFollowAnswers] = useState<Record<number, FollowAnswer>>({})
  const [followDrafts, setFollowDrafts] = useState<Record<number, string>>({})
  const [preparing, setPreparing] = useState(false)
  const [mapFailed, setMapFailed] = useState(false)
  const [questionError, setQuestionError] = useState<QuestionError | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [interruptInfo, setInterruptInfo] = useState<InterruptInfo | null>(null)
  const [error, setError] = useState('')
  const [errorStats, setErrorStats] = useState<LlmStats | undefined>()
  const [recoveryStatus, setRecoveryStatus] = useState<string | undefined>()
  const [refining, setRefining] = useState<string | null>(null)
  const [refineTarget, setRefineTarget] = useState('')
  const [refineText, setRefineText] = useState('')
  const [refineNote, setRefineNote] = useState('')
  const refineInputRef = useRef<HTMLInputElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([])
  const [versions, setVersions] = useState<VersionInfo[]>([])
  const [needToken, setNeedToken] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const [activePlanId, setActivePlanId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [tab, setTab] = useState<'tt' | 'budget' | 'change'>('tt')
  const [dayFilter, setDayFilter] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ date: string; index: number } | null>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (new URLSearchParams(location.search).get('plan')) return
    const raw = sessionStorage.getItem(FOLLOWUP_DRAFT_KEY)
    if (!raw) return
    try {
      const draft = JSON.parse(raw) as FollowupDraft
      if (
        draft?.v !== 1 ||
        !draft.form ||
        typeof draft.form.destination !== 'string' ||
        !Array.isArray(draft.followups) ||
        draft.followups.length === 0
      ) {
        throw new Error('invalid draft')
      }
      setForm(draft.form)
      setBriefText(draft.briefText ?? '')
      setFollowups(draft.followups)
      setFollowAnswers(draft.answers ?? {})
      setFollowDrafts(draft.drafts ?? {})
      setFollowIndex(Math.min(Math.max(0, draft.index ?? 0), draft.followups.length))
      setScreen('followup')
    } catch {
      sessionStorage.removeItem(FOLLOWUP_DRAFT_KEY)
    }
  }, [])

  useEffect(() => {
    if (screen !== 'followup' || followups.length === 0) return
    const draft: FollowupDraft = {
      v: 1,
      form,
      briefText,
      followups,
      answers: followAnswers,
      drafts: followDrafts,
      index: followIndex,
    }
    sessionStorage.setItem(FOLLOWUP_DRAFT_KEY, JSON.stringify(draft))
  }, [screen, form, briefText, followups, followAnswers, followDrafts, followIndex])

  useEffect(() => {
    setMapFailed(false)
  }, [form.origin, form.destination])

  useEffect(() => {
    onAuthRequired = () => setNeedToken(true)
    return () => {
      onAuthRequired = null
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const id = params.get('plan')
    if (!id) return
    const share = params.get('share')
    const url = share ? `/api/plan/${id}?share=${encodeURIComponent(share)}` : `/api/plan/${id}`
    apiFetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .catch(() => {
        if (share) return Promise.reject(new Error('not found'))
        return apiFetch(`/api/run/${id}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      })
      .then((rec) => {
        if (['interrupted', 'failed', 'failed_non_resumable', 'checkpoint_lost', 'needs_input', 'cancelled'].includes(rec?.status)) {
          const payload = rec.payload ?? {}
          setErrorStats(payload.llm_stats as LlmStats | undefined)
          setRecoveryStatus(payload.recovery_status)
          if (rec.status === 'interrupted') {
            setInterruptInfo({ ...(payload.interrupt ?? {}), plan_id: rec.run_id } as InterruptInfo)
            setPhase('interrupt')
          } else {
            setError(
              [
                String(payload.message ?? '规划失败'),
                ...(Array.isArray(payload.blockers) ? payload.blockers : []),
                ...(Array.isArray(payload.reasons) ? payload.reasons : []),
              ]
                .filter(Boolean)
                .join('\n'),
            )
            setPhase(['needs_input', 'cancelled'].includes(rec.status) ? 'stopped' : 'error')
          }
          setScreen('running')
          return
        }
        setResult({
          plan_id: rec.id,
          brief: rec.brief,
          itinerary: rec.itinerary,
          critique: rec.critique,
          revision: rec.revision ?? 0,
          errors: [],
          version: rec.version,
          share: share ?? undefined,
          document: rec.document,
          team_tasks: rec.team_tasks,
          issue_ledger: rec.issue_ledger,
          approved_version: rec.approved_version,
          team_state: rec.team_state,
          llm_stats: rec.llm_stats,
          summary: rec.summary,
        })
        if (Array.isArray(rec.events)) setLiveEvents(rec.events)
        setPhase('done')
        setScreen('plan')
        void loadVersions(rec.id)
      })
      .catch(() => {
        setError('该规划不存在或已失效')
        setPhase('error')
        setScreen('running')
      })
  }, [])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [screen])

  useEffect(() => {
    if (phase === 'done' && result) setScreen('plan')
    if (phase === 'interrupt') setScreen('running')
    if (phase === 'error' || phase === 'stopped') setScreen('running')
  }, [phase, result])

  useEffect(() => {
    if (!drawerOpen) return
    drawerRef.current?.scrollTo({ top: drawerRef.current.scrollHeight })
  }, [liveEvents, drawerOpen])

  function appendEvent(ev: RunEvent) {
    setLiveEvents((prev) => (prev.some((e) => e.event_id === ev.event_id) ? prev : [...prev, ev]))
  }

  function handleEvent(name: string, data: any) {
    if (name === 'run_event') {
      const ev = data as RunEvent
      appendEvent(ev)
      if (ev.event_type === 'run_started' || ev.event_type === 'run_resumed') {
        const pid = ev.payload?.plan_id ?? ev.run_id
        if (pid) setActivePlanId(String(pid))
      }
      if (ev.event_type === 'run_completed') {
        const payload = ev.payload?.result as Result | undefined
        if (payload) {
          setResult(payload)
          setPhase('done')
          setInterruptInfo(null)
          void loadVersions(payload.plan_id)
          const url = new URL(location.href)
          url.searchParams.set('plan', payload.plan_id)
          history.replaceState(null, '', url)
        }
      } else if (ev.event_type === 'run_interrupted') {
        setInterruptInfo((ev.payload?.interrupt ?? null) as InterruptInfo | null)
        setRecoveryStatus('resumable')
        setPhase('interrupt')
      } else if (ev.event_type === 'run_needs_input') {
        setRecoveryStatus('stopped')
        setError(
          [String(ev.payload?.message ?? '本次运行未完成'), ...(Array.isArray(ev.payload?.issues) ? ev.payload.issues.map((i: any) => i?.message ?? '') : [])]
            .filter(Boolean)
            .join('\n'),
        )
        setPhase('stopped')
      } else if (ev.event_type === 'run_failed') {
        setRecoveryStatus(ev.payload?.recovery_status)
        setError(
          [String(ev.payload?.message ?? '规划失败'), ...(Array.isArray(ev.payload?.blockers) ? ev.payload.blockers : [])]
            .filter(Boolean)
            .join('\n'),
        )
        setPhase('error')
      }
      if (['run_completed', 'run_interrupted', 'run_needs_input', 'run_failed'].includes(ev.event_type)) {
        setActivePlanId(null)
        setCancelling(false)
      }
      return
    }
    if (name === 'done') {
      setResult(data)
      setPhase('done')
      setInterruptInfo(null)
      const url = new URL(location.href)
      url.searchParams.set('plan', data.plan_id)
      history.replaceState(null, '', url)
    } else if (name === 'interrupt') {
      setInterruptInfo(data)
      setPhase('interrupt')
    } else if (name === 'error') {
      setError(String(data.message ?? '规划失败'))
      setPhase('error')
    }
  }

  function briefPayload() {
    return {
      origin: form.origin,
      destination: form.destination,
      start_date: form.start_date,
      end_date: form.end_date,
      travelers: form.travelers,
      budget_total: form.budget_total,
      companions:
        form.elder || form.child
          ? [...(form.elder ? ['老人'] : []), ...(form.child ? ['儿童'] : [])]
          : ['无'],
      preferences: form.preferences,
      pace: form.pace,
      notes: briefText.trim().slice(0, 1000),
    }
  }

  async function preparePlan() {
    if (!form.destination || preparing) return
    sessionStorage.removeItem(FOLLOWUP_DRAFT_KEY)
    setPreparing(true)
    setError('')
    setQuestionError(null)
    try {
      const res = await apiFetch('/api/plan/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: briefPayload() }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        const message = typeof detail?.detail === 'string' ? detail.detail : `HTTP ${res.status}`
        setQuestionError({
          message,
          retryable: res.status === 429 || res.status >= 500,
          code: `http_${res.status}`,
        })
        return
      }
      const data = await res.json()
      const questions: FollowUpQuestion[] = Array.isArray(data?.questions) ? data.questions : []
      if (data?.warning && questions.length === 0) {
        setQuestionError({
          message: String(data.warning),
          retryable: data.retryable !== false,
          code: typeof data.error_code === 'string' ? data.error_code : '',
        })
        return
      }
      if (questions.length === 0) {
        await runPlan()
        return
      }
      setFollowups(questions)
      setFollowAnswers({})
      setFollowDrafts({})
      setFollowIndex(0)
      setScreen('followup')
    } catch (e) {
      setQuestionError({ message: describeError(e), retryable: true })
    } finally {
      setPreparing(false)
    }
  }

  async function runPlan() {
    sessionStorage.removeItem(FOLLOWUP_DRAFT_KEY)
    setPhase('running')
    setScreen('running')
    setResult(null)
    setInterruptInfo(null)
    setLiveEvents([])
    setError('')
    setActivePlanId(null)
    setCancelling(false)
    const confirmed = Object.values(followAnswers).map(
      (a) => `确认：${a.title.slice(0, 30)}=${a.label.slice(0, 40)}`,
    )
    const body = {
      ...briefPayload(),
      preferences: [
        ...form.preferences,
        ...confirmed,
      ],
    }
    try {
      const res = await apiFetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        throw new Error(typeof detail?.detail === 'string' ? detail.detail : `HTTP ${res.status}`)
      }
      await consume(res, handleEvent)
      setPhase((p) => (p === 'running' ? 'done' : p))
    } catch (e) {
      setError(describeError(e))
      setPhase('error')
    }
  }

  async function resumePlan(decision: string, maxModelCalls?: number) {
    const pid = interruptInfo?.plan_id
    if (!pid) return
    setInterruptInfo(null)
    setActivePlanId(pid)
    setPhase('running')
    setScreen('running')
    try {
      const res = await apiFetch(`/api/plan/${pid}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          kind: interruptInfo?.type === 'peer_escalation' ? 'peer_review_risk' : interruptInfo?.type,
          accepted_issue_codes: decision === 'accept_risk' ? ['REVIEW_RISK_ACCEPTED'] : [],
          note: decision === 'accept_risk' ? '用户确认接受当前评审风险' : '',
          ...(maxModelCalls ? { max_model_calls: maxModelCalls } : {}),
        }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        throw new Error(typeof detail?.detail === 'string' ? detail.detail : `HTTP ${res.status}`)
      }
      await consume(res, handleEvent)
      setPhase((p) => (p === 'running' ? 'done' : p))
    } catch (e) {
      setError(describeError(e))
      setPhase('error')
    }
  }

  async function cancelPlan() {
    const pid = activePlanId ?? new URLSearchParams(location.search).get('plan')
    if (!pid || cancelling) return
    setCancelling(true)
    try {
      const res = await apiFetch(`/api/plan/${pid}/cancel`, { method: 'POST' })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        throw new Error(typeof detail?.detail === 'string' ? detail.detail : `HTTP ${res.status}`)
      }
    } catch (e) {
      setCancelling(false)
      setError(describeError(e))
    }
  }

  async function refine(day: string) {
    if (!result) return
    const text = refineText.trim()
    setRefining(day)
    setRefineNote('')
    setLiveEvents((prev) => [
      ...prev,
      {
        schema_version: 1,
        run_id: result.plan_id,
        plan_version: result.version ?? 1,
        event_id: `refine-local-${Date.now()}`,
        seq: prev.length + 1,
        occurred_at: new Date().toISOString(),
        event_type: 'agent_message',
        stage: 'refine',
        actor: 'orchestrator',
        parent_id: null,
        payload: { text: `开始局部返工 ${day}：${text || '无具体意见'}`, summary: '开始局部返工' },
      },
    ])
    try {
      const res = await apiFetch(`/api/plan/${result.plan_id}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: day, feedback: text }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        throw new Error(typeof detail?.detail === 'string' ? detail.detail : `HTTP ${res.status}`)
      }
      const data = await res.json()
      setResult({
        ...result,
        itinerary: data.itinerary,
        critique: data.critique,
        revision: data.revision ?? result.revision,
        version: data.version ?? result.version,
        document: data.document ?? null,
        team_tasks: data.team_tasks ?? {},
        issue_ledger: data.issue_ledger ?? [],
        approved_version: data.approved_version ?? null,
        team_state: data.team_state ?? null,
        llm_stats: data.llm_stats ?? result.llm_stats,
      })
      if (Array.isArray(data.events) && data.events.length) setLiveEvents(data.events)
      await loadVersions(result.plan_id)
      setRefineText('')
      setRefineNote(
        data.refine_source === 'team'
          ? `已由团队返工复核（第 ${data.version ?? '—'} 版）`
          : data.refine_source === 'model'
            ? '已由模型理解意见后重排'
            : '已按规则重排',
      )
    } catch (e) {
      setError(describeError(e))
    } finally {
      setRefining(null)
    }
  }

  async function loadVersions(pid: string) {
    try {
      const r = await apiFetch(`/api/plan/${pid}/versions`)
      if (!r.ok) return
      const data = await r.json()
      setVersions(data.versions ?? [])
    } catch {
      /* 版本面板失败不影响主流程 */
    }
  }

  async function rollback(version: number) {
    if (!result) return
    try {
      const r = await apiFetch(`/api/plan/${result.plan_id}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setResult({
        ...result,
        itinerary: data.itinerary,
        critique: data.critique,
        version: data.version,
        document: data.document ?? null,
        team_tasks: data.team_tasks ?? {},
        issue_ledger: data.issue_ledger ?? [],
        approved_version: data.approved_version ?? null,
        team_state: data.team_state ?? null,
      })
      await loadVersions(result.plan_id)
    } catch (e) {
      setError(describeError(e))
    }
  }

  const roleStates = useMemo(() => {
    const appeared = new Set(
      liveEvents.filter((e) => e.event_type === 'agent_message' && TEAM_ROLES.includes(e.actor)).map((e) => e.actor),
    )
    const last = [...liveEvents].reverse().find((e) => e.event_type === 'agent_message' && TEAM_ROLES.includes(e.actor))
    const states: Record<string, 'idle' | 'running' | 'done'> = {}
    for (const role of TEAM_ROLES) {
      states[role] = role === last?.actor && phase === 'running' ? 'running' : appeared.has(role) ? 'done' : 'idle'
    }
    return states
  }, [liveEvents, phase])

  const nights = Math.max(1, dayCount(form) - 1)
  const days = result?.itinerary.days ?? []
  const total = result?.itinerary.total_cost ?? 0
  const budget = result?.itinerary.budget_total ?? form.budget_total
  const percent = budget > 0 ? (total / budget) * 100 : 0

  useEffect(() => {
    if (!result) return
    const dates = result.itinerary.days.map((d) => d.date)
    setRefineTarget((prev) => (prev && dates.includes(prev) ? prev : dates[0] ?? ''))
  }, [result])

  const selectedItem = useMemo(() => {
    if (!selected || !result) return null
    const day = result.itinerary.days.find((d) => d.date === selected.date)
    return day?.items.filter((i) => i.type !== 'rest')[selected.index] ?? null
  }, [selected, result])

  const trace = useMemo(() => {
    return liveEvents.slice(-120).map((e) => ({
      id: e.event_id,
      time: new Date(e.occurred_at).toLocaleTimeString('zh-CN', { hour12: false }),
      actor: ACTOR_LABEL[e.actor] ?? e.actor,
      text: String(e.payload?.text ?? e.payload?.message ?? e.payload?.summary ?? e.event_type),
    }))
  }, [liveEvents])

  return (
    <div className="v1">
      {needToken && (
        <div className="v1-tokenbar">
          <span>这个服务需要访问口令。</span>
          <input type="password" placeholder="粘贴访问口令" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} />
          <button
            onClick={() => {
              localStorage.setItem(TOKEN_KEY, tokenDraft.trim())
              setNeedToken(false)
              location.reload()
            }}
            disabled={!tokenDraft.trim()}
          >
            使用
          </button>
        </div>
      )}

      <header className="v1-nav">
        <div className="v1-brand">
          <i />
          行程协作 <small>PLANNER</small>
        </div>
        <nav className="v1-steps">
          {(
            [
              ['home', '01 入口'],
              ['demand', '02 需求'],
              ['run', '03 运行'],
              ['plan', '04 方案'],
              ['share', '05 交付'],
            ] as const
          ).map(([key, label]) => {
            const active =
              (key === 'home' && screen === 'home') ||
              (key === 'demand' && (screen === 'demand' || screen === 'followup')) ||
              (key === 'run' && screen === 'running') ||
              (key === 'plan' && screen === 'plan') ||
              (key === 'share' && screen === 'share')
            const disabled = key === 'plan' && !result
            return (
              <button
                key={key}
                className={active ? 'on' : ''}
                disabled={disabled}
                onClick={() => {
                  if (key === 'home') setScreen('home')
                  if (key === 'demand') setScreen('demand')
                  if (key === 'run') setScreen('running')
                  if (key === 'plan' && result) setScreen('plan')
                  if (key === 'share' && result) setScreen('share')
                }}
              >
                {label}
              </button>
            )
          })}
        </nav>
        <div className="v1-nav-right">
          <span className="v1-tag">{phase === 'running' ? '运行中' : phase === 'done' ? '已交付' : phase === 'error' ? '失败' : '演示数据'}</span>
          <button className="v1-ghost sm" onClick={() => setDrawerOpen(true)} disabled={trace.length === 0}>
            轨迹{trace.length > 0 ? ` ${trace.length}` : ''}
          </button>
          <button className="v1-ghost sm" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </header>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} onSaved={() => undefined} />}

      {drawerOpen && (
        <div className="v1-drawer-mask" onClick={() => setDrawerOpen(false)}>
          <aside className="v1-drawer" ref={drawerRef} onClick={(e) => e.stopPropagation()}>
            <div className="v1-drawer-head">
              <b>执行轨迹</b>
              <span>{liveEvents.length} 条</span>
              <button className="v1-ghost sm" onClick={() => setDrawerOpen(false)}>
                收起
              </button>
            </div>
            <div className="v1-trace">
              {trace.length === 0 && <p className="v1-muted">提交需求后，各角色的动作会实时出现在这里。</p>}
              {trace.map((t) => (
                <div key={t.id} className="v1-trace-row">
                  <time>{t.time}</time>
                  <b>{t.actor}</b>
                  <span>{t.text}</span>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}

      {/* ---------------- 01 入口 ---------------- */}
      {screen === 'home' && (
        <section className="v1-entry">
          <div className="v1-scene" aria-hidden="true">
            <div className="v1-horizon" />
            <div className="v1-floor" />
            <div className="v1-rings"><i /><i /><i /></div>
            <i className="v1-node n1" /><i className="v1-node n2" /><i className="v1-node n3" />
            <div className="v1-light" />
            <svg className="v1-threads" viewBox="0 0 1440 960" preserveAspectRatio="none">
              <path d="M1440 70 C 1180 110, 930 230, 806 348" />
              <path d="M1440 900 C 1180 850, 930 720, 806 628" />
              <path d="M650 960 C 720 840, 780 720, 806 628" />
              <path d="M650 0 C 720 120, 780 240, 806 348" />
              <circle r="2.2" fill="rgba(196,208,238,.8)">
                <animateMotion dur="11s" repeatCount="indefinite" path="M1440 70 C 1180 110, 930 230, 806 348" />
              </circle>
              <circle r="2" fill="rgba(111,227,192,.75)">
                <animateMotion dur="14s" repeatCount="indefinite" path="M650 960 C 720 840, 780 720, 806 628" />
              </circle>
            </svg>
            <ParticleField />
            <div className="v1-veil" />
          </div>

          <div className="v1-entry-stage">
            <div className="v1-entry-copy">
              <div className="v1-eyebrow"><i /><span>multi-agent travel planning</span></div>
              <h1 className="v1-entry-h1">
                <span className="v1-mask"><span>旅行规划，</span></span>
                <span className="v1-mask"><span>应该经得起审阅。</span></span>
              </h1>
              <p className="v1-lede">说清需求，剩下的交给一支会分工、会复核的团队。方案可读、可改、可追溯。</p>
              <div className="v1-cta-row">
                <button className="v1-primary" onClick={() => setScreen('demand')}>开始规划</button>
                <button
                  className="v1-ghost"
                  onClick={() => {
                    setForm(DEFAULT_FORM)
                    setBriefText('')
                    setScreen('demand')
                  }}
                >
                  填入示例
                </button>
              </div>
            </div>

            <div className="v1-entry-panel">
              <div
                className={`v1-panel ${bound ? 'is-bound' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={bound}
                aria-label="装订面板"
                onClick={() => setBound((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setBound((v) => !v)
                  }
                }}
              >
                <div className="v1-spine" />
                {ENTRY_ROLES.map((role, i) => (
                  <div className="v1-strip" key={role.initial} style={{ '--i': i, '--c': role.color } as CSSProperties}>
                    <span className="v1-strip-d">D{i + 1}</span>
                    <span className="v1-seal" style={{ '--c': role.color } as CSSProperties}>
                      {role.initial}
                      <em style={{ '--j': i } as CSSProperties}><b /><b /><b /></em>
                    </span>
                    <span className="v1-strip-line" />
                    <span className="v1-strip-end">—</span>
                    <span className="v1-strip-job">{role.job}</span>
                  </div>
                ))}
                <div className="v1-panel-foot">
                  <span>5 DAYS · 5 ROLES</span>
                  <span className={`v1-state ${bound ? 'bound' : ''}`}>{bound ? 'BOUND · AWAITING INPUT' : 'AWAITING INPUT'}</span>
                </div>
              </div>
            </div>
          </div>

          <footer className="v1-entry-foot">
            <span>多角色协作 · 演示数据</span>
            <span className="spacer" />
            <span>CSS SCENE + CANVAS</span>
          </footer>
        </section>
      )}

      {/* ---------------- 02 需求 ---------------- */}
      {screen === 'demand' && (
        <section className="v1-page v1-demand-page">
          <div className="v1-topbar">
            <button className="v1-back" onClick={() => setScreen('home')}>
              ← 返回
            </button>
            <span className="v1-step">STEP 02 / 05</span>
            <span className="v1-pill">NEW TRIP</span>
          </div>

          <div className="v1-demand-head">
            <h2>先说说这趟旅行。</h2>
            <p className="v1-sub">能推断的先写出来，不确定的才问。</p>
          </div>

          {questionError && (
            <div className="v1-question-alert" role="alert">
              <div className="v1-question-alert-text">
                <b>追问生成失败</b>
                <span>{questionError.message}</span>
              </div>
              <div className="v1-question-alert-actions">
                {questionError.retryable && (
                  <button className="v1-ghost" onClick={() => void preparePlan()}>
                    重试
                  </button>
                )}
                <button
                  className="v1-primary"
                  onClick={() => {
                    setQuestionError(null)
                    void runPlan()
                  }}
                >
                  直接开始
                </button>
              </div>
            </div>
          )}

          <div className="v1-demand-card">
            <div className="v1-demand-form">
              <div className="v1-demand-top">
                <b>你的需求</b>
                <span>可补充</span>
                <em>01 / 需求</em>
              </div>
              <textarea
                placeholder="例如：老人膝盖不好，不能久坐；想安排一次川剧；不吃辣；最后一天下午留空休息。"
                value={briefText}
                maxLength={1000}
                onChange={(e) => setBriefText(e.target.value)}
              />
              <div className="v1-demand-fields">
                <label>
                  <span>出发</span>
                  <input value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} />
                </label>
                <label>
                  <span>到达</span>
                  <input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
                </label>
                <label>
                  <span>开始</span>
                  <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
                </label>
                <label>
                  <span>结束</span>
                  <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
                </label>
                <label>
                  <span>人数</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={form.travelers}
                    onChange={(e) => setForm({ ...form, travelers: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>预算</span>
                  <input
                    type="number"
                    min={1000}
                    step={500}
                    value={form.budget_total}
                    onChange={(e) => setForm({ ...form, budget_total: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="v1-chips">
                <span>同行</span>
                <button className={form.elder ? 'on' : ''} onClick={() => setForm({ ...form, elder: !form.elder })}>
                  老人
                </button>
                <button className={form.child ? 'on' : ''} onClick={() => setForm({ ...form, child: !form.child })}>
                  儿童
                </button>
              </div>
              <div className="v1-chips">
                <span>偏好</span>
                {PREFERENCES.map((p) => (
                  <button
                    key={p}
                    className={form.preferences.includes(p) ? 'on' : ''}
                    onClick={() =>
                      setForm({
                        ...form,
                        preferences: form.preferences.includes(p)
                          ? form.preferences.filter((x) => x !== p)
                          : [...form.preferences, p],
                      })
                    }
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className="v1-chips">
                <span>节奏</span>
                {PACE.map((p) => (
                  <button key={p} className={form.pace === p ? 'on' : ''} onClick={() => setForm({ ...form, pace: p })}>
                    {p}
                  </button>
                ))}
              </div>
              <div className="v1-demand-cta">
                <button className="v1-primary" onClick={() => void preparePlan()} disabled={!form.destination || preparing}>
                  {preparing ? '正在理解需求…' : '确认需求，开始规划 →'}
                </button>
              </div>
            </div>

            <div className="v1-route">
              <div className="v1-route-cap">
                <b>{form.origin || '出发'}</b>
                <b>{form.destination || '到达'}</b>
              </div>
              {amapConfigured && !mapFailed ? (
                <AmapRoute
                  key={`${form.origin}-${form.destination}`}
                  origin={form.origin}
                  destination={form.destination}
                  onError={() => setMapFailed(true)}
                />
              ) : (
                <>
              <svg className="v1-route-svg" viewBox="0 0 320 300" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="v1-route-g" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stopColor="rgba(139,156,255,.1)" />
                    <stop offset=".5" stopColor="rgba(139,156,255,.9)" />
                    <stop offset="1" stopColor="rgba(111,227,192,.6)" />
                  </linearGradient>
                </defs>
                <path className="v1-route-arc" d="M52 244 C 120 226, 160 174, 196 140 S 264 84, 276 58" />
                <circle className="v1-route-port" cx="52" cy="244" r="4" />
                <circle className="v1-route-ring" cx="52" cy="244" r="5" />
                <circle className="v1-route-port" cx="276" cy="58" r="4" />
                <circle className="v1-route-ring" cx="276" cy="58" r="5" />
                <circle r="1.7" fill="#eef1f7">
                  <animateMotion dur="7s" repeatCount="indefinite" path="M52 244 C 120 226, 160 174, 196 140 S 264 84, 276 58" />
                </circle>
                <circle r="1.4" fill="#6fe3c0">
                  <animateMotion dur="7s" begin="-4.5s" repeatCount="indefinite" path="M52 244 C 120 226, 160 174, 196 140 S 264 84, 276 58" />
                </circle>
              </svg>
              <div className="v1-route-dust">
                {[
                  [18, 20, 4.2, -0.4], [34, 14, 5.1, -1.6], [62, 18, 3.8, -2.2], [78, 30, 4.6, -3.1],
                  [24, 44, 5.4, -0.9], [46, 56, 4.4, -2.8], [68, 62, 5.8, -1.2], [84, 74, 4.1, -3.6],
                  [30, 82, 5.2, -2.4], [56, 88, 4.8, -0.2], [12, 62, 5.6, -4], [88, 50, 4.3, -1.9],
                ].map(([x, y, dur, delay], i) => (
                  <i key={i} style={{ left: `${x}%`, top: `${y}%`, '--t': `${dur}s`, '--d': `${delay}s` } as CSSProperties} />
                ))}
              </div>
                </>
              )}

              {amapConfigured && mapFailed && (
                <button type="button" className="v1-route-retry" onClick={() => setMapFailed(false)}>
                  重试真实地图
                </button>
              )}

              <span className="v1-route-badge">
                {dayCount(form)} DAYS · {form.travelers} PAX
              </span>
            </div>
          </div>
        </section>
      )}

      {/* ---------------- 03 追问 ---------------- */}
      {screen === 'followup' && (
        <section className="v1-page v1-fu-page">
          <div className="v1-topbar">
            <button className="v1-back" onClick={() => setScreen('demand')}>
              ← 改需求
            </button>
            <span className="v1-step">STEP 02 / 05 · 确认</span>
            <span className="v1-pill">CLARIFY</span>
          </div>

          <div className="v1-demand-head">
            <h2>开始之前，先确认几件事。</h2>
            <p className="v1-sub">能推断的先写出来，不确定的才问。</p>
          </div>

          <div className="v1-fu-summary">
            <span>{form.destination} · {form.start_date.slice(5)} – {form.end_date.slice(5)}</span>
            <span>{form.travelers} 人{form.elder ? ' · 老人' : ''}{form.child ? ' · 儿童' : ''}</span>
            <span>{money(form.budget_total)}</span>
            <span>{form.preferences.slice(0, 2).join(' / ') || '—'}</span>
          </div>

          <div className="v1-fu-rail">
            {followups.map((q, i) => {
              const answer = followAnswers[i]
              return answer ? (
                <button key={i} className="v1-fu-chip" onClick={() => setFollowIndex(i)}>
                  <span>✓ {answer.label}</span>
                  <em>改</em>
                </button>
              ) : null
            })}
          </div>

          <div className="v1-fu-progress">
            <span>{Object.keys(followAnswers).length} / {followups.length}</span>
            <div className="v1-fu-bar">
              <i style={{ width: `${(Object.keys(followAnswers).length / followups.length) * 100}%` }} />
            </div>
          </div>

          {followIndex < followups.length && (
            <article className="v1-fu-card" key={followIndex}>
              <div className="v1-fu-meta">
                <span className={`v1-fu-tag ${followups[followIndex].kind}`}>
                  {followups[followIndex].kind === 'infer' ? '推断' : '需要确认'}
                </span>
                <span className="v1-fu-conf">可信度 {followups[followIndex].confidence}</span>
              </div>
              <h3>{followups[followIndex].title}</h3>
              <p>{followups[followIndex].why}</p>
              <div className="v1-fu-opts">
                {followups[followIndex].options.map((o, oi) => (
                  <button
                    key={oi}
                    className={followAnswers[followIndex]?.label === o.label ? 'on' : ''}
                    onClick={() => {
                      const next = { ...followAnswers, [followIndex]: { title: followups[followIndex].title, label: o.label } }
                      setFollowAnswers(next)
                      const nextIdx = followups.findIndex((_, idx) => !next[idx])
                      setFollowIndex(nextIdx === -1 ? followups.length : nextIdx)
                    }}
                  >
                    <span>{o.label}</span>
                    {o.note && <em>{o.note}</em>}
                  </button>
                ))}
                <div className="v1-fu-custom">
                  <input
                    value={followDrafts[followIndex] ?? ''}
                    placeholder="其他（自己写）"
                    onChange={(e) => setFollowDrafts({ ...followDrafts, [followIndex]: e.target.value })}
                  />
                  <button
                    disabled={!(followDrafts[followIndex] ?? '').trim()}
                    onClick={() => {
                      const text = (followDrafts[followIndex] ?? '').trim()
                      if (!text) return
                      const next = { ...followAnswers, [followIndex]: { title: followups[followIndex].title, label: text } }
                      setFollowAnswers(next)
                      const nextIdx = followups.findIndex((_, idx) => !next[idx])
                      setFollowIndex(nextIdx === -1 ? followups.length : nextIdx)
                    }}
                  >
                    用这句确认 →
                  </button>
                </div>
              </div>
            </article>
          )}

          {Object.keys(followAnswers).length === followups.length && (
            <div className="v1-fu-final">
              <b>信息齐了。</b>
              <p>推断已确认，问题已回答。</p>
              <button className="v1-primary" onClick={() => void runPlan()}>
                开始规划 →
              </button>
            </div>
          )}
        </section>
      )}

      {/* ---------------- 04 运行 / 错误 ---------------- */}
      {screen === 'running' && (
        <section className="v1-page">
          <div className="v1-topbar">
            <button className="v1-back" onClick={() => setScreen('demand')}>
              ← 改取舍
            </button>
            <span className="v1-step">STEP 03 / 05</span>
            <span className="v1-pill">{phase === 'running' ? 'RUNNING' : 'RESULT'}</span>
          </div>
          <h2>{phase === 'running' ? '五个角色，把方案接力装出来。' : phase === 'interrupt' ? '有一个决定，需要你拍板。' : '这次运行没有完成。'}</h2>
          <p className="v1-sub">
            {phase === 'running'
              ? '每个角色交付一个可检查的中间产物，评审不过就退回重排。'
              : phase === 'interrupt'
                ? '团队停下来等你，不会替你决定。'
                : '下面是失败原因；可以调整需求后重试。'}
          </p>

          {(error || phase === 'error' || phase === 'stopped') && (
            <div className="v1-alert">
              <b>{phase === 'stopped' ? '未完成' : '失败'}</b>
              <p>{error || '未知错误'}</p>
              <div className="v1-actions">
                <button className="v1-primary" onClick={() => setScreen('demand')}>
                  调整需求
                </button>
                <button className="v1-ghost" onClick={runPlan}>
                  用同样需求重试
                </button>
              </div>
            </div>
          )}

          {phase !== 'error' && phase !== 'stopped' && (
            <div className="v1-line">
              <div className="v1-rail">
                {TEAM_ROLES.map((role) => (
                  <Station key={role} role={role} state={roleStates[role] ?? 'idle'} />
                ))}
              </div>

              <div className="v1-run-body">
                <div className="v1-assembly">
                  <div className="v1-asm-head">
                    <span>正在装配</span>
                    <em>{liveEvents.length} 事件</em>
                  </div>
                  {[
                    ['clarify', '澄清需求'],
                    ['retrieval', '并行检索'],
                    ['peer', '专业团队'],
                    ['plan', '排行程'],
                    ['check', '硬约束校验'],
                    ['confirm', '整合文稿'],
                  ].map(([key, label], i) => {
                    const reached = liveEvents.some((e) => e.stage === key)
                    return (
                      <div key={key} className={`v1-asm-row ${reached ? 'on' : ''}`}>
                        <span>{String(i + 1).padStart(2, '0')}</span>
                        <i />
                        <b>{label}</b>
                        <em>{reached ? '完成' : '等待'}</em>
                      </div>
                    )
                  })}
                </div>

                <div className="v1-issues">
                  <div className="v1-asm-head">
                    <span>问题清单</span>
                    <em>{result?.critique.issues.length ?? 0}</em>
                  </div>
                  {(result?.critique.issues ?? []).slice(0, 4).map((issue) => (
                    <div key={issue.code} className="v1-issue">
                      <span className={issue.severity === 'blocker' ? 'bad' : 'warn'}>{issue.code}</span>
                      <p>{issue.message}</p>
                    </div>
                  ))}
                  {(!result || result.critique.issues.length === 0) && <p className="v1-muted">评审结束后，问题会出现在这里。</p>}
                </div>
              </div>

              <div className="v1-actions">
                {phase === 'running' && (
                  <>
                    <button className="v1-ghost" onClick={cancelPlan} disabled={!activePlanId || cancelling}>
                      {cancelling ? '正在取消…' : '停止运行'}
                    </button>
                    <span className="v1-hint">已产生 {liveEvents.length} 条执行记录</span>
                  </>
                )}
                {result && (
                  <button className="v1-primary" onClick={() => setScreen('plan')}>
                    查看完整方案 →
                  </button>
                )}
              </div>
            </div>
          )}

          {interruptInfo && (
            <div className="v1-interrupt">
              <b>{interruptInfo.question ?? interruptInfo.message ?? '需要你决定'}</b>
              {typeof interruptInfo.total === 'number' && (
                <p>
                  当前花费 {money(interruptInfo.total)}，预算 {money(interruptInfo.budget ?? 0)}
                  {typeof interruptInfo.over === 'number' && interruptInfo.over > 0 ? `，超出 ${money(interruptInfo.over)}` : ''}
                </p>
              )}
              <div className="v1-actions">
                {(interruptInfo.options ?? []).map((o) => (
                  <button key={o.value} className="v1-primary" onClick={() => resumePlan(o.value, o.value === 'continue' ? interruptInfo.suggested_max_calls : undefined)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------------- 05 方案 ---------------- */}
      {screen === 'plan' && result && (
        <section className="v1-page wide">
          <div className="v1-plan-head">
            <div>
              <div className="v1-label">STEP 04 / 05 · 方案</div>
              <h2>{result.document?.title ?? `${result.brief.origin}—${result.brief.destination} 行程`}</h2>
              <div className="v1-meta-line">
                {result.itinerary.days.length} 天 · {result.itinerary.days.reduce((n, d) => n + d.items.filter((i) => i.type === 'sight').length, 0)} 处 ·{' '}
                {money(total)} / {money(budget)}
              </div>
            </div>
            <div className="v1-plan-actions">
              <span className={`v1-vpill ${result.critique.passed ? 'ok' : 'bad'}`}>{result.critique.passed ? '已评审' : '有未解项'}</span>
              <span className="v1-vpill">计划 v{result.version ?? '—'}</span>
              <button className="v1-ghost sm" onClick={() => setScreen('demand')}>
                重新提需求
              </button>
              <button className="v1-primary sm" onClick={() => setScreen('share')}>
                交付 →
              </button>
            </div>
          </div>

          <div className="v1-tabs">
            {(
              [
                ['tt', '时刻表'],
                ['budget', '预算'],
                ['change', '变更'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'tt' && (
            <div className="v1-plan-grid">
              <aside className="v1-dayrail">
                <span className="v1-label">{days.length} 天</span>
                <button className={dayFilter === null ? 'on' : ''} onClick={() => setDayFilter(null)}>
                  <b>全部</b>
                  <small>{money(total)}</small>
                </button>
                {days.map((d) => (
                  <button key={d.date} className={dayFilter === d.date ? 'on' : ''} onClick={() => setDayFilter(dayFilter === d.date ? null : d.date)}>
                    <b>{d.date.slice(5)}</b>
                    <small>{money(d.day_cost)}</small>
                  </button>
                ))}
              </aside>

              <div className="v1-tt-wrap">
                <Timetable
                  days={days}
                  filter={dayFilter}
                  selected={selected}
                  onSelect={(date, index) => setSelected({ date, index })}
                />
                <div className="v1-legend">
                  <span><i className="flight" />航班</span>
                  <span><i className="sight" />景点</span>
                  <span><i className="meal" />餐食</span>
                  <span><i className="hotel" />住宿</span>
                  <span><i className="free" />自由时间</span>
                </div>
                <div className="v1-cmd v1-rework">
                  <span>/</span>
                  <select
                    className="v1-rework-date"
                    aria-label="选择要重排的日期"
                    value={refineTarget}
                    onChange={(e) => {
                      setRefineTarget(e.target.value)
                      setRefineNote('')
                    }}
                    disabled={!days.length}
                  >
                    {days.map((d) => (
                      <option key={d.date} value={d.date}>{d.date.slice(5)}</option>
                    ))}
                  </select>
                  <input
                    ref={refineInputRef}
                    placeholder="对选中的日期下指令，例如：下午换成室内"
                    value={refineText}
                    onChange={(e) => setRefineText(e.target.value)}
                  />
                  <button
                    className="v1-primary sm"
                    disabled={!days.length || refining !== null}
                    onClick={() => refine(refineTarget)}
                  >
                    {refining ? '重排中…' : '执行'}
                  </button>
                </div>
                {refineNote && <p className="v1-refine-note">{refineNote}</p>}
              </div>

              <aside className="v1-inspector">
                <div className="v1-panel">
                  <div className="v1-label">当前选择</div>
                  {selectedItem ? (
                    <>
                      <b className="v1-sel-title">{selectedItem.title}</b>
                      <div className="v1-kv"><span>时间</span><b>{hhmm(selectedItem.start_time)}{selectedItem.end_time !== selectedItem.start_time ? `–${hhmm(selectedItem.end_time)}` : ''}</b></div>
                      <div className="v1-kv"><span>类型</span><b>{TYPE_LABEL[selectedItem.type] ?? selectedItem.type}</b></div>
                      <div className="v1-kv"><span>花费</span><b>{selectedItem.cost > 0 ? money(selectedItem.cost) : '免费'}</b></div>
                      {selectedItem.note && <p className="v1-note">{selectedItem.note}</p>}
                      <button
                        className="v1-ghost sm"
                        onClick={() => {
                          if (!selected) return
                          setRefineTarget(selected.date)
                          setRefineNote('已选择这一天，请在下方输入修改意见')
                          refineInputRef.current?.focus()
                        }}
                        disabled={refining !== null}
                      >
                        让团队改这一天
                      </button>
                    </>
                  ) : (
                    <p className="v1-note">点时刻表里的任意一块，查看时间、花费与备注。</p>
                  )}
                </div>

                <div className="v1-panel">
                  <div className="v1-label">待你判断</div>
                  <div className="v1-kv"><span>预算余量</span><b className={percent > 95 ? 'v1-warn' : ''}>{money(budget - total)}</b></div>
                  <Bar value={percent} tone={percent > 100 ? 'rose' : percent > 95 ? 'amber' : 'indigo'} />
                  {percent > 95 && <p className="v1-warnbox">余量不足 5%，再加任何一处都可能超支。</p>}
                </div>

                <div className="v1-panel">
                  <div className="v1-label">团队</div>
                  {TEAM_ROLES.map((role) => (
                    <div key={role} className="v1-kv">
                      <span>
                        <i className="v1-dot" style={{ background: ROLE_COLOR[role] }} />
                        {ACTOR_LABEL[role]}
                      </span>
                      <b>{result.team_state === 'approved' || roleStates[role] === 'done' ? '已交付' : roleStates[role] === 'running' ? '进行中' : '待命'}</b>
                    </div>
                  ))}
                </div>

                {result.critique.issues.length > 0 && (
                  <div className="v1-panel">
                    <div className="v1-label">评审问题</div>
                    {result.critique.issues.map((issue) => (
                      <div key={issue.code} className="v1-issue">
                        <span className={issue.severity === 'blocker' ? 'bad' : 'warn'}>{issue.code}</span>
                        <p>{issue.message}</p>
                      </div>
                    ))}
                  </div>
                )}
              </aside>
            </div>
          )}

          {tab === 'budget' && (
            <div className="v1-ledger">
              <div className="v1-panel">
                <div className="v1-big">{money(total)}</div>
                <Bar value={percent} tone={percent > 100 ? 'rose' : percent > 95 ? 'amber' : 'indigo'} />
                <div className="v1-kv"><span>预算</span><b>{money(budget)}</b></div>
                <div className="v1-kv"><span>使用率</span><b>{percent.toFixed(1)}%</b></div>
                <div className="v1-kv"><span>余量</span><b className={budget - total < 0 ? 'v1-bad' : ''}>{money(budget - total)}</b></div>
                {result.summary?.source && <p className="v1-note">{result.summary.source.label} · {result.summary.source.note}</p>}
              </div>
              <div className="v1-panel">
                <div className="v1-label">分项</div>
                {(result.summary?.cost.items ?? []).map((c) => (
                  <div key={c.key} className="v1-kv">
                    <span>{c.label}</span>
                    <b>{money(c.amount)}</b>
                  </div>
                ))}
                {!result.summary && <p className="v1-note">这次结果没有返回花费构成。</p>}
              </div>
            </div>
          )}

          {tab === 'change' && (
            <div className="v1-change">
              <div className="v1-panel">
                <div className="v1-label">版本</div>
                {versions.length === 0 && <p className="v1-note">还没有版本记录。</p>}
                {versions.map((v) => (
                  <div key={v.version} className="v1-ver-row">
                    <b>v{v.version}</b>
                    <span>{v.source} · {v.note || '—'}</span>
                    <em>{money(v.total_cost)}</em>
                    {v.version === (result.version ?? -1) ? (
                      <i>当前</i>
                    ) : (
                      <button className="v1-ghost sm" onClick={() => rollback(v.version)}>
                        回到这版
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {result.issue_ledger && result.issue_ledger.length > 0 && (
                <div className="v1-panel">
                  <div className="v1-label">问题清单</div>
                  {result.issue_ledger.map((issue) => (
                    <div key={issue.code} className="v1-issue">
                      <span className={issue.status === 'closed' ? 'ok' : 'warn'}>{issue.code}</span>
                      <p>
                        {issue.acceptance ?? issue.code} · {issue.status === 'closed' ? `关闭于 v${issue.fixed_in_version ?? '—'}` : '待处理'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ---------------- 06 交付 ---------------- */}
      {screen === 'share' && result && (
        <section className="v1-share">
          <div className="v1-label">STEP 05 / 05 · 交付</div>
          <h2>方案已交付。</h2>
          <p className="v1-sub">一份可读、可改、可追溯的行程。发给同行的人，或自己带走。</p>

          <div className="v1-tripcard">
            <div className="v1-tc-head">
              <div>
                <h3>{result.document?.title ?? '旅行方案'}</h3>
                <div className="v1-meta-line">
                  {result.brief.start_date} — {result.brief.end_date} · {result.brief.travelers} 人 · {money(total)} / {money(result.brief.budget_total)}
                </div>
              </div>
              <span className="v1-vpill ok">已评审</span>
            </div>
            {days.map((d) => {
              const first = d.items.find((i) => i.type === 'sight') ?? d.items[0]
              return (
                <div key={d.date} className="v1-tc-day">
                  <span>{d.date.slice(5)}</span>
                  <b>{first?.title ?? '自由安排'}</b>
                  <em>{hhmm(first?.start_time ?? '')}</em>
                </div>
              )
            })}
            <div className="v1-tc-foot">
              <span>{days.length} 天 · {money(total)}</span>
              {result.llm_stats?.calls != null && <span>{result.llm_stats.calls} 次请求</span>}
            </div>
          </div>

          {result.document && (
            <section className="v1-doc">
              <header className="v1-doc-head">
                <span className="v1-doc-kicker">PLAN BOOK</span>
                <b className="v1-doc-title">计划书</b>
                <span className="v1-doc-by">文案 Agent 整理</span>
              </header>

              {result.document.overview && <p className="v1-doc-overview">{result.document.overview}</p>}

              <div className="v1-doc-days">
                {result.document.days.map((day) => {
                  const text = day.summary || ''
                  const preview = text.split('（实际安排：')[0].slice(0, 54)
                  return (
                    <details key={day.date} className="v1-doc-day">
                      <summary>
                        <span>{day.date.slice(5)}</span>
                        <b className="v1-doc-preview">{preview || '当天安排'}</b>
                        <em className="v1-doc-open">展开</em>
                        <em className="v1-doc-close">收起</em>
                      </summary>
                      <p>{text}</p>
                    </details>
                  )
                })}
              </div>

              {(result.document.practical_notes?.length ?? 0) > 0 && (
                <div className="v1-doc-notes">
                  <div className="v1-doc-notes-title">出行提示</div>
                  <ul>
                    {result.document.practical_notes?.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          <div className="v1-recap">
            <div><span>角色</span><b>5</b><small>全部交付</small></div>
            <div><span>问题</span><b>{result.critique.issues.length}</b><small>{result.critique.passed ? '已通过' : '待处理'}</small></div>
            <div><span>版本</span><b>v{result.version ?? '—'}</b><small>可回滚</small></div>
          </div>

          <div className="v1-actions center">
            <button className="v1-primary" onClick={() => setScreen('plan')}>回到方案</button>
            <button
              className="v1-ghost"
              onClick={() => {
                const url = result.share
                  ? `${location.origin}/?plan=${result.plan_id}&share=${encodeURIComponent(result.share)}`
                  : location.href
                void navigator.clipboard.writeText(url)
              }}
            >
              复制链接
            </button>
            <button className="v1-ghost" onClick={() => window.print()}>打印</button>
            <button className="v1-ghost" onClick={() => setScreen('home')}>重新规划</button>
          </div>
        </section>
      )}
    </div>
  )
}

/** ---------------- 时刻表 ---------------- */

function Timetable({
  days,
  filter,
  selected,
  onSelect,
}: {
  days: Day[]
  filter: string | null
  selected: { date: string; index: number } | null
  onSelect: (date: string, index: number) => void
}) {
  const START = 8 * 60
  const END = 22 * 60
  const PX = 52
  const all = days.flatMap((d) => d.items)
  const min = Math.max(START, Math.min(...all.map((i) => minutesOf(i.start_time)).filter((n) => n > 0), START))
  const max = Math.min(END, Math.max(...all.map((i) => minutesOf(i.end_time)).filter((n) => n > 0), END))
  const top = (m: number) => ((m - min) / 60) * PX
  const height = (a: number, b: number) => Math.max(18, ((Math.max(b, a + 30) - a) / 60) * PX)

  if (days.length === 0) return <div className="v1-empty">还没有行程数据。</div>

  return (
    <div className="v1-tt">
      <div className="v1-tt-grid" style={{ gridTemplateColumns: `38px repeat(${days.length}, minmax(0,1fr))` }}>
        <div className="v1-tt-corner" />
        {days.map((d) => (
          <div key={d.date} className="v1-tt-dh">
            <b>{d.date.slice(5)} 周{weekday(d.date)}</b>
            <small>{money(d.day_cost)}</small>
          </div>
        ))}
        <div className="v1-tt-axis" style={{ height: ((max - min) / 60) * PX }}>
          {Array.from({ length: Math.floor((max - min) / 60) + 1 }, (_, i) => (
            <span key={i} style={{ top: i * PX }}>
              {String(Math.floor(min / 60) + i).padStart(2, '0')}
            </span>
          ))}
        </div>
        {days.map((d) => (
          <div key={d.date} className={`v1-tt-col ${filter && filter !== d.date ? 'dim' : ''}`} style={{ height: ((max - min) / 60) * PX }}>
            {d.items
              .filter((i) => i.type !== 'rest')
              .map((item, index) => {
                const a = Math.max(min, minutesOf(item.start_time))
                const b = Math.min(max, minutesOf(item.end_time) || a + 60)
                const isSel = selected?.date === d.date && selected.index === index
                return (
                  <button
                    key={index}
                    className={`v1-blk ${item.type} ${isSel ? 'sel' : ''}`}
                    style={{ top: top(a), height: height(a, b) }}
                    onClick={() => onSelect(d.date, index)}
                  >
                    <span className="v1-blk-t">{hhmm(item.start_time)}</span>
                    <span className="v1-blk-n">{item.title}</span>
                    {item.cost > 0 && <span className="v1-blk-c">{money(item.cost)}</span>}
                  </button>
                )
              })}
          </div>
        ))}
      </div>
    </div>
  )
}
