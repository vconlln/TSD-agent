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

export interface W3Settings {
  serverUrl: string
  loginPath: string
  modelsPath: string
  rememberUsername: string
  configured: boolean
}

export interface GitSettings {
  provider: 'local' | 'gitlab' | 'github' | 'generic'
  baseUrl: string
  tokenSet: boolean
  reposPath: string
  reposRoot: string
  defaultBranch: string
  authorName: string
  authorEmail: string
}

export interface SettingsPatch {
  engine?: Partial<EngineSettings> & { apiKey?: string }
  w3?: Partial<W3Settings>
  git?: Partial<Omit<GitSettings, 'tokenSet'>> & { token?: string }
  workspace?: string
  concurrency?: number
  autoApplyChatEdits?: boolean
  language?: 'zh-CN' | 'en'
}

export interface AppSettings {
  engine: EngineSettings
  w3?: W3Settings
  git?: GitSettings
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

/* ------------------------------ W3 auth ------------------------------ */

export interface W3User {
  id?: string
  name?: string
  email?: string
  department?: string
  [key: string]: unknown
}

export interface W3Model {
  id: string
  name: string
  provider?: string
  contextWindow?: number
  tags?: string[]
  recommended?: boolean
}

export interface W3Status {
  authenticated: boolean
  configured: boolean
  mode: 'w3' | 'demo'
  user?: W3User
  expiresAt?: number
  tokenPreview?: string
  rememberUsername?: string
  models: W3Model[]
}

/* -------------------------------- Git -------------------------------- */

export interface RepoInfo {
  name: string
  fullName?: string
  url: string
  path?: string
  description?: string
  defaultBranch?: string
  updatedAt?: number
  provider: string
}

export interface GitDirtyEntry {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
}

export interface GitStatusInfo {
  initialized: boolean
  repoDir?: string
  gitAvailable?: boolean
  branch?: string
  upstream?: string
  remoteUrl?: string
  remotes?: Array<{ name: string; url: string }>
  ahead?: number
  behind?: number
  dirty?: GitDirtyEntry[]
  lastCommit?: { sha: string; message: string; author: string; date: string } | null
  sourceUrl?: string
}

export interface GitBranchInfo {
  current: string
  local: Array<{ name: string; sha: string; date: string; subject: string }>
  remote: Array<{ name: string; sha: string; date: string; subject: string }>
}

export interface GitCompareResult {
  ok: boolean
  reason?: string
  note?: string
  base?: string
  branch?: string
  fetched?: boolean
  ahead?: number
  behind?: number
  commits?: Array<{ sha: string; subject: string }>
  incoming?: Array<{ sha: string; subject: string }>
  files?: Array<{ status: string; path: string }>
}

export interface GitPublishResult {
  ok: boolean
  reason?: string
  note?: string
  branch?: string
  sha?: string
  pushed?: boolean
  remote?: string
  url?: string
  error?: string
  dirty?: string[]
  files?: Array<{ path: string; status: string }>
}

/* --------------------------- Inline agent ---------------------------- */

export interface InlineEditResult {
  ok: boolean
  mode?: 'llm' | 'offline'
  model?: string
  error?: string
  path?: string
  scope?: 'selection' | 'file'
  startLine?: number
  endLine?: number
  summary?: string
  rationale?: string
  replacement?: string
  before?: string
  after?: string
  patch?: string
  additions?: number
  deletions?: number
}

export interface ExplainResult {
  ok: boolean
  mode?: 'llm' | 'offline'
  model?: string
  text: string
  path?: string
}

export interface FileWriteResult {
  ok: boolean
  path: string
  size: number
  updatedAt: number
}

export interface W3LoginResult extends W3Status {}

export interface GitReposResult {
  provider: string
  prefix: string
  repos: RepoInfo[]
  note?: string
}

export interface ModelsResult {
  models: W3Model[]
  source: 'w3' | 'builtin'
}
