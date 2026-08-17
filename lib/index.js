/**
 * dsh-chat — host half.
 *
 * Registers the /api/dsh-chat route family (model directory, conversation
 * store CRUD, streaming chat) and drives plain conversations straight through
 * the harness `ctx.llm` service — no workspace, no tools, no separate model
 * adapter. Whatever providers/models the user already configured in DSH are
 * automatically available. History persists to ~/.dsh/dsh-chat.json.
 *
 * The host half is plain ESM with only node builtins at runtime; `llm` and
 * `webServer` come from the inject list.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chat'

/** The webServer route registry and the llm SDK must exist before mounting. */
export const inject = ['webServer', 'llm']

const API_BASE = '/api/dsh-chat'
const FORMAT_VERSION = 1
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024

/** Store file location: <home>/.dsh/dsh-chat.json. */
function storePath() {
  return join(homedir(), '.dsh', 'dsh-chat.json')
}

/** Error message from an unknown throwable. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Loopback trust fence (same semantics as the dsh-web-ui family host routes):
// these endpoints stream model output and read/write ~/.dsh, so LAN-exposed
// dsh web deployments must not serve them.
// ---------------------------------------------------------------------------
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

// ---------------------------------------------------------------------------
// Small HTTP helpers.
// ---------------------------------------------------------------------------
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** First query-string value, decoded. */
function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Auto-title from the first user message (bounded). */
function titleFrom(text) {
  const oneLine = text.trim().replace(/\s+/g, ' ').slice(0, 40)
  return oneLine === '' ? '新对话' : oneLine
}

/** Title-generation prompt built from the user's first question. */
function titlePromptFrom(text) {
  const oneLine = text.trim().replace(/\s+/g, ' ').slice(0, 500)
  return [
    '你是一个对话标题生成器。根据用户的第一条提问内容,生成一个简洁的对话标题,用于左侧历史列表展示。',
    '要求:与提问使用相同的语言;不超过 20 个字;只输出标题本身,不要引号、不要标点、不要任何解释。',
    '',
    `用户提问: ${oneLine}`,
  ].join('\n')
}

/** Normalize a model-generated title (strip quotes/whitespace, bound length). */
function cleanTitle(text) {
  return String(text ?? '')
    .trim()
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
}

// ---------------------------------------------------------------------------
// Conversation store: one JSON file, written atomically (tmp + rename).
// ---------------------------------------------------------------------------
class ChatStore {
  constructor(path) {
    this.path = path ?? storePath()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.conversations)) {
        return parsed
      }
      throw new Error('store file shape invalid')
    } catch (error) {
      if (error.code === 'ENOENT') return { version: FORMAT_VERSION, conversations: [] }
      // A corrupt store must not brick the plugin: rename it aside and start
      // empty rather than silently overwriting it.
      try { renameSync(this.path, `${this.path}.corrupt-${Date.now()}`) } catch { /* best effort */ }
      return { version: FORMAT_VERSION, conversations: [] }
    }
  }

  save(file) {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }

  list() {
    const file = this.load()
    return file.conversations
      .map(conversation => summarize(conversation))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  find(id) {
    return this.load().conversations.find(conversation => conversation.id === id)
  }

  create(payload) {
    const file = this.load()
    const now = Date.now()
    const conversation = {
      id: randomUUID(),
      title: (payload && typeof payload.title === 'string' && payload.title.trim() !== '')
        ? payload.title.trim().slice(0, 80)
        : '新对话',
      createdAt: now,
      updatedAt: now,
      provider: undefined,
      model: undefined,
      messages: [],
    }
    file.conversations.push(conversation)
    this.save(file)
    return conversation
  }

  /** Append one message to a conversation (re-load → mutate → save). */
  appendMessage(id, message) {
    const file = this.load()
    const conversation = file.conversations.find(candidate => candidate.id === id)
    if (conversation === undefined) throw new Error('conversation not found')
    conversation.messages.push(message)
    conversation.updatedAt = Date.now()
    this.save(file)
    return conversation
  }

  /** Record the last-used model on a conversation. */
  setModel(id, provider, model) {
    const file = this.load()
    const conversation = file.conversations.find(candidate => candidate.id === id)
    if (conversation === undefined) throw new Error('conversation not found')
    conversation.provider = provider
    conversation.model = model
    conversation.updatedAt = Date.now()
    this.save(file)
  }

  rename(id, title) {
    const file = this.load()
    const conversation = file.conversations.find(candidate => candidate.id === id)
    if (conversation === undefined) throw new Error('conversation not found')
    conversation.title = title.slice(0, 80)
    conversation.updatedAt = Date.now()
    this.save(file)
    return summarize(conversation)
  }

  /** Apply an auto-generated title without touching updatedAt (list order stays message-based). */
  setAutoTitle(id, title) {
    const file = this.load()
    const conversation = file.conversations.find(candidate => candidate.id === id)
    if (conversation === undefined) throw new Error('conversation not found')
    conversation.title = title.slice(0, 80)
    this.save(file)
    return summarize(conversation)
  }

  remove(id) {
    const file = this.load()
    const index = file.conversations.findIndex(candidate => candidate.id === id)
    if (index < 0) throw new Error('conversation not found')
    file.conversations.splice(index, 1)
    this.save(file)
  }
}

