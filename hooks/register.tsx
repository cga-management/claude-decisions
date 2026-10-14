import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision } from '../types'

const PANE = 'decisions'
const TOOL = 'raise_decision'
const CLOSE_TOOL = 'close_decision'
const RESOLVED_KEPT = 30
const CONTINUE_DELAY_MS = 1000
const list = atom({ plugin: 'decisions', key: 'list' } as const, [])
const isResolvedShown = atom({ plugin: 'decisions', key: 'isResolvedShown' } as const, false)
// Survive a hot reload, unlike module variables: which session this is, and
// the store key of the project folder it runs in.
const sessionTag = atom({ plugin: 'decisions', key: 'sessionTag' } as const, '')
const storeKey = atom({ plugin: 'decisions', key: 'storeKey' } as const, '')

const TOOL_DESCRIPTION = [
  'Record a decision the user needs to make, so it is tracked in their Decisions pane instead of getting lost in the chat.',
  'Use it whenever you need the user to choose between approaches, confirm an assumption, or supply information you cannot infer, and you can keep working meanwhile (on other parts, or on a stated default).',
  'Returns a reference like D3. Mention that reference in your reply. The user answers in the pane; the answer arrives as a note in a later tool result or prompt, naming the reference.',
  'Once every decision raised in one turn is answered and you are idle, you are prompted to carry on.',
  'Do not raise the same question twice; check the open list this tool returns.',
  `If the user settles a decision in the chat instead of the pane, call ${CLOSE_TOOL} so it leaves their open list.`,
].join(' ')

const CLOSE_DESCRIPTION = [
  'Close an open decision that was settled outside the Decisions pane: the user answered it in the chat, or it no longer matters.',
  'Give its reference (e.g. D3) and the outcome as the user put it, or why it was withdrawn.',
  'Do not use it to answer a decision yourself; only the user decides.',
].join(' ')

let isBusy = false
let turnId = ''

function nextId(decisions: readonly Decision[]): string {
  const max = decisions.reduce((top, d) => Math.max(top, Number(d.id.slice(1)) || 0), 0)

  return `D${max + 1}`
}

function openOnes(decisions: readonly Decision[]): Decision[] {
  return decisions.filter(d => d.answer === undefined)
}

// Every change goes through here: the pane redraws and the project's copy is saved.
async function setList(
  $: EngineInterface,
  fn: (all: Decision[]) => Decision[],
): Promise<Decision[]> {
  const kept = await update($, list, items => {
    const all = fn(items)
    const resolved = all.filter(d => d.answer !== undefined).slice(-RESOLVED_KEPT)

    return all.filter(d => d.answer === undefined || resolved.includes(d))
  })
  const open = openOnes(kept)
  const key = await read($, storeKey)

  if (key !== '') {
    await $.store.set(key, kept)
  }

  $.ui.status(open.length === 0 ? undefined : `${open.length} open decision${open.length === 1 ? '' : 's'}`)

  return kept
}

// `isDeferred`: a slash command holds a turn of its own, so it cannot submit a
// prompt; the continue check runs once that turn is over.
async function answer(
  $: EngineInterface,
  id: string,
  text: string,
  isDeferred = false,
): Promise<Decision | undefined> {
  const ref = id.trim().toUpperCase()
  const value = text.trim()
  const found = (await read($, list)).find(d => d.id === ref)

  if (!found || value === '') {
    return undefined
  }

  await setList($, all =>
    all.map(d => (d.id === ref ? { ...d, answer: value, isDelivered: false, isExpanded: false } : d)),
  )
  await continueNowOrLater($, isDeferred)

  return { ...found, answer: value }
}

async function dismiss($: EngineInterface, id: string, isDeferred = false): Promise<boolean> {
  const ref = id.trim().toUpperCase()
  const isFound = (await read($, list)).some(d => d.id === ref)

  if (isFound) {
    await setList($, all => all.filter(d => d.id !== ref))
    await continueNowOrLater($, isDeferred)
  }

  return isFound
}

function note(d: Decision): string {
  return (
    `The user recorded decision ${d.id} (question: "${d.question}"): ${d.answer}\n` +
    `Take this into account in the current work, and say briefly how you applied ${d.id}.`
  )
}

// Answers not yet passed to Claude become notes, and are marked delivered.
async function drainAnswers($: EngineInterface): Promise<string[]> {
  const pending = (await read($, list)).filter(d => d.answer !== undefined && !d.isDelivered)

  if (pending.length === 0) {
    return []
  }

  await setList($, all =>
    all.map(d => (pending.some(p => p.id === d.id) ? { ...d, isDelivered: true } : d)),
  )

  return pending.map(note)
}

