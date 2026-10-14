export type Decision = {
  id: string
  question: string
  options: string[]
  detail?: string
  answer?: string
  isDelivered: boolean
  isExpanded: boolean
  // Closed by Claude after the user settled it in the chat.
  isClosedInChat?: boolean
  // `<session tag>:<turn id>` of the main turn that raised it: decisions sharing
  // a group block the same piece of work.
  group?: string
}

declare module 'claude-code' {
  interface PluginState {
    decisions: { list: Decision[]; isResolvedShown: boolean; sessionTag: string; storeKey: string }
  }
}
