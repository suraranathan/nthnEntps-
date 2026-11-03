import type { Preferences } from '../src/alex-contract.ts'

// Source locations identify works and translations. Guidance below is paraphrase,
// not an alleged verbatim statement by an ancient author.
export const philosophySources = [
  { name: 'Marcus Aurelius', work: 'Meditations', location: 'Book 7', url: 'https://classics.mit.edu/Antoninus/meditations.7.seven.html', perspective: 'Examine your judgment and act with justice within the present situation.' },
  { name: 'Seneca', work: 'Moral Letters to Lucilius', location: 'Letter 1', url: 'https://en.wikisource.org/wiki/Moral_letters_to_Lucilius/Letter_1', perspective: 'Treat time as a limited resource and choose its use deliberately.' },
  { name: 'Epictetus', work: 'Enchiridion', location: '1', url: 'https://classics.mit.edu/Epictetus/epicench.html', perspective: 'Separate your own choices from outcomes outside your control.' },
  { name: 'Socrates', work: "Plato's Apology", location: '29–30', url: 'https://classics.mit.edu/Plato/apology.html', perspective: 'Test assumptions through questions and care about truth and character.' },
  { name: 'Aristotle', work: 'Nicomachean Ethics', location: 'Book 2', url: 'https://classics.mit.edu/Aristotle/nicomachaen.2.ii.html', perspective: 'Cultivate character by choosing and practicing sound actions.' },
  { name: 'Confucius', work: 'Analects', location: 'Book 1', url: 'https://classics.mit.edu/Confucius/analects.html', perspective: 'Consider relationships, learning, and conduct in context.' },
] as const

export const verifiedQuotations = [
  { author: 'Epictetus', text: 'Some things are in our control and others not.', work: 'Enchiridion', location: '1', translation: 'Elizabeth Carter', url: 'https://classics.mit.edu/Epictetus/epicench.html' },
] as const

export function verifiedQuotation(author: string, text: string) {
  return verifiedQuotations.find(q => q.author === author && q.text === text) ?? null
}

export function philosophyGuidance(preferences: Preferences) {
  if (!preferences.philosophy) return 'Philosophical guidance is disabled. Do not introduce historical philosophical perspectives unless the user explicitly asks to change this preference.'
  return `PHILOSOPHICAL REASONING: Use these source-grounded perspectives only when they help the user's actual question; never insert them mechanically. Compare competing views when useful. Label historical ideas as paraphrases of the named work, and distinguish your own inference as Alex's interpretation. Source index (work, location, URL, paraphrase): ${JSON.stringify(philosophySources)}. Never present a new direct historical quotation from model memory. The only server-verified direct quotation available is ${JSON.stringify(verifiedQuotations)}. For any other requested quotation, offer a paraphrase with a source or say verification is unavailable. Translation wording varies.`
}

const philosopher = /(?:Marcus Aurelius|Seneca|Epictetus|Socrates|Aristotle|Confucius|Stoic(?:s|ism)?|Confucian)/i
const quotation = /[“”"«»]|(?:said|wrote|claimed|quote[d]?)\s*[:,'‘’]/i
const directAttribution = /(?:Marcus Aurelius|Seneca|Epictetus|Socrates|Aristotle|Confucius).{0,40}\b(?:said|wrote|declared|quoted)\b/i
// Fail closed when a model supplies apparent historical quotation text we cannot
// authenticate. The checked quote remains permitted only with its source named.
export function guardPhilosophyReply(reply: string, context = ''): string {
  const philosophicalContext = philosopher.test(reply) || philosopher.test(context) || /\bphilosoph|\bquote\b/i.test(context)
  if (!philosophicalContext || (!quotation.test(reply) && !directAttribution.test(reply))) return reply
  const withoutKnown = verifiedQuotations.reduce((text, q) => text.replaceAll(`“${q.text}”`, '').replaceAll(`"${q.text}"`, ''), reply)
  const quoted = verifiedQuotations.some(q => reply.includes(q.text) && reply.includes(q.author) && reply.includes(q.work) && reply.includes(q.url))
  if (quoted && !/[“”"«»]/.test(withoutKnown)) return reply
  return 'I can discuss these ideas as paraphrases, but I cannot verify the direct quotation in the model response. Please ask for a source-grounded comparison or a verified excerpt.'
}
