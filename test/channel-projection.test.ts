import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import {
  historyCursor,
  historyLimit,
  parseHistoryCursor,
  projectEntry,
  projectConversationOutput,
  projectHistoryScan,
} from '../server/conversation-projection.ts'

const entry = (value: object) => value as EntryRecord

it('projects only public message content and preserves unknown identities', () => {
  expect(
    projectEntry(
      entry({
        id: 1,
        kind: 'pi.user',
        model: [
          {
            role: 'user',
            timestamp: 10,
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image', data: 'abc', mimeType: 'image/png' },
            ],
          },
        ],
      }),
    ),
  ).toEqual({
    entryRef: '1',
    type: 'user',
    timestamp: 10,
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', image: { data: 'abc', mimeType: 'image/png' } },
    ],
  })
  expect(
    projectEntry(
      entry({
        id: 2,
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            timestamp: 11,
            content: [
              { type: 'thinking', thinking: 'secret' },
              { type: 'text', text: 'answer' },
              { type: 'toolCall', name: 'shell', arguments: { secret: 'hidden' } },
            ],
          },
        ],
      }),
    ),
  ).toEqual({
    entryRef: '2',
    type: 'assistant',
    timestamp: 11,
    content: [{ type: 'text', text: 'answer' }],
  })
  expect(
    projectEntry(
      entry({ id: 3, kind: 'pi.compaction', model: [{ role: 'user', content: 'secret summary' }] }),
    ),
  ).toBeUndefined()
  expect(
    projectEntry(
      entry({
        id: 4,
        kind: 'extension.note',
        data: { secret: 'hidden' },
        model: [{ role: 'user', content: 'internal note' }],
      }),
    ),
  ).toEqual({ entryRef: '4', type: 'other', kind: 'extension.note' })
  expect(projectEntry(entry({ id: 5, kind: 'pi.toolResult', data: { secret: 'hidden' } }))).toEqual(
    { entryRef: '5', type: 'tool', kind: 'pi.toolResult' },
  )
})

it('does not expose content from unknown input-marked records', () => {
  expect(
    projectEntry(
      entry({
        id: 6,
        kind: 'extension.private',
        input: true,
        model: [{ role: 'user', content: 'secret' }],
      }),
    ),
  ).toEqual({ entryRef: '6', type: 'other', kind: 'extension.private' })
})

it('validates opaque conversation-scoped cursors and page sizes', () => {
  const cursor = historyCursor(12, 34)
  expect(parseHistoryCursor(cursor, 12)).toBe(34)
  for (const bad of ['', 'garbage', `${cursor}=`, Buffer.from('1:12:0').toString('base64url')])
    expect(() => parseHistoryCursor(bad, 12)).toThrow('Invalid history cursor')
  expect(() => parseHistoryCursor(cursor, 13)).toThrow('Invalid history cursor')
  expect(historyLimit()).toBe(64)
  expect(historyLimit(512)).toBe(512)
  for (const bad of [0, 513, 1.5]) expect(() => historyLimit(bad)).toThrow('Invalid history limit')
})

it('advances the scan across hidden records', () => {
  const result = projectHistoryScan(
    12,
    [entry({ id: 3, kind: 'pi.compaction', model: [{ role: 'user', content: 'hidden' }] })],
    true,
  )
  expect(result.items).toEqual([])
  expect(result.continuation).toBe(result.scanPosition)
  expect(parseHistoryCursor(result.scanPosition!, 12)).toBe(3)
})

it('projects live output without private agent or stream fields', () => {
  const agent = {
    model: { provider: 'provider', modelId: 'model' },
    thinkingLevel: 'high' as const,
    instructions: 'private prompt',
    tools: ['private-tool'],
  }
  const output = projectConversationOutput(
    { id: 12, busy: true, inputAt: 4, answerAt: 5 },
    agent,
    {
      run: { taskId: 7 as never, inputs: [], turns: 0 },
      generation: {
        attempt: 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret' },
            { type: 'text', text: 'public' },
            { type: 'toolCall', id: 'x', name: 'shell', arguments: { secret: 'hidden' } },
          ],
        } as never,
        retry: { at: 1, error: 'private error' },
      },
    },
    34,
  )
  expect(output).toEqual({
    activity: { busy: true, inputAt: 4, answerAt: 5 },
    configuration: { model: { provider: 'provider', modelId: 'model' }, thinkingLevel: 'high' },
    latestHistoryCursor: historyCursor(12, 34),
    inFlight: { streamRef: Buffer.from('12:7:2').toString('base64url'), text: 'public' },
  })
  expect(projectConversationOutput({ id: 12, busy: false }, {}, {})).toEqual({
    activity: { busy: false },
    configuration: {},
  })
})
