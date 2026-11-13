import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createBuild } from '../server/build.ts'
import { removeTemp, temp } from './helpers.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemp(root)
})
it('keeps definition edits out of code-build notices but still detects code edits', async () => {
  const root = await temp('ultimate-definition-build-')
  roots.push(root)
  const extension = join(root, 'extensions/helper')
  await mkdir(join(extension, 'agents'), { recursive: true })
  await writeFile(join(extension, 'server.ts'), 'export default () => ({name: "helper"})\n')
  const definition = join(extension, 'agents/helper.md')
  await writeFile(definition, 'Original definition\n')
  const build = createBuild(root)
  build.extension('helper')
  build.refresh()
  const initial = build.current().id
  await writeFile(definition, 'Changed definition\n')
  build.extension('helper')
  build.refresh()
  expect(build.current().id).toBe(initial)
  await writeFile(
    join(extension, 'server.ts'),
    'export default () => ({name: "helper", tools: []})\n',
  )
  build.extension('helper')
  build.refresh()
  expect(build.current().id).not.toBe(initial)
  expect(build.current().changed).toEqual(['extensions/helper'])
})
