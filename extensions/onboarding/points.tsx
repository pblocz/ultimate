/** The points onboarding's browser code renders and other extensions fill. */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

/**
 * More of an open row in the Extensions panel, below its tools and contract (`mcp` lists its servers there). Input is
 * the extension's name; the provider returns null for the others.
 */
export const ExtensionDetails = definePoint<string, ReactNode>('onboarding.extension-details')

/**
 * The coding onboarding the browser starts (the coding workflow provides it): `start` after Get ready, `help` for the
 * project and Git setup links, each resolving with the conversation to show. Undefined while nothing provides it: Get
 * ready then only closes, and the project setup link opens the Extensions panel.
 */
export const SetupWorkflow = definePoint<
  null,
  { start: () => Promise<number>; help: (card: 'project' | 'git') => Promise<number> } | undefined
>('onboarding.setup-workflow')

/**
 * A `setup` card another extension draws (the coding workflow draws `git`); `done` sends the user's choice. Undefined
 * draws nothing for that card.
 */
export const SetupCard = definePoint<
  { card: string; done: (choice: { initialize: boolean }) => Promise<void> },
  ReactNode | undefined
>('onboarding.setup-card')
