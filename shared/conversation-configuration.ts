/** Native conversation configuration records, shared with the extensions that already expose them. */
import { defineDoc } from '@earendil-works/pi-durable'

/** The selected agent definition. Existing child, standing-agent, and ordinary conversations use the same record. */
export const profileDocument = {
  kind: 'ultimate.agent-profile',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation' as const,
  history: 'latest' as const,
  fork: 'initial' as const,
  initial: (): { definition?: string; adhoc?: true } => ({}),
}
export const Profile = defineDoc(profileDocument)

/** The selected model family; null means a direct model choice. Preserve the existing stored shape and fork policy. */
export const familyDocument = {
  kind: 'models.family',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation' as const,
  history: 'latest' as const,
  fork: 'current' as const,
  initial: (): { name: string | null } => ({ name: null }),
}
export const Family = defineDoc(familyDocument)
