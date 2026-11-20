import { expect, it } from 'vitest'
import { destinationAddress } from '../destinations.ts'

it.each([42, '#42', '@neutral'])('accepts the conversation address %s', (address) => {
  expect(destinationAddress({ kind: 'conversation', address })).toBe(
    address === '#42' ? 42 : address,
  )
})
it.each([0, -1, 1.5, '#0', 'title', '', null])('rejects the conversation address %s', (address) => {
  expect(() => destinationAddress({ kind: 'conversation', address })).toThrow('destination.address')
})
it('distinguishes unsupported channel delivery from malformed configuration', () => {
  const channel = { kind: 'channel', channel: 'telegram', instanceId: 'test', address: 'chat' }
  expect(() => destinationAddress(channel)).toThrow('Channel delivery is not supported')
  expect(() => destinationAddress({ ...channel, threadId: 'topic' })).toThrow(
    'Channel delivery is not supported',
  )
  for (const key of ['channel', 'instanceId', 'address'])
    expect(() => destinationAddress({ ...channel, [key]: '' })).toThrow(`destination.${key}`)
  expect(() => destinationAddress({ ...channel, threadId: 42 })).toThrow('destination.threadId')
  expect(() => destinationAddress({ kind: 'other' })).toThrow('destination.kind')
  expect(() => destinationAddress(null)).toThrow('destination must be an object')
})
