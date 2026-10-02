// Live engagement model. Runs in the browser after every user turn, so the meter reacts
// instantly and every change comes with a plain-language reason.
import type { Goal, Scene } from "./scenarios";

export interface Signal {
  label: string;
  delta: number;
}

export interface TurnInput {
  /** What the user said this turn (all fragments merged). */
  text: string;
  /** The persona's line the user was responding to. */
  prevThem: string;
  personaName: string;
  /** How long the user waited before starting to talk, if known. */
  latencyMs: number | null;
  /** The user started talking while the persona was still speaking. */
  talkedOver: boolean;
  /** Earlier user turns, oldest first. */
  history: string[];
}

export interface TurnResult {
  delta: number;
  signals: Signal[];
}

const STOP = new Set(
  "a an the and or but so if then than that this these those there here it its it's i i'm i've i'd i'll me my mine you you're your yours we our us they them their he him his she her hers to of in on at for from with about as by into over just really very so too also not no yes yeah yep okay ok oh well like um uh hmm be is are was were been being am do does did doing done have has had having get got getting go going gone make made can could would should will shall may might must what when where why how who whom which lot lots thing things stuff kind sort bit little much many more most some any all every each other another one two three know think mean guess want say said tell told see look really actually pretty good great nice cool fine sure right maybe probably always never sometimes today tonight tomorrow yesterday now time day week year".split(
    " ",
  ),
);

export const words = (text: string) => text.toLowerCase().match(/[a-z']+/g) ?? [];

const stem = (w: string) => w.replace(/'s$/, "").replace(/(ing|ed|es|s)$/, "");

/** Content words worth following up on, in the order they appear. */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) if (w.length >= 4 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out;
}

export function sharedTopic(a: string, b: string): string | null {
  const bs = new Map(contentWords(b).map((w) => [stem(w), w]));
  for (const w of contentWords(a)) {
    const hit = bs.get(stem(w));
    if (hit) return hit;
  }
  return null;
}

const QUESTION_START = /^((so|and|but|oh|wait|okay|ok|well|yeah|hey)[,\s]+)?(what|how|why|where|when|who|which|do|does|did|are|is|was|were|have|has|can|could|would|will|should|any|anything|got any)\b/i;
// Questions tacked on at the end, which speech recognition often leaves without a question mark.
const TAG_QUESTION = /(\b(how|what) about (you|yours|yourself)|\band (you|yourself)|,\s*you)\W*$/i;
/** A turn merges several sentences, and the question is often the last one: check each. */
export const isQuestion = (text: string) =>
  /\?/.test(text) || TAG_QUESTION.test(text.trim()) || text.split(/[.!;]+/).some((s) => QUESTION_START.test(s.trim()));

/** Goodbyes: "nice meeting you" closes a conversation, "nice to meet you" opens one. */
export const FAREWELL =
  /\b((nice|good|great|lovely) (meeting|talking|chatting)( to| with)? you|catch you (later|around)|see you (around|later|soon)|talk (to you )?(later|soon)|have a (good|great|nice|lovely) (one|day|night|evening|weekend)|take care|bye|goodbye)\b/i;
const CLOSING = /^(thanks|thank you|cheers|bye|later|see (you|ya))\b/i;

const WARM = /\b(cool|nice|love|lovely|awesome|amazing|funny|haha|hah|wow|fun|fascinating|no way|oh really|that's great|sounds great|so good)\b/i;

export function scoreTurn(t: TurnInput, profile: Scene["profile"]): TurnResult {
  const n = words(t.text).length;
  const asked = isQuestion(t.text);
  // Repeating words from their question is answering it; following up means picking up on
  // something they told you.
  const theyAsked = isQuestion(t.prevThem);
  const topic = theyAsked ? null : sharedTopic(t.text, t.prevThem);
  const signals: Signal[] = [];

  if (theyAsked && n >= 5) signals.push({ label: "Answered their question", delta: 2 });
  if (asked && topic) signals.push({ label: `Followed up on “${topic}”`, delta: 8 });
  else if (asked) signals.push({ label: theyAsked ? "Asked something back" : "Asked them a question", delta: 5 });
  else if (topic) signals.push({ label: `Picked up on “${topic}”`, delta: 3 });

  if (n >= 10 && /\b(i|i'm|i've|i'd|my|me|we)\b/i.test(t.text)) signals.push({ label: "Shared something about yourself", delta: 3 });
  if (new RegExp(`\\b${t.personaName}\\b`, "i").test(t.text)) signals.push({ label: "Used their name", delta: 2 });
  if (WARM.test(t.text)) signals.push({ label: "Reacted warmly", delta: 2 });

  const closing = FAREWELL.test(t.text) || CLOSING.test(t.text.trim());
  if (n <= 3 && !asked && !closing) signals.push({ label: "Very short answer", delta: -7 });
  else if (n > 70) signals.push({ label: "Long monologue, leave them room", delta: -4 });
  if (t.latencyMs !== null && t.latencyMs > 5000) signals.push({ label: "Long pause before answering", delta: -3 });
  if (t.talkedOver) signals.push({ label: "Talked over them", delta: -4 });

  const recent = [...t.history.slice(-2), t.text];
  if (t.history.length >= 2 && !closing && !recent.some(isQuestion)) signals.push({ label: "Haven't asked anything in a while", delta: -3 });

  const delta = signals.reduce((sum, s) => sum + s.delta * (s.delta > 0 ? profile.gain : profile.loss), 0);
  return { delta: Math.round(delta), signals };
}

/** Good turns count for less the warmer someone already is: nobody goes from stranger to best friend in five lines. */
export function nextWarmth(current: number, delta: number, baseline: number) {
  const effective = delta > 0 ? delta * (1 - current / 140) : delta;
  const drift = (baseline - current) * 0.06;
  return Math.max(0, Math.min(100, Math.round(current + effective + drift)));
}

/** One short, concrete suggestion for the user's next line, based on what the persona just said. */
export function suggestTip(themLine: string, history: string[]): string {
  if (isQuestion(themLine)) return "Answer, then add one detail about you.";
  const recentAsked = history.slice(-2).some(isQuestion);
  const topics = contentWords(themLine);
  if (topics.length && !recentAsked) return `Ask about “${topics.sort((a, b) => b.length - a.length)[0]}”.`;
  if (!recentAsked) return "Ask them something back.";
  return "Share something small about yourself.";
}

// ---------- goals ----------

export interface GoalContext {
  you: string[]; // user turns
  them: string[]; // persona lines
  pairs: { them: string; you: string }[]; // persona line followed by the user's reply
  talkSeconds: number;
  answers: number;
}

/** Curly apostrophes (common in the persona's text) would break patterns like `i'?m`. */
const plain = (l: string) => l.replace(/[’‘]/g, "'");

export function checkGoal(goal: Goal, c: GoalContext): boolean {
  const g = goal.check;
  switch (g.kind) {
    case "regex":
      return (g.who === "you" ? c.you : c.them).some((l) => g.re.test(plain(l)));
    case "words":
      return (g.who === "you" ? c.you : c.them).some((l) => words(plain(l)).length >= g.min && (!g.re || g.re.test(plain(l))));
    case "question":
      return c.you.some(isQuestion);
    case "followup":
      return c.pairs.some((p) => isQuestion(p.you) && sharedTopic(p.you, p.them) !== null);
    case "turns":
      return c.you.length >= g.min;
    case "talkSeconds":
      return c.talkSeconds >= g.min;
    case "answers":
      return c.answers >= g.min;
  }
}
