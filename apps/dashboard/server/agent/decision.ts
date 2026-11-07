import { createHash } from 'node:crypto'

export type DecisionKind =
  | 'choice'
  | 'classification'
  | 'priority'
  | 'risk'
  | 'boolean'
  | 'probability'
  | 'conditions'
  | 'routing'
  | 'workflow'

export type ConfidenceBand = 'very-low' | 'low' | 'medium' | 'high' | 'very-high'

export interface Confidence {
  value: number
  band: ConfidenceBand
  basis: string
}

export interface Alternative {
  option: string
  score: number
  rejectedBecause: string
}

export interface DecisionEnvelope<T> {
  id: string
  kind: DecisionKind
  question: string
  result: T
  confidence: Confidence
  reasoning: string[]
  alternatives: Alternative[]
  inputs: Record<string, unknown>
  advisoryOnly: true
  engine: {
    name: 'nthn-decision-engine'
    mode: 'deterministic-heuristic'
    inspiredBy: 'jev'
    isJev: false
    performanceClaim: 'none'
  }
  createdAt: string
}

export interface WeightedSignal {
  name: string
  weight: number
  note?: string
}

export interface ChoiceOption<T> {
  value: T
  label: string
  signals?: WeightedSignal[]
}

export interface RiskInput {
  action: string
  dataLoss?: number
  irreversibility?: number
  blastRadius?: number
  privilege?: number
  externalEffect?: number
  uncertainty?: number
  mitigations?: string[]
}

export interface Evidence {
  label: string
  weight: number
  supports: boolean
  note?: string
}

export interface Condition {
  name: string
  actual: unknown
  expected: unknown
  operator?: 'equals' | 'includes' | 'atLeast' | 'atMost' | 'truthy'
}

export interface PriorityItem {
  id: string
  label: string
  impact?: number
  urgency?: number
  effort?: number
  risk?: number
}

export interface PriorityResult {
  ranked: { id: string; label: string; score: number; rationale: string }[]
  top: string | null
}

export interface RoutingResult {
  workflow: string
  tools: string[]
  requiresApproval: boolean
  rationale: string
}

export interface WorkflowStep {
  order: number
  action: string
  tools: string[]
  exitCriteria: string
}

export interface WorkflowResult {
  objective: string
  steps: WorkflowStep[]
  risks: string[]
}

const ENGINE = {
  name: 'nthn-decision-engine',
  mode: 'deterministic-heuristic',
  inspiredBy: 'jev',
  isJev: false,
  performanceClaim: 'none',
} as const

export function clamp(value: number, min = 0, max = 1): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function band(value: number): ConfidenceBand {
  const v = clamp(value)
  if (v < 0.2) return 'very-low'
  if (v < 0.4) return 'low'
  if (v < 0.6) return 'medium'
  if (v < 0.8) return 'high'
  return 'very-high'
}

export function confidence(value: number, basis: string): Confidence {
  const v = Number(clamp(value).toFixed(3))
  return { value: v, band: band(v), basis }
}

function decisionId(kind: DecisionKind, question: string, inputs: unknown): string {
  return createHash('sha256')
    .update(`${kind}\u0000${question}\u0000${JSON.stringify(inputs)}`)
    .digest('hex')
    .slice(0, 16)
}

function envelope<T>(
  kind: DecisionKind,
  question: string,
  result: T,
  conf: Confidence,
  reasoning: string[],
  alternatives: Alternative[],
  inputs: Record<string, unknown>,
): DecisionEnvelope<T> {
  return {
    id: decisionId(kind, question, inputs),
    kind,
    question,
    result,
    confidence: conf,
    reasoning,
    alternatives,
    inputs,
    advisoryOnly: true,
    engine: ENGINE,
    createdAt: new Date().toISOString(),
  }
}

function signalTotal(signals: WeightedSignal[] | undefined): number {
  if (!signals || signals.length === 0) return 0
  let total = 0
  for (const signal of signals) total += clamp(signal.weight) * 1
  return total / signals.length
}

