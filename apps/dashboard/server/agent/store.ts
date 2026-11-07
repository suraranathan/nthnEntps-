import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AgentRole = 'user' | 'assistant' | 'tool' | 'system'

export type ToolCallStatus = 'proposed' | 'awaiting-approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled'

export interface ToolCallRecord {
  id: string
  tool: string
  arguments: Record<string, unknown>
  status: ToolCallStatus
  summary?: string
  output?: string
  error?: string
  approvalId?: string
}

export interface AgentMessage {
  id: string
  role: AgentRole
  content: string
  createdAt: string
  status: 'complete' | 'streaming' | 'error' | 'cancelled'
  toolCalls?: ToolCallRecord[]
  decision?: unknown
  meta?: Record<string, unknown>
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: AgentMessage[]
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

interface PersistedState {
  version: 1
  activeId: string | null
  conversations: Conversation[]
}

const MAX_MESSAGES_PER_CONVERSATION = 400
const MAX_CONTENT = 500_000
const MAX_CONVERSATIONS = 100

function now(): string {
  return new Date().toISOString()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeConversation(value: unknown): Conversation | null {
  if (!isObject(value)) return null
  if (typeof value.id !== 'string' || typeof value.title !== 'string') return null
  if (!Array.isArray(value.messages)) return null
  const messages: AgentMessage[] = []
  for (const raw of value.messages) {
    if (!isObject(raw)) continue
    if (typeof raw.id !== 'string' || typeof raw.content !== 'string') continue
    if (!['user', 'assistant', 'tool', 'system'].includes(String(raw.role))) continue
    messages.push({
      id: raw.id,
      role: raw.role as AgentRole,
      content: raw.content.slice(0, MAX_CONTENT),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now(),
      status: ['complete', 'streaming', 'error', 'cancelled'].includes(String(raw.status)) ? raw.status as AgentMessage['status'] : 'complete',
      toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls as ToolCallRecord[] : undefined,
      decision: raw.decision,
      meta: isObject(raw.meta) ? raw.meta : undefined,
    })
  }
  return {
    id: value.id,
    title: value.title.slice(0, 200),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now(),
    messages: messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
  }
}

export class AgentChatStore {
  private readonly directory: string
  private readonly file: string
  private state: PersistedState = { version: 1, activeId: null, conversations: [] }
  private writeChain: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(directory: string) {
    this.directory = directory
    this.file = join(directory, 'conversations.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (isObject(raw) && Array.isArray(raw.conversations)) {
        const conversations = raw.conversations.map(sanitizeConversation).filter((item): item is Conversation => item !== null).slice(-MAX_CONVERSATIONS)
        this.state = {
          version: 1,
          activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
          conversations,
        }
        if (this.state.activeId && !conversations.some(item => item.id === this.state.activeId)) this.state.activeId = conversations.at(-1)?.id ?? null
      }
    } catch {
      this.state = { version: 1, activeId: null, conversations: [] }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state)
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.file}.tmp`
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.file)
    }).catch(() => undefined)
    await this.writeChain
  }

  list(): ConversationSummary[] {
    return [...this.state.conversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(item => ({ id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, messageCount: item.messages.length }))
  }

  get(id: string): Conversation | null {
    return this.state.conversations.find(item => item.id === id) ?? null
  }

  activeId(): string | null {
    return this.state.activeId
  }

  async setActive(id: string): Promise<void> {
    if (!this.get(id)) return
    this.state.activeId = id
    await this.persist()
  }

  async create(title = 'New conversation'): Promise<Conversation> {
    const conversation: Conversation = {
      id: randomUUID(),
      title,
      createdAt: now(),
      updatedAt: now(),
      messages: [],
    }
    this.state.conversations.push(conversation)
    this.state.conversations = this.state.conversations.slice(-MAX_CONVERSATIONS)
    this.state.activeId = conversation.id
    await this.persist()
    return conversation
  }

  async append(conversationId: string, message: Omit<AgentMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<AgentMessage> {
    const conversation = this.get(conversationId)
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`)
    const entry: AgentMessage = {
      id: message.id ?? randomUUID(),
      role: message.role,
      content: message.content.slice(0, MAX_CONTENT),
      createdAt: message.createdAt ?? now(),
      status: message.status,
      toolCalls: message.toolCalls,
      decision: message.decision,
      meta: message.meta,
    }
    conversation.messages.push(entry)
    if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) conversation.messages = conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION)
    conversation.updatedAt = now()
    if (conversation.title === 'New conversation' && entry.role === 'user' && entry.content.trim()) {
      conversation.title = entry.content.trim().replace(/\s+/g, ' ').slice(0, 80)
    }
    this.state.activeId = conversationId
    await this.persist()
    return entry
  }

  async update(conversationId: string, messageId: string, patch: Partial<Pick<AgentMessage, 'content' | 'status' | 'toolCalls' | 'decision' | 'meta'>>): Promise<AgentMessage | null> {
    const conversation = this.get(conversationId)
    if (!conversation) return null
    const message = conversation.messages.find(item => item.id === messageId)
    if (!message) return null
    if (patch.content !== undefined) message.content = patch.content.slice(0, MAX_CONTENT)
    if (patch.status !== undefined) message.status = patch.status
    if (patch.toolCalls !== undefined) message.toolCalls = patch.toolCalls
    if (patch.decision !== undefined) message.decision = patch.decision
    if (patch.meta !== undefined) message.meta = patch.meta
    conversation.updatedAt = now()
    await this.persist()
    return message
  }

  async rename(conversationId: string, title: string): Promise<void> {
    const conversation = this.get(conversationId)
    if (!conversation) return
    conversation.title = title.trim().slice(0, 200) || conversation.title
    conversation.updatedAt = now()
    await this.persist()
  }

  async remove(conversationId: string): Promise<void> {
    this.state.conversations = this.state.conversations.filter(item => item.id !== conversationId)
    if (this.state.activeId === conversationId) this.state.activeId = this.state.conversations.at(-1)?.id ?? null
    await this.persist()
  }
}
