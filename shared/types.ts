/**
 * TSD Agent — shared API contract.
 * Renderer and Electron main both consume these types.
 * The Python backend (server/) implements exactly this contract.
 * See docs/API.md for the wire format.
 */

export type ProjectStatus = 'draft' | 'running' | 'ready' | 'failed'
export type RunKind = 'upgrade' | 'chat'
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type Side = 'source' | 'target'
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged'

export interface ProjectStats {
  files: number
  added: number
  removed: number
  sections: number
  filesChanged?: number
}

export interface Project {
  id: string
  name: string
  slug: string
  sourceUrl?: string
  sourceKind?: 'page' | 'git' | 'zip' | 'local'
  baseVersion: string
  targetVersion: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
  workspace: string
  planPath?: string
  updatePath?: string
  sourceDir?: string
  targetDir?: string
  lastRunId?: string
  stats?: ProjectStats
  error?: string
  tags?: string[]
  description?: string
}

export interface RunStep {
  key: string
  title: string
  detail?: string
  status: StepStatus
  startedAt?: number
  finishedAt?: number
  progress?: number
  metrics?: Record<string, number | string>
}

export interface Run {
  id: string
  projectId: string
  kind: RunKind
  status: RunStatus
  prompt?: string
  startedAt: number
  finishedAt?: number
  steps: RunStep[]
  error?: string
  summary?: string
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error' | 'success'

/** Stream event. The payload for each event type lives in data. */
export interface AgentEvent {
  seq: number
  runId: string
  ts: number
  type:
    | 'run.status'
    | 'step.status'
    | 'log'
    | 'artifact'
    | 'plan.ready'
    | 'diff.ready'
    | 'chat.delta'
    | 'chat.message'
    | 'chat.proposal'
    | 'run.metrics'
    | 'run.done'
    | 'run.error'
  step?: string
  level?: EventLevel
  message?: string
  delta?: string
  data?: Record<string, unknown>
}

export interface PlanSectionDiff {
  key: string
  heading: string
  level: number
  status: 'added' | 'removed' | 'modified' | 'unchanged'
  oldText?: string
  newText?: string
  summary?: string
}

export interface DiffFile {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  patch: string
  binary?: boolean
  truncated?: boolean
  language?: string
}

export interface DiffPayload {
  projectId: string
  generatedAt: number
  plan: { unified: string; sections: PlanSectionDiff[]; additions: number; deletions: number }
  files: DiffFile[]
  stats: { files: number; added: number; removed: number; filesChanged: number }
}

export interface Documents {
  projectId: string
  plan: { content: string; path: string; updatedAt: number; exists: boolean }
  update: { content: string; path: string; updatedAt: number; exists: boolean }
}

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  status?: FileStatus
  additions?: number
  deletions?: number
  children?: TreeNode[]
}

export interface FileContent {
  path: string
  content: string
  size: number
  language: string
  truncated?: boolean
  binary?: boolean
  status?: FileStatus
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: number
  runId?: string
  streaming?: boolean
  proposal?: CodeProposal
  thinking?: string
  error?: string
}

export interface CodeProposal {
  id: string
  summary: string
  rationale?: string
  edits: Array<{
    path: string
    before: string
    after: string
    patch?: string
    additions: number
    deletions: number
  }>
  applied?: boolean
  discarded?: boolean
}

export interface EngineSettings {
  provider: 'openai-compatible' | 'offline'
  baseUrl: string
  model: string
  apiKeySet: boolean
  temperature: number
  maxTokens: number
  timeoutSec: number
  offlineMode: boolean
}

export interface SettingsPatch {
  engine?: Partial<EngineSettings> & { apiKey?: string }
  workspace?: string
  concurrency?: number
  autoApplyChatEdits?: boolean
  language?: 'zh-CN' | 'en'
}

export interface AppSettings {
  engine: EngineSettings
  workspace: string
  concurrency: number
  autoApplyChatEdits: boolean
  language: 'zh-CN' | 'en'
}

export interface HealthInfo {
  ok: boolean
  version: string
  engine: 'online' | 'offline'
  model?: string
  workspace: string
  uptimeSec: number
  platform: string
}

export interface CreateProjectInput {
  name: string
  sourceUrl?: string
  sourceKind?: 'page' | 'git' | 'zip' | 'local'
  targetVersion?: string
  description?: string
}

export interface StartRunInput {
  upgradeRequest: string
  targetVersion?: string
  referenceUrl?: string
}
