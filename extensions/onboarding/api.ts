/**
 * Onboarding: first-run settings, project trust and the Extensions panel. Core tier: generic settings depend on it.
 * The coding workflow provides its walkthrough and primary-agent setup through the optional `onboarding.workflow` point.
 */
import { defineDoc } from '@earendil-works/pi-durable'
import { defineApi } from '@ultimate/shared/extension-api.ts'
import { StartsDoc } from './refs.ts'

export const tier = 'core'

/** Which conversation started onboarding for each root, and whether Start here was dismissed. */
export const Starts = defineDoc<{ roots: Record<string, number>; dismissed?: boolean }>({
  kind: StartsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: {} }),
})

export type OnboardingWorkflowService = {
  /**
   * Start or continue the coding onboarding of `root`, else of the caller's root; the conversation it runs in.
   * `firstRun` is onboarding's own record: whether this machine has not finished Get ready yet.
   */
  start(
    input: { root?: number; instructions?: string; firstRun: boolean },
    conversationId: number | undefined,
  ): Promise<{ id: number }>
  /** Start the walkthrough without project setup; the conversation it runs in. */
  walkthrough(): Promise<{ id: number }>
  /** Ask the primary agent for help with the project or Git card; the conversation it runs in. */
  help(card: 'project' | 'git'): Promise<{ id: number }>
  /** Why the project folder cannot be isolated yet, or undefined when it can. */
  gitReason(): Promise<string | undefined>
  /** Initialize Git for the project folder, as the Git setup card's choice. */
  setupGit(): Promise<void>
}
/**
 * The coding onboarding the old `start`, `walkthrough` and `help` actions and the Git setup card use; the coding
 * workflow provides it. Without a provider those actions fail before they change state.
 */
export const OnboardingWorkflow = defineApi<OnboardingWorkflowService>()('onboarding.workflow')