/** Secret-free projection for the browser (messages are omitted; the client fetches them by id). */
function summarize(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.provider !== undefined ? { provider: conversation.provider } : {}),
    ...(conversation.model !== undefined ? { model: conversation.model } : {}),
  }
}

/**
 * Fire-and-forget AI title generation: summarize the user's first question
 * with the chosen model, then apply it only while the conversation still
 * carries the fallback auto-title (never clobbers a manual rename).
 */
async function generateTitle({ store, llm, conversationId, question, fallbackTitle, providerId, model, signal }) {
  let text = ''
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: titlePromptFrom(question) }],
    },
  ]
  for await (const chunk of llm.stream({ provider: providerId, model, messages, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        throw reason.failure ? new Error(reason.failure.message) : new Error(reason.kind)
      }
    }
  }
  const title = cleanTitle(text)
  if (title === '') return
  const conversation = store.find(conversationId)
  if (conversation !== undefined && conversation.title === fallbackTitle) {
    store.setAutoTitle(conversationId, title)
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------
export function apply(ctx) {
  const store = new ChatStore()

  // GET /api/dsh-chat/models — every registered provider plus its advisory
  // model catalog, straight from ctx.llm (the DSH SDK).
  async function modelsHandler(req, res) {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
    try {
      const providers = ctx.llm.listProviders().map(provider => ({ id: provider.id, name: provider.name }))
      const models = []
      for (const provider of providers) {
        try {
          const list = await ctx.llm.listModels(provider.id)
          for (const item of list) {
            models.push({
              provider: provider.id,
              id: item.id,
              name: item.name,
              ...(item.description !== undefined ? { description: item.description } : {}),
            })
          }
        } catch {
          // A provider that fails to list still keeps its route; just no models.
        }
      }
      writeJson(res, 200, { providers, models })
    } catch (error) {
      writeJson(res, 500, { error: messageOf(error) })
    }
  }

  // GET /api/dsh-chat/conversations          → list summaries
  // GET /api/dsh-chat/conversations?id=      → one full conversation (with messages)
  // POST /api/dsh-chat/conversations         → create { title? }
  // PATCH /api/dsh-chat/conversations?id=    → rename { title }
  // DELETE /api/dsh-chat/conversations?id=   → delete
  async function conversationsHandler(req, res) {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = queryParam(url, 'id')
    try {
      if (method === 'GET') {
        if (id === undefined) return writeJson(res, 200, { conversations: store.list() })
        const conversation = store.find(id)
        if (conversation === undefined) return writeJson(res, 404, { error: 'conversation not found' })
        return writeJson(res, 200, { conversation })
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        return writeJson(res, 201, { conversation: store.create(body) })
      }
      if (method === 'PATCH') {
        if (id === undefined) return writeJson(res, 400, { error: 'id query parameter is required' })
        const body = await readJsonBody(req)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title === '') return writeJson(res, 400, { error: 'title is required' })
        return writeJson(res, 200, { conversation: store.rename(id, title) })
      }
      if (method === 'DELETE') {
        if (id === undefined) return writeJson(res, 400, { error: 'id query parameter is required' })
        store.remove(id)
        return writeJson(res, 200, { ok: true })
      }
      return writeJson(res, 405, { error: 'method not allowed' })
    } catch (error) {
      writeJson(res, 400, { error: messageOf(error) })
    }
  }

  // POST /api/dsh-chat/stream — { conversationId?, provider, model, text }
  // Streams the reply as NDJSON frames; persists both messages on the host.
  async function streamHandler(req, res) {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
    const body = await readJsonBody(req)
    if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const text = typeof body.text === 'string' ? body.text : ''
    if (provider === '' || model === '' || text.trim() === '') {
      return writeJson(res, 400, { error: 'provider, model and text are required' })
    }

    let conversation
    try {
      if (conversationId === '') {
        conversation = store.create({ title: titleFrom(text) })
      } else {
        conversation = store.find(conversationId)
        if (conversation === undefined) throw new Error('conversation not found')
      }
    } catch (error) {
      return writeJson(res, 404, { error: messageOf(error) })
    }

    // Persist the user message up front (and the auto-title on first send).
    store.appendMessage(conversation.id, { role: 'user', content: text, ts: Date.now() })
    if (conversation.title === '新对话') store.rename(conversation.id, titleFrom(text))

    // Fire-and-forget AI title from the user's first question (opt out via
    // titleEnabled: false). Model preference: user-chosen title model, else the
    // chat's own model; failures keep the fallback truncated title.
    if (body.titleEnabled !== false) {
      const titleController = new AbortController()
      const titleTimeout = setTimeout(() => titleController.abort(), 30_000)
      const titleProviderId = typeof body.titleProvider === 'string' && body.titleProvider !== '' ? body.titleProvider : provider
      const titleModel = typeof body.titleModel === 'string' && body.titleModel !== '' ? body.titleModel : model
      if (ctx.llm.listProviders().some(p => p.id === titleProviderId)) {
        generateTitle({
          store,
          llm: ctx.llm,
          conversationId: conversation.id,
          question: text,
          fallbackTitle: titleFrom(text),
          providerId: titleProviderId,
          model: titleModel,
          signal: titleController.signal,
        })
          .catch(() => { /* keep the fallback title on any failure */ })
          .finally(() => clearTimeout(titleTimeout))
      } else {
        clearTimeout(titleTimeout)
      }
    }

    // Assemble the model-facing history from the stored conversation. The
    // harness requires assistant messages to carry their `source` provenance
    // (kind: 'model' + provider/model); rebuilding plain {role, content} here
    // made the runtime's forAdapter() throw on `source.kind` the moment the
    // history contained a stored assistant reply (i.e. from round two on).
    const messages = store.find(conversation.id).messages.map(message => ({
      role: message.role,
      content: [{ type: 'text', text: message.content }],
      ...(message.role === 'assistant'
        ? { source: { kind: 'model', provider: message.provider ?? provider, model: message.model ?? model } }
        : {}),
    }))

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      'referrer-policy': 'no-referrer',
    })
    const emit = (frame) => {
      try { res.write(JSON.stringify(frame) + '\n') } catch { /* client gone */ }
    }

    // Abort the model call if the client disconnects (no wasted tokens).
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    emit({ type: 'meta', conversationId: conversation.id })

    let assistantText = ''
    let settled = false
    const settle = (ok, error) => {
      if (settled) return
      settled = true
      try {
        if (assistantText.length > 0) {
          store.appendMessage(conversation.id, {
            role: 'assistant',
            content: assistantText,
            provider,
            model,
            ts: Date.now(),
          })
        }
        store.setModel(conversation.id, provider, model)
      } catch { /* persistence must not wedge the stream */ }
      emit(ok
        ? { type: 'done', conversationId: conversation.id }
        : { type: 'error', error })
      try { res.end() } catch { /* closed */ }
    }

    try {
      for await (const chunk of ctx.llm.stream({ provider, model, messages, signal: controller.signal })) {
        if (chunk.type === 'text-delta') {
          assistantText += chunk.text
          emit({ type: 'delta', text: chunk.text })
        } else if (chunk.type === 'reasoning-delta') {
          emit({ type: 'reasoning', text: chunk.text })
        } else if (chunk.type === 'usage') {
          emit({ type: 'usage', usage: chunk.usage })
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason.kind === 'error' || reason.kind === 'aborted') {
            settle(false, reason.failure ? reason.failure.message : reason.kind)
          } else {
            settle(true)
          }
          return
        }
      }
      // Stream ended without a finish chunk — treat as complete.
      settle(true)
    } catch (error) {
      settle(false, messageOf(error))
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: API_BASE + '/models', handler: modelsHandler }),
      ctx.webServer.register({ kind: 'exact', path: API_BASE + '/conversations', handler: conversationsHandler }),
      ctx.webServer.register({ kind: 'exact', path: API_BASE + '/stream', handler: streamHandler }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-chat: routes')
}
