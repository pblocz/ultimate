import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { createConversationHost } from '../server/conversation-host.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { historyCursor } from '../server/conversation-projection.ts'
import { UserInputEvent } from '../shared/events.ts'
import { eventHost, temp, until, held } from './helpers.ts'

async function backend() {
  const directory = await temp('ultimate-channel-')
  const prepared = await prepareHarness({
    ultimateRoot: directory,
    projectRoot: directory,
    userHome: directory,
    home: directory,
    faux: fauxProvider(),
  })
  const opened = await prepared.open()
  const service = await createConversationHost(prepared, opened)
  service.openAdmission()
  let closed = false
  return {
    prepared,
    opened,
    service,
    host: service.channelHost,
    async close() {
      if (closed) return
      closed = true
      await service.close()
      await opened.close()
    },
  }
}

it('creates, lists, reads, configures, and catalogs conversations with validated errors', async () => {
  const fixture = await backend()
  try {
    Object.assign(fixture.prepared.faux!.models[0], {
      reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null },
    })
    const created = await fixture.host.conversations.create({ title: 'Second' })
    expect(created.id).toBeGreaterThan(1)
    expect(await fixture.host.conversations.get(created.id)).toMatchObject({
      summary: { id: created.id, title: 'Second', cwd: fixture.prepared.projectRoot },
      configuration: { model: { provider: 'faux', modelId: 'faux-1' } },
    })
    expect((await fixture.host.conversations.list()).map(({ id }) => id)).toContain(created.id)

    expect(
      await fixture.host.conversations.configure(created.id, {
        model: { provider: 'faux', modelId: 'faux-1' },
        thinkingLevel: 'high',
      }),
    ).toEqual({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' })
    await expect(
      fixture.host.conversations.configure(created.id, { thinkingLevel: 'bogus' as never }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      fixture.host.conversations.configure(created.id, {
        model: { provider: 'missing', modelId: 'x' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(fixture.host.conversations.create({ title: '   ' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(fixture.host.conversations.get(999)).rejects.toMatchObject({
      code: 'not_found',
    })

    expect(await fixture.host.models.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'faux',
          id: 'faux-1',
          available: true,
          thinkingLevels: expect.arrayContaining(['off', 'high']),
          cost: expect.objectContaining({ input: expect.any(Number) }),
        }),
      ]),
    )
  } finally {
    await fixture.close()
  }
})

it('deduplicates concurrent and reopened request IDs while allowing identical distinct inputs', async () => {
  const fixture = await backend()
  try {
    fixture.prepared.faux!.setResponses([held, fauxAssistantMessage('Complete')])
    const input = { text: 'same text', requestId: 'request-one' }
    const [first, retry] = await Promise.all([
      fixture.host.conversations.submit(fixture.opened.root.id, input),
      fixture.host.conversations.submit(fixture.opened.root.id, input),
    ])
    expect(retry).toEqual(first)
    await until(
      async () =>
        !!(await fixture.opened.harness.snapshot(LiveDoc, fixture.opened.root.id, context))?.run,
    )
    expect(
      await fixture.host.conversations.submission(first.conversationId, first.submissionId),
    ).toEqual({
      status: 'active',
    })

    await fixture.host.conversations.stop(first.conversationId)
    expect(
      await fixture.host.conversations.submission(first.conversationId, first.submissionId),
    ).toEqual({
      status: 'unanswered',
      reason: 'aborted',
    })
    fixture.prepared.faux!.setResponses([fauxAssistantMessage('Complete')])
    await fixture.close()

    const reopened = await fixture.prepared.open()
    const service = await createConversationHost(fixture.prepared, reopened)
    service.openAdmission()
    try {
      const resumed = await service.channelHost.conversations.submit(reopened.root.id, input)
      expect(resumed).toEqual(first)
      const distinct = await service.channelHost.conversations.submit(reopened.root.id, {
        ...input,
        requestId: 'request-two',
      })
      expect(distinct.submissionId).not.toBe(first.submissionId)
      await until(async () => {
        const state = await service.channelHost.conversations.submission(
          distinct.conversationId,
          distinct.submissionId,
        )
        return state.status === 'answered'
      })
    } finally {
      await service.close()
      await reopened.close()
    }
  } finally {
    await fixture.close()
  }
})

it('records typed source identity after admission without storing submitted text', async () => {
  const fixture = await backend()
  try {
    fixture.prepared.faux!.setResponses([held])
    const result = await fixture.host.conversations.submit(fixture.opened.root.id, {
      text: 'private input text',
      source: {
        channel: 'test-channel',
        instanceId: 'instance-1',
        senderId: 'sender-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        device: 'desktop chrome',
      },
    })
    const records = await eventHost(() => fixture.opened.harness, 'channel-host').eventLog.recent({
      events: [UserInputEvent],
      order: 'ascending',
    })
    expect(records.at(-1)?.data).toMatchObject({
      conversation: fixture.opened.root.id,
      kind: 'prompt',
      source: {
        channel: 'test-channel',
        instanceId: 'instance-1',
        senderId: 'sender-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        device: 'desktop chrome',
      },
      device: 'desktop chrome',
    })
    expect(JSON.stringify(records)).not.toContain('private input text')
    await fixture.host.conversations.stop(result.conversationId)
  } finally {
    await fixture.close()
  }
})

it('validates supported image inputs, including image-only submissions', async () => {
  const fixture = await backend()
  try {
    fixture.prepared.faux!.setResponses([held])
    const id = fixture.opened.root.id
    const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
    const result = await fixture.host.conversations.submit(id, { text: '', images: [image] })
    const conversation = (await fixture.opened.harness.conversation(id, context))!
    const entries = await conversation.entries({}, 10, undefined, context)
    expect(entries.items.find((entry) => entry.kind === 'pi.user')?.model?.[0]).toMatchObject({
      content: [{ type: 'image', ...image }],
    })
    for (const images of [
      [{ ...image, mimeType: 'image/svg+xml' }],
      [{ ...image, data: 'not base64' }],
      Array.from({ length: 5 }, () => image),
      [{ ...image, data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }],
    ])
      await expect(
        fixture.host.conversations.submit(id, { text: '', images }),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    await fixture.host.conversations.stop(result.conversationId)
  } finally {
    await fixture.close()
  }
})

it('reports queued and active states, scopes cancellation, and preserves follow-ups on stop', async () => {
  const fixture = await backend()
  try {
    fixture.prepared.faux!.setResponses([held, fauxAssistantMessage('Complete')])
    const rootId = fixture.opened.root.id
    const other = await fixture.host.conversations.create({})
    const active = await fixture.host.conversations.submit(rootId, { text: 'start' })
    await until(
      async () => !!(await fixture.opened.harness.snapshot(LiveDoc, rootId, context))?.run,
    )
    const activeState = await fixture.host.conversations.submission(rootId, active.submissionId)
    expect(activeState).toEqual({ status: 'active' })
    await expect(
      fixture.host.conversations.cancelQueuedInput(rootId, active.submissionId),
    ).rejects.toMatchObject({ code: 'conflict' })
    const controller = new AbortController()
    const updates = fixture.host.conversations.watch(rootId, { signal: controller.signal })
    const watch = updates[Symbol.asyncIterator]()
    expect((await watch.next()).done).toBe(false)
    controller.abort()
    expect((await watch.next()).done).toBe(true)
    expect((await fixture.opened.harness.snapshot(LiveDoc, rootId, context))?.run).toBeDefined()

    const cancelled = await fixture.host.conversations.submit(rootId, {
      text: 'cancel me',
      whenBusy: 'followUp',
    })
    const kept = await fixture.host.conversations.submit(rootId, {
      text: 'keep me',
      whenBusy: 'followUp',
    })
    expect(await fixture.host.conversations.submission(rootId, cancelled.submissionId)).toEqual({
      status: 'queued',
    })
    await expect(
      fixture.host.conversations.cancelQueuedInput(other.id, cancelled.submissionId),
    ).rejects.toMatchObject({ code: 'not_found' })
    await fixture.host.conversations.cancelQueuedInput(rootId, cancelled.submissionId)
    await fixture.host.conversations.cancelQueuedInput(rootId, cancelled.submissionId)
    expect(await fixture.host.conversations.submission(rootId, cancelled.submissionId)).toEqual({
      status: 'unanswered',
      reason: 'aborted',
    })
    expect((await fixture.opened.harness.snapshot(LiveDoc, rootId, context))?.run).toBeDefined()

    await fixture.host.conversations.stop(rootId)
    expect((await fixture.opened.harness.snapshot(LiveDoc, rootId, context))?.run).toBeUndefined()
    expect(
      (await fixture.opened.harness.snapshot(InboxDoc, rootId, context))?.items.map((item) =>
        item.mode !== 'write' ? item.content : undefined,
      ),
    ).toEqual(['keep me'])
    expect(await fixture.host.conversations.submission(rootId, kept.submissionId)).toEqual({
      status: 'queued',
    })
  } finally {
    await fixture.close()
  }
})

it('projects bounded safe history and coalesced output snapshots without cancelling work', async () => {
  const fixture = await backend()
  try {
    const id = fixture.opened.root.id
    const ids = await fixture.opened.harness.commit(async (tx) => {
      const user = await tx.appendEntry(id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'public input', timestamp: 1 }],
      })
      await tx.appendEntry(id, {
        kind: 'pi.compaction',
        model: [{ role: 'user', content: 'private summary', timestamp: 1 }],
      })
      await tx.appendEntry(id, {
        kind: 'extension.private',
        data: { secret: 'hidden' },
        model: [{ role: 'user', content: 'private extension content', timestamp: 1 }],
      })
      const assistant = await tx.appendEntry(id, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage('public answer', { timestamp: 2 })],
      })
      return { user: user.id, assistant: assistant.id }
    }, context)

    const first = await fixture.host.conversations.history(id, { direction: 'older', limit: 2 })
    expect(first.items).toEqual([
      expect.objectContaining({
        type: 'assistant',
        content: [{ type: 'text', text: 'public answer' }],
      }),
      expect.objectContaining({ type: 'other', kind: 'extension.private' }),
    ])
    expect(first.continuation).toBeDefined()
    expect(JSON.stringify(first)).not.toContain('private summary')
    expect(JSON.stringify(first)).not.toContain('private extension content')
    const second = await fixture.host.conversations.history(id, {
      direction: 'older',
      cursor: first.continuation,
      limit: 2,
    })
    expect(second.items).toEqual([
      expect.objectContaining({ type: 'user', entryRef: String(ids.user) }),
    ])
    await expect(
      fixture.host.conversations.history(id, {
        direction: 'older',
        cursor: historyCursor(id + 1, ids.user),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      fixture.host.conversations.history(id, { direction: 'older', limit: 513 }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    const iterator = fixture.host.conversations.watch(id)[Symbol.asyncIterator]()
    const initialPromise = iterator.next()
    const added = await fixture.opened.harness.commit(
      (tx) =>
        tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'watch update', timestamp: 3 }],
        }),
      context,
    )
    const initial = await initialPromise
    expect(initial.done).toBe(false)
    let snapshot = initial.value!
    if (snapshot.latestHistoryCursor !== historyCursor(id, added.id)) {
      const update = await iterator.next()
      snapshot = update.value!
    }
    expect(snapshot.latestHistoryCursor).toBe(historyCursor(id, added.id))
    expect(JSON.stringify(snapshot)).not.toContain('watch update')
    let lastId = added.id
    for (let index = 0; index < 3; index++) {
      const entry = await fixture.opened.harness.commit(
        (tx) =>
          tx.appendEntry(id, {
            kind: 'pi.user',
            model: [{ role: 'user', content: `coalesced ${index}`, timestamp: index + 4 }],
          }),
        context,
      )
      lastId = entry.id
    }
    const coalesced = await iterator.next()
    expect(coalesced.value?.latestHistoryCursor).toBe(historyCursor(id, lastId))
    await iterator.return?.()
  } finally {
    await fixture.close()
  }
})

it('closes pending watches without cancelling conversation work', async () => {
  const fixture = await backend()
  try {
    fixture.prepared.faux!.setResponses([held])
    const id = fixture.opened.root.id
    await fixture.host.conversations.submit(id, { text: 'keep running' })
    await until(async () => !!(await fixture.opened.harness.snapshot(LiveDoc, id, context))?.run)
    const iterator = fixture.host.conversations.watch(id)[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    const pending = iterator.next()
    const returned = iterator.return!()
    expect((await pending).done).toBe(true)
    expect((await returned).done).toBe(true)
    expect((await fixture.opened.harness.snapshot(LiveDoc, id, context))?.run).toBeDefined()

    const closing = fixture.host.conversations.watch(id)[Symbol.asyncIterator]()
    expect((await closing.next()).done).toBe(false)
    const pendingClose = closing.next()
    await fixture.service.close()
    expect((await pendingClose).done).toBe(true)
    expect((await fixture.opened.harness.snapshot(LiveDoc, id, context))?.run).toBeDefined()
  } finally {
    await fixture.close()
  }
})

it('returns a private compaction operation reference', async () => {
  const fixture = await backend()
  try {
    fixture.prepared.faux!.setResponses([fauxAssistantMessage('A concise summary.')])
    const result = await fixture.host.conversations.compact(fixture.opened.root.id, {
      instructions: 'Keep the main points.',
    })
    expect(result.operationId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result).not.toHaveProperty('taskId')
    await fixture.opened.harness.waitForIdle(context)
  } finally {
    await fixture.close()
  }
})
