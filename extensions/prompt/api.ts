/** Prompt: Ultimate's system prompt, project context, skills and reload notes. */
import { defineApi } from '@ultimate/shared/extension-api.ts'
import type { Landing } from './refs.ts'

/** Optional source details for the note at the start of a turn. */
export const BuildDetails = defineApi<{
  /** Read the current revision and, on a build change, the landings since the previous revision. */
  read(
    previous: string | undefined,
    changed: boolean,
  ): Promise<{ head: string; landed: Landing[] } | undefined>
}>()('prompt.build-details')

export const tier = 'core'
