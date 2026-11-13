import { expect, it, vi } from 'vitest'

const configure = vi.fn<(change: object, id?: number) => Promise<{ ok: true }>>(async () => ({
  ok: true,
}))
const action = vi.fn<() => Promise<null>>(async () => null)
vi.mock('@/sdk', () => ({ api: { configure, action } }))
const { selectModel } = await import('../../state.tsx')

it('records a direct model choice in one configure request, without a separate family write', async () => {
  await selectModel({ provider: 'faux', id: 'faux-2' } as Parameters<typeof selectModel>[0], 42)
  expect(configure).toHaveBeenCalledOnce()
  expect(configure).toHaveBeenCalledWith({ model: { provider: 'faux', modelId: 'faux-2' } }, 42)
  expect(action).not.toHaveBeenCalled()
})
