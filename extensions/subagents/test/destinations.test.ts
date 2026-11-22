import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import { apis, removeTemp, temp } from '@ultimate/test/helpers.ts'
import { SubagentsWorkflow } from '../api.ts'
import { defaultDestination, destinationAddress } from '../destinations.ts'

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

it('reads the current user and trusted project settings before the optional coding fallback', async () => {
  const home = await temp('ultimate-default-destination-settings-')
  try {
    const notices: string[] = []
    let project: JsonObject = {}
    const services = apis()
    const resolve = defaultDestination({
      ...services,
      userHome: home,
      projectSettings: () => Promise.resolve(project),
      notice: (message) => void notices.push(message),
    })
    expect(await resolve()).toBeUndefined()
    services.implement(SubagentsWorkflow, {
      onDemand: () => true,
      coordinatorName: () => 'ultimate',
    })
    expect(await resolve()).toBe('@ultimate')
    await mkdir(join(home, '.ultimate'))
    await writeFile(
      join(home, '.ultimate/settings.json'),
      JSON.stringify({
        defaultDestination: { kind: 'conversation', address: '@neutral' },
      }),
    )
    expect(await resolve()).toBe('@neutral')
    project = { defaultDestination: { kind: 'conversation', address: '#42' } }
    expect(await resolve()).toBe(42)
    project = {
      defaultDestination: {
        kind: 'channel',
        channel: 'telegram',
        instanceId: 'test',
        address: 'chat',
      },
    }
    expect(await resolve()).toBeUndefined()
    expect(await resolve()).toBeUndefined()
    expect(notices).toEqual([expect.stringContaining('Channel delivery is not supported')])
    project = { defaultDestination: null }
    expect(await resolve()).toBeUndefined()
    expect(notices.at(-1)).toContain('destination must be an object')
    project = {}
    expect(await resolve()).toBe('@neutral')
  } finally {
    await removeTemp(home)
  }
})