export function choose<T>(
  question: string,
  options: ChoiceOption<T>[],
  context: Record<string, unknown> = {},
): DecisionEnvelope<T | null> {
  if (options.length === 0) {
    return envelope<T | null>(
      'choice', question, null, confidence(0, 'No options were supplied.'),
      ['The decision cannot be made without candidate options.'], [], context,
    )
  }
  const scored = options.map((option, index) => {
    const signals = signalTotal(option.signals)
    const score = Number((signals * 0.9 + (1 - index / Math.max(1, options.length)) * 0.1).toFixed(3))
    return { option, score, signals }
  })
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const second = scored[1]
  const margin = second ? best.score - second.score : best.score
  const conf = confidence(
    clamp(best.score * 0.75 + margin * 0.5),
    'Heuristic weighted signals with a preference for earlier listed options on ties. Not a calibrated probability.',
  )
  const reasoning = [
    `Scored ${options.length} option(s) using weighted signals supplied to the engine.`,
    `Selected "${best.option.label}" with score ${best.score}.`,
    second ? `Runner-up was "${second.option.label}" at ${second.score}; margin ${margin.toFixed(3)}.` : 'No runner-up was supplied.',
    'This is advisory. It does not override permissions, approvals or human review.',
  ]
  return envelope<T | null>(
    'choice', question, best.option.value, conf, reasoning,
    scored.slice(1).map(item => ({
      option: item.option.label,
      score: item.score,
      rejectedBecause: `Lower heuristic score than the selected option (${item.signals.toFixed(3)} signal average).`,
    })),
    context,
  )
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#._\-\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1)
}

