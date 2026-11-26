export type AutomationEscalation = { id: string; name: string; reason: string }

/** Both routes submit the same input. Pi Durable scopes this receipt to the recipient. */
export function escalationNotice(
  { id, name, reason }: AutomationEscalation,
  event: number | string,
) {
  return {
    text: `Automation ${id} "${name}" escalated: ${reason}`,
    requestId: `automations:${id}:${event}:escalated`,
    entry: { kind: 'automations.escalated', data: { id, name, text: reason } },
  }
}
