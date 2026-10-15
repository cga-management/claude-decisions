import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const RAISE = 'mcp__decisions__raise_decision'
const CLOSE = 'mcp__decisions__close_decision'

const PANE = {
  component: 'Pane' as const,
  requestId: 'decisions',
  props: {
    title: 'Decisions',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, isAtEnd: true },
    view: {},
  } as never,
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

// What the engine answers in a session: registrations, status, toasts, panes,
// the store, Bash, and the prompts the mod submits (recorded).
function stubEngine(on: On, store: Record<string, unknown> = {}) {
  const prompts: string[] = []
  const clock = mock.clock(on)
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => {
    store[e.key] = e.value

    return { value: undefined } as never
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

  return { prompts, clock, store }
}

const decide = (args: string) => ({ command: 'decide', args }) as never

describe('decisions', () => {
  test('a raised decision gets a reference and shows in the pane', async ($, on) => {
    stubEngine(on)
    await $.session.start(START)

    const first = await $.tool.call({ tool: RAISE, question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] })
    const second = await $.tool.call({ tool: RAISE, question: 'Rename the route?' })

    expect(String(first.result)).toContain('Recorded as D1')
    expect(String(second.result)).toContain('Recorded as D2')
    expect(String(second.result)).toContain('D1: Postgres or SQLite?')

    const ui = await $.ui.mount({ plugin: 'decisions', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Open \(2\)/ })).toBeDefined()
    expect(await ui.find({ key: 'answer-D1' })).toBeDefined()
    await ui.unmount()
  })

  test('mid-task, a pane answer reaches Claude on its next tool call, once', async ($, on) => {
    const { prompts } = stubEngine(on)
    await $.session.start(START)
    await $.turn.start({ text: 'build it', turnId: 't1' })

    await $.tool.call({ tool: RAISE, question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] })
    const ui = await $.ui.mount({ plugin: 'decisions', surface: 'terminal', ...PANE })
    await ui.press({ key: 'option-D1-1' })
    expect(await ui.find({ type: 'Text', text: /Open \(0\)/ })).toBeDefined()
    await ui.unmount()

    const next = await $.tool.call({ tool: 'Bash', command: 'true' })
    expect((next.context ?? []).join('\n')).toContain('decision D1')
    expect((next.context ?? []).join('\n')).toContain('SQLite')

    const after = await $.tool.call({ tool: 'Bash', command: 'true' })
    expect((after.context ?? []).join('\n')).not.toContain('decision D1')
    expect(prompts).toHaveLength(0)
  })

  test('/decide records an answer typed against a reference', async ($, on) => {
    stubEngine(on)
    await $.session.start(START)
    await $.tool.call({ tool: RAISE, question: 'Rename the route?' })

    const missing = await $.command.run(decide('D9 yes'))
    expect(missing.text).toContain('No decision D9')

    const done = await $.command.run(decide('d1 yes, call it /v2/items'))
    expect(done.text).toContain('D1 recorded: yes, call it /v2/items')
  })

  test('decisions are saved per project folder and come back in a new session', async ($, on) => {
    const { store } = stubEngine(on, {
      'project:/work/app': [{ id: 'D4', question: 'Keep the old route?', options: [], isDelivered: false, isExpanded: true }],
    })
    await $.session.start({ ...START, cwd: '/work/app' })

    const next = await $.tool.call({ tool: RAISE, question: 'Add a cache?' })
    expect(String(next.result)).toContain('Recorded as D5')
    expect(String(next.result)).toContain('D4: Keep the old route?')
    expect(store['project:/work/app']).toHaveLength(2)
  })

  test('idle, Claude carries on once every decision of the turn is settled', async ($, on) => {
    const { prompts, clock } = stubEngine(on)
    await $.session.start(START)
    await $.tool.call({ tool: RAISE, question: 'Postgres or SQLite?' })
    await $.tool.call({ tool: RAISE, question: 'Rename the route?' })

    await $.command.run(decide('D1 SQLite'))
    await clock.advance(2000)
    expect(prompts).toHaveLength(0)

    await $.command.run(decide('D2 drop'))
    await clock.advance(2000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Decisions answered: D1')
    expect(prompts[0]).toContain('SQLite')
  })

  test('Claude closes a decision settled in chat, without echoing it back or continuing', async ($, on) => {
    const { prompts, clock } = stubEngine(on)
    await $.session.start(START)
    await $.tool.call({ tool: RAISE, question: 'Postgres or SQLite?' })

    const wrong = await $.tool.call({ tool: CLOSE, id: 'D9', outcome: 'SQLite' })
    expect(String(wrong.deny ?? wrong.text)).toContain('not an open decision')

    const closed = await $.tool.call({ tool: CLOSE, id: 'd1', outcome: 'SQLite, said in chat' })
    expect(String(closed.result)).toContain('D1 closed')
    await clock.advance(2000)
    expect(prompts).toHaveLength(0)

    const next = await $.tool.call({ tool: 'Bash', command: 'true' })
    expect((next.context ?? []).join('\n')).not.toContain('decision D1')

    const ui = await $.ui.mount({ plugin: 'decisions', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Open \(0\)/ })).toBeDefined()
    await ui.press({ key: 'toggle-resolved' })
    expect(await ui.find({ type: 'Text', text: /settled in chat/ })).toBeDefined()
    await ui.unmount()
  })

  test('a resolved decision expands to show its background, options and answer', async ($, on) => {
    stubEngine(on)
    await $.session.start(START)
    await $.tool.call({
      tool: RAISE,
      question: 'Postgres or SQLite?',
      options: ['Postgres', 'SQLite'],
      detail: 'SQLite is simpler to deploy.',
    })
    await $.command.run(decide('D1 SQLite'))

    const ui = await $.ui.mount({ plugin: 'decisions', surface: 'terminal', ...PANE })
    await ui.press({ key: 'toggle-resolved' })
    expect(await ui.find({ type: 'Text', text: /SQLite is simpler/ })).toBeUndefined()

    await ui.press({ key: 'toggle-D1' })
    expect(await ui.find({ type: 'Text', text: /SQLite is simpler/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Options: Postgres \| SQLite/ })).toBeDefined()

    await ui.press({ key: 'expand-resolved' })
    expect(await ui.find({ type: 'Text', text: /SQLite is simpler/ })).toBeUndefined()
    await ui.unmount()
  })
})