// While idle, once the work a set of answers was blocking has nothing left
// open in its group, prompt Claude to carry on with those answers.
async function maybeContinue($: EngineInterface): Promise<void> {
  if (isBusy) {
    return
  }

  const all = await read($, list)
  const tag = `${await read($, sessionTag)}:`
  const pending = all.filter(
    d => d.answer !== undefined && !d.isDelivered && d.group?.startsWith(tag) === true,
  )
  const isBlocked = openOnes(all).some(d => pending.some(p => p.group === d.group))

  if (pending.length === 0 || isBlocked) {
    return
  }

  const notes = await drainAnswers($)
  isBusy = true
  void $.prompt.submit({
    text: [
      `Decisions answered: ${pending.map(d => d.id).join(', ')}. Carry on with the work they were blocking.`,
      ...notes,
    ].join('\n\n'),
  })
}

async function continueNowOrLater($: EngineInterface, isDeferred: boolean): Promise<void> {
  if (isDeferred) {
    $.clock.after(CONTINUE_DELAY_MS, () => void maybeContinue($).catch(() => undefined))
  } else {
    await maybeContinue($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await read($, sessionTag)) === '') {
      await update($, sessionTag, () => crypto.randomUUID())
    }

    const key = `project:${e.cwd}`

    if ((await read($, storeKey)) !== key) {
      await update($, storeKey, () => key)
      const saved = await $.store.get(key)
      // A session that already holds decisions (from before this was saved) keeps them.
      await update($, list, current =>
        current.length > 0 || !Array.isArray(saved) ? current : (saved as Decision[]),
      )
    }

    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The decision, phrased as a short, self-contained question.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concrete choices, if any (2 to 4, short labels). Put a recommended one first.',
          },
          detail: {
            type: 'string',
            description: 'One or two lines of context: trade-offs, your default if unanswered.',
          },
        },
        required: ['question'],
      },
    })
    await $.tool.register({
      name: CLOSE_TOOL,
      description: CLOSE_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The reference, e.g. D3.' },
          outcome: {
            type: 'string',
            description: 'What the user decided, in their words, or "withdrawn: <why>".',
          },
        },
        required: ['id', 'outcome'],
      },
    })
    await $.command.register({
      name: 'decide',
      description: 'Record a decision: /decide D2 <your answer>, or /decide D2 drop',
    })
    await $.command.register({
      name: 'decisions',
      description: 'Open the Decisions pane; /decisions clear removes resolved ones',
    })
    await setList($, all => all)

    if (openOnes(await read($, list)).length > 0) {
      void $.ui.open({ id: PANE, title: 'Decisions' })
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    // A subagent's turn starts inside the main one: the group stays the main turn's.
    if (!isBusy) {
      turnId = e.turnId
    }

    isBusy = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      isBusy = false
      // Answers given mid-turn that no later tool call carried.
      await maybeContinue($).catch(() => undefined)
    }

    return done
  })

  on('tool.call', { tool: 'mcp__decisions__close_decision' }, async ($, e) => {
    const input = e as { id?: unknown; outcome?: unknown }
    const ref = typeof input.id === 'string' ? input.id.trim().toUpperCase() : ''
    const outcome = typeof input.outcome === 'string' ? input.outcome.trim() : ''
    const open = openOnes(await read($, list))

    if (!open.some(d => d.id === ref) || outcome === '') {
      const listed = open.map(d => `${d.id}: ${d.question}`).join('\n') || 'none'

      return { deny: `${ref || 'That'} is not an open decision, or the outcome is empty. Open decisions:\n${listed}` }
    }

    // Claude already knows the outcome, so there is nothing to deliver.
    await setList($, all =>
      all.map(d =>
        d.id === ref
          ? { ...d, answer: outcome, isDelivered: true, isExpanded: false, isClosedInChat: true }
          : d,
      ),
    )
    $.ui.toast(`Decision ${ref} closed: ${outcome}`)

    return { result: `${ref} closed with outcome: ${outcome}` }
  })

  on('tool.call', { tool: 'mcp__decisions__raise_decision' }, async ($, e) => {
    const input = e as { question?: unknown; options?: unknown; detail?: unknown }
    const question = typeof input.question === 'string' ? input.question.trim() : ''

    if (question === '') {
      return { deny: 'question is required.' }
    }

    const options = Array.isArray(input.options)
      ? input.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '')
      : []
    const detail = typeof input.detail === 'string' && input.detail.trim() !== '' ? input.detail.trim() : undefined
    const before = await read($, list)
    const id = nextId(before)
    const group = `${await read($, sessionTag)}:${turnId}`
    const decision: Decision = { id, question, options, detail, isDelivered: false, isExpanded: true, group }
    await setList($, all => [...all, decision])
    $.ui.toast(`Decision ${id} raised: ${question}`)
    void $.ui.open({ id: PANE, title: 'Decisions' })

    const open = openOnes(before).map(d => `${d.id}: ${d.question}`)

    return {
      result: [
        `Recorded as ${id}. Refer to it as ${id}; the user answers in their Decisions pane.`,
        open.length > 0 ? `Other open decisions:\n${open.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  })

  // Mid-task delivery: answers ride along with Claude's next main-loop tool result.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (e.agentId !== undefined || ('deny' in ran && ran.deny !== undefined)) {
      return ran
    }

    const notes = await drainAnswers($).catch(() => [])

    return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  })

  // Between turns: answers ride along with the next prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.text.trimStart().startsWith('/')) {
      return next(e)
    }

    const notes = await drainAnswers($).catch(() => [])

    return next(notes.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('command.run', { command: 'decisions' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'clear') {
      const kept = await setList($, all => openOnes(all))

      return { text: `Resolved decisions cleared; ${kept.length} open.` }
    }

    await $.ui.open({ id: PANE, title: 'Decisions' })

    return { text: 'Decisions pane opened.' }
  })

  on('command.run', { command: 'decide' }, async ($, e) => {
    const match = e.args.trim().match(/^(D\d+)\s+([\s\S]+)$/i)
    const [, ref = '', text = ''] = match ?? []

    if (!match) {
      return { text: 'Usage: /decide D2 <your answer>, or /decide D2 drop' }
    }

    if (text.trim().toLowerCase() === 'drop') {
      return (await dismiss($, ref, true))
        ? { text: `${ref.toUpperCase()} dropped.` }
        : { text: `No decision ${ref.toUpperCase()} found.` }
    }

    const done = await answer($, ref, text, true)

    if (!done) {
      return { text: `No decision ${ref.toUpperCase()} found.` }
    }

    return { text: `${done.id} recorded: ${done.answer}. Claude gets it on its next step.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Mobile draws no text field; there the options and /decide still work.
    const Input = 'Input' in elements ? elements.Input : undefined
    const all = await read($, list)
    const open = openOnes(all)
    const resolved = all.filter(d => d.answer !== undefined)
    const isShown = await read($, isResolvedShown)
    const toggle = (id: string) =>
      setList($, items => items.map(d => (d.id === id ? { ...d, isExpanded: !d.isExpanded } : d)))

    return (
      <Box flexDirection="column">
        <Text bold>Open ({open.length})</Text>
        {open.length === 0 && <Text dimColor>No open decisions.</Text>}
        {open.map(d => (
          <Box key={d.id} flexDirection="column" marginBottom={d.isExpanded ? 1 : 0}>
            <Box>
              <Button key={`toggle-${d.id}`} plain onPress={() => toggle(d.id)}>
                {d.isExpanded ? '▾' : '▸'} {d.id}
              </Button>
              <Text wrap={d.isExpanded ? 'wrap' : 'truncate-end'}> {d.question}</Text>
            </Box>
            {d.isExpanded && (
              <Box flexDirection="column" paddingLeft={2}>
                {d.detail !== undefined && <Text italic>{d.detail}</Text>}
                {d.options.length > 0 && (
                  <Box flexWrap="wrap" gap={1}>
                    {d.options.map((option, i) => (
                      <Button
                        key={`option-${d.id}-${i}`}
                        label={option}
                        onPress={() => answer($, d.id, option)}
                      />
                    ))}
                  </Box>
                )}
                {Input !== undefined && (
                  <Input
                    key={`answer-${d.id}`}
                    label="Decision: "
                    placeholder={d.options.length > 0 ? 'pick above or type your own' : 'type your answer'}
                    submitLabel="record"
                    onSubmit={(value: string) => answer($, d.id, value)}
                  />
                )}
                <Button key={`drop-${d.id}`} plain dimColor label="drop" onPress={() => dismiss($, d.id)} />
              </Box>
            )}
          </Box>
        ))}
        {resolved.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Button key="toggle-resolved" plain onPress={() => update($, isResolvedShown, v => !v)}>
              {isShown ? '▾' : '▸'} Resolved ({resolved.length})
            </Button>
            {isShown &&
              resolved.map(d => (
                <Box key={d.id} flexDirection="column" paddingLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {d.id} {d.question}
                  </Text>
                  <Text wrap="wrap">
                    {'  '}→ {d.answer}
                    <Text dimColor>
                      {d.isClosedInChat === true ? ' (settled in chat)' : d.isDelivered ? '' : ' (not yet sent)'}
                    </Text>
                  </Text>
                </Box>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}
