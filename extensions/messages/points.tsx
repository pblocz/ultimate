import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'
import type { Message } from './refs.ts'

/** What shows under a message to the user (`questions` provides its answer card). */
export const MessageAnswers = definePoint<Message, ReactNode>('messages.answers')
/**
 * The `@name` of a conversation that is not a standing agent (workspaces names its lander). Undefined shows a
 * conversation link.
 */
export const AgentName = definePoint<number, string | undefined>('messages.agent-name')