export function classify(
  question: string,
  text: string,
  labels: string[],
  context: Record<string, unknown> = {},
): DecisionEnvelope<{ label: string; scores: Record<string, number> }> {
  const tokens = tokenize(text)
  const scores: Record<string, number> = {}
  for (const label of labels) {
    const labelTokens = tokenize(label)
    let hits = 0
    for (const token of tokens) {
      if (labelTokens.some(labelToken => token === labelToken || token.includes(labelToken) || labelToken.includes(token))) {
        hits += 1
      }
    }
    scores[label] = Number((hits / Math.max(1, tokens.length)).toFixed(4))
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const best = ranked[0] ?? ['unclassified', 0]
  const second = ranked[1]?.[1] ?? 0
  const conf = confidence(clamp(0.35 + best[1] * 2 + (best[1] - second)), 'Lexical overlap between the request and label names. Not a semantic model.')
  return envelope(
    'classification', question,
    { label: best[1] > 0 ? best[0] : 'unclassified', scores },
    conf,
    [
      `Compared ${tokens.length} token(s) against ${labels.length} label(s).`,
      best[1] > 0 ? `Best lexical match: "${best[0]}" (${best[1]}).` : 'No label matched; returning unclassified.',
    ],
    ranked.slice(1).map(([label, score]) => ({ option: label, score, rejectedBecause: 'Lower lexical overlap.' })),
    context,
  )
}

export function prioritize(
  items: PriorityItem[],
  context: Record<string, unknown> = {},
): DecisionEnvelope<PriorityResult> {
  const ranked = items.map(item => {
    const impact = clamp(item.impact ?? 0.5)
    const urgency = clamp(item.urgency ?? 0.5)
    const effort = clamp(item.effort ?? 0.5)
    const risk = clamp(item.risk ?? 0.5)
    const score = Number((impact * 0.4 + urgency * 0.35 + (1 - effort) * 0.15 + (1 - risk) * 0.1).toFixed(3))
    return { id: item.id, label: item.label, score, rationale: `impact ${impact}, urgency ${urgency}, effort ${effort}, risk ${risk}` }
  })
  ranked.sort((a, b) => b.score - a.score)
  const best = ranked[0]
  const conf = confidence(
    best ? clamp(0.45 + (best.score - (ranked[1]?.score ?? 0))) : 0,
    'Weighted impact/urgency/effort/risk heuristic. Advisory ordering only.',
  )
  return envelope(
    'priority',
    'Rank the supplied work items by expected value.',
    { ranked, top: best?.id ?? null },
    conf,
    [
      `Ranked ${ranked.length} item(s) with impact 40%, urgency 35%, inverse effort 15%, inverse risk 10%.`,
      best ? `Top item: "${best.label}" (${best.score}).` : 'No items supplied.',
    ],
    ranked.slice(1).map(item => ({ option: item.label, score: item.score, rejectedBecause: 'Lower weighted priority score.' })),
    context,
  )
}

export function assessRisk(
  input: RiskInput,
  context: Record<string, unknown> = {},
): DecisionEnvelope<{ score: number; level: 'low' | 'moderate' | 'high' | 'critical'; factors: Record<string, number>; requiresHumanApproval: boolean }> {
  const factors = {
    dataLoss: clamp(input.dataLoss ?? 0),
    irreversibility: clamp(input.irreversibility ?? 0),
    blastRadius: clamp(input.blastRadius ?? 0),
    privilege: clamp(input.privilege ?? 0),
    externalEffect: clamp(input.externalEffect ?? 0),
    uncertainty: clamp(input.uncertainty ?? 0.3),
  }
  const weights = { dataLoss: 0.25, irreversibility: 0.2, blastRadius: 0.2, privilege: 0.15, externalEffect: 0.1, uncertainty: 0.1 }
  let score = 0
  for (const key of Object.keys(weights) as (keyof typeof weights)[]) score += factors[key] * weights[key]
  const mitigationDiscount = Math.min(0.25, (input.mitigations?.length ?? 0) * 0.05)
  score = clamp(score - mitigationDiscount)
  const level = score < 0.25 ? 'low' : score < 0.5 ? 'moderate' : score < 0.75 ? 'high' : 'critical'
  const conf = confidence(
    clamp(0.5 + (input.mitigations?.length ?? 0) * 0.03),
    'Risk factors are heuristic estimates supplied by the caller; the result is not a security audit.',
  )
  return envelope(
    'risk',
    `Assess risk for: ${input.action}`,
    { score: Number(score.toFixed(3)), level, factors, requiresHumanApproval: level === 'high' || level === 'critical' },
    conf,
    [
      `Computed weighted risk ${score.toFixed(3)} across ${Object.keys(factors).length} factors.`,
      mitigationDiscount > 0 ? `Applied ${mitigationDiscount.toFixed(2)} discount for stated mitigations.` : 'No mitigations were supplied.',
      'High or critical results require human approval before execution.',
    ],
    [],
    { ...context, action: input.action },
  )
}

export function booleanDecision(
  question: string,
  evidence: Evidence[],
  context: Record<string, unknown> = {},
): DecisionEnvelope<{ answer: boolean; support: number; opposition: number }> {
  let support = 0
  let opposition = 0
  let total = 0
  for (const item of evidence) {
    const weight = Math.abs(item.weight)
    total += weight
    if (item.supports) support += weight
    else opposition += weight
  }
  const answer = support >= opposition
  const margin = total === 0 ? 0 : Math.abs(support - opposition) / total
  const conf = confidence(clamp(0.4 + margin * 0.6) * (total === 0 ? 0.2 : 1), 'Weighted supporting and opposing evidence supplied by the caller.')
  return envelope(
    'boolean', question, { answer, support: Number(support.toFixed(3)), opposition: Number(opposition.toFixed(3)) },
    conf,
    [
      `Supporting weight ${support.toFixed(3)} versus opposing weight ${opposition.toFixed(3)}.`,
      total === 0 ? 'No evidence was supplied, so confidence is intentionally near zero.' : `Normalized margin ${margin.toFixed(3)}.`,
    ],
    [],
    context,
  )
}

export function estimateProbability(
  question: string,
  evidence: Evidence[],
  prior = 0.5,
  context: Record<string, unknown> = {},
): DecisionEnvelope<{ probability: number; prior: number; logOdds: number }> {
  const safePrior = clamp(prior, 0.01, 0.99)
  let logOdds = Math.log(safePrior / (1 - safePrior))
  for (const item of evidence) {
    const weight = Math.max(-2, Math.min(2, item.weight))
    const signed = item.supports ? weight : -weight
    logOdds += signed
  }
  const probability = Number((1 / (1 + Math.exp(-logOdds))).toFixed(4))
  const distance = Math.abs(probability - 0.5) * 2
  const conf = confidence(clamp(0.3 + distance * 0.5) * (evidence.length === 0 ? 0.4 : 1), 'Log-odds update over caller-supplied evidence weights. Not a calibrated probability.')
  return envelope(
    'probability', question, { probability, prior: safePrior, logOdds: Number(logOdds.toFixed(4)) },
    conf,
    [
      `Started from prior ${safePrior}.`,
      `Applied ${evidence.length} evidence update(s) in log-odds space.`,
      'The result is an estimate, not a measured frequency. It must not be presented as fact.',
    ],
    [],
    context,
  )
}

export function evaluateConditions(
  question: string,
  conditions: Condition[],
  context: Record<string, unknown> = {},
): DecisionEnvelope<{ allMet: boolean; results: { name: string; met: boolean; actual: unknown; expected: unknown }[] }> {
  const results = conditions.map(condition => {
    const operator = condition.operator ?? 'equals'
    let met = false
    switch (operator) {
      case 'equals': met = condition.actual === condition.expected; break
      case 'includes': met = Array.isArray(condition.actual)
        ? condition.actual.includes(condition.expected)
        : String(condition.actual ?? '').includes(String(condition.expected ?? '')); break
      case 'atLeast': met = Number(condition.actual) >= Number(condition.expected); break
      case 'atMost': met = Number(condition.actual) <= Number(condition.expected); break
      case 'truthy': met = Boolean(condition.actual); break
    }
    return { name: condition.name, met, actual: condition.actual, expected: condition.expected }
  })
  const met = results.filter(item => item.met).length
  const allMet = results.length > 0 && met === results.length
  const conf = confidence(results.length === 0 ? 0 : clamp(0.5 + (met / results.length - 0.5) * 0.5), 'Deterministic rule evaluation; confidence reflects how many conditions are satisfied, not whether the rules are correct.')
  return envelope(
    'conditions', question, { allMet, results }, conf,
    [
      `${met} of ${results.length} condition(s) satisfied.`,
      allMet ? 'All conditions are satisfied.' : 'At least one condition is not satisfied.',
    ],
    [],
    context,
  )
}

export function routeTask(
  need: string,
  context: Record<string, unknown> = {},
): DecisionEnvelope<RoutingResult> {
  const text = need.toLowerCase()
  const rules: { test: RegExp; workflow: string; tools: string[]; approval: boolean; rationale: string }[] = [
    { test: /\b(test|spec|coverage|lint|typecheck|build)\b/, workflow: 'verify', tools: ['run_tests', 'run_command', 'read_file'], approval: false, rationale: 'Verification request detected.' },
    { test: /\b(delete|remove|drop|reset|force|rewrite history|production|deploy|install)\b/, workflow: 'destructive-change', tools: ['request_approval', 'run_command'], approval: true, rationale: 'Potentially destructive or external operation detected.' },
    { test: /\b(edit|change|fix|refactor|implement|add|update|rename)\b/, workflow: 'modify-code', tools: ['read_file', 'search', 'edit_file', 'run_tests'], approval: false, rationale: 'Code change request detected.' },
    { test: /\b(explain|how|why|what|review|inspect|find|locate|search)\b/, workflow: 'investigate', tools: ['list_dir', 'read_file', 'search'], approval: false, rationale: 'Investigation request detected.' },
  ]
  const match = rules.find(rule => rule.test.test(text))
  const result: RoutingResult = match
    ? { workflow: match.workflow, tools: match.tools, requiresApproval: match.approval, rationale: match.rationale }
    : { workflow: 'clarify', tools: [], requiresApproval: false, rationale: 'The request is ambiguous; ask a clarifying question before acting.' }
  const conf = confidence(match ? 0.6 : 0.25, 'Keyword routing. Not a semantic planner.')
  return envelope(
    'routing', `Route request: ${need}`, result, conf,
    [result.rationale, 'Routing only proposes a workflow; permissions are enforced separately.'],
    [], context,
  )
}

export function planWorkflow(
  problem: string,
  context: Record<string, unknown> = {},
): DecisionEnvelope<WorkflowResult> {
  const routing = routeTask(problem, context)
  const steps: WorkflowStep[] = [
    { order: 1, action: 'Restate the objective and identify the relevant files.', tools: ['list_dir', 'search'], exitCriteria: 'Relevant files and constraints are listed.' },
    { order: 2, action: 'Read the current implementation before changing it.', tools: ['read_file'], exitCriteria: 'Current behavior is understood.' },
    { order: 3, action: 'Make the smallest coherent change.', tools: ['edit_file', 'write_file'], exitCriteria: 'Change is applied and reviewed in the diff.' },
    { order: 4, action: 'Verify with the project tests, typecheck and build.', tools: ['run_tests', 'run_command'], exitCriteria: 'Checks pass or failures are explained.' },
    { order: 5, action: 'Report what changed, what was verified, and what remains.', tools: [], exitCriteria: 'Summary is accurate and does not overclaim.' },
  ]
  const risks: string[] = []
  if (routing.result.requiresApproval) risks.push('A destructive or external operation may be required; obtain approval first.')
  risks.push('Do not touch protected infrastructure (bootstrap, Linux rootfs, proot, terminal) without explicit authorization.')
  risks.push('Never fabricate command output, test results or model behavior.')
  return envelope(
    'workflow', problem, { objective: problem, steps, risks },
    confidence(0.55, 'Reusable engineering workflow; it is a checklist, not a guarantee of correctness.'),
    ['Applied a fixed investigate-change-verify-report workflow.', `Initial routing proposal: ${routing.result.workflow}.`, ...risks],
    [], context,
  )
}

export interface DecisionEngine {
  choose: typeof choose
  classify: typeof classify
  prioritize: typeof prioritize
  assessRisk: typeof assessRisk
  boolean: typeof booleanDecision
  probability: typeof estimateProbability
  conditions: typeof evaluateConditions
  route: typeof routeTask
  workflow: typeof planWorkflow
}

export const decisionEngine: DecisionEngine = {
  choose,
  classify,
  prioritize,
  assessRisk,
  boolean: booleanDecision,
  probability: estimateProbability,
  conditions: evaluateConditions,
  route: routeTask,
  workflow: planWorkflow,
}
