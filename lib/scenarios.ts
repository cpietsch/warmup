// Scene definitions: who you talk to, where, what you're practicing, and how the persona is prompted.
// Voices were matched to personas by measured pitch (scripts/voice-pitch.mjs).
import { FAREWELL } from "./engagement";

export type Voice = "eve" | "jane" | "anna" | "mary" | "vera" | "michael" | "jean" | "paul" | "george" | "charles";

export interface Persona {
  name: string;
  pronouns: "she/her" | "he/him";
  age: number;
  voice: Voice;
  /** What you know about them before you start. */
  intro: string;
  /** Private details for the prompt, revealed only when asked. */
  bio: string;
  style: string;
  /** Portrait for the orb and avatars: a round illustration on a transparent square, whose circle
   *  fills the orb. Anything outside the circle, like hair, may overlap its edge. */
  portrait?: Portrait;
}

export interface Portrait {
  src: string;
  /** Where the circle sits in the square image, as fractions of its size: diameter, center x,
   *  center y. Measured per image, since each drawing's circle is a little different. */
  circle: [d: number, cx: number, cy: number];
}

/** CSS variables that scale and shift a portrait so its circle exactly fills its round frame. */
export const portraitFit = ({ circle: [d, cx, cy] }: Portrait) =>
  ({ "--pw": `${(100 / d).toFixed(2)}%`, "--px": `${(-cx * 100).toFixed(2)}%`, "--py": `${(-cy * 100).toFixed(2)}%` }) as Record<string, string>;

export type GoalCheck =
  | { kind: "regex"; who: "you" | "them"; re: RegExp }
  | { kind: "words"; who: "you" | "them"; min: number; re?: RegExp }
  | { kind: "question" }
  | { kind: "followup" }
  | { kind: "turns"; min: number }
  | { kind: "talkSeconds"; min: number }
  | { kind: "answers"; min: number };

export interface Goal {
  id: string;
  label: string;
  check: GoalCheck;
}

export type Level = 1 | 2 | 3 | 4 | 5;

export interface Scene {
  id: string;
  level: Level;
  kind: "conversation" | "talk";
  title: string;
  /** Stage direction shown on the briefing and fed to the persona. */
  setting: string;
  blurb: string;
  personas: Persona[]; // more than one = the user picks
  greetings: string[];
  goals: Goal[];
  tips: string[];
  /** Engagement profile: where warmth starts and how easily it moves. */
  profile: { baseline: number; gain: number; loss: number };
  minutes: string;
  extraRules?: string;
  /** Extra lines appended to each mood band, e.g. how they'd answer being asked out. */
  moodExtras?: Partial<Record<MoodId, string>>;
  keyterms?: string[];
  /** OpenMoji code point for the scene (a file in public/emoji/), e.g. "2615" for ☕. */
  emoji: string;
  /** Illustrated backdrop for the live room (a file in public/), shown blurred behind the orb. */
  backdrop?: string;
}

export type MoodId = "leaving" | "bored" | "neutral" | "interested" | "delighted";

export interface Mood {
  id: MoodId;
  min: number;
  /** "Sam {label}" */
  label: string;
  modifier: string;
}

export const MOODS: Mood[] = [
  {
    id: "leaving",
    min: 0,
    label: "is checking out",
    modifier: "You're losing interest fast. Give short, flat answers, don't ask anything back, and look for a polite way out of the conversation.",
  },
  {
    id: "bored",
    min: 22,
    label: "seems a bit bored",
    modifier: "You're a little bored. Keep answers short. Only ask something back if they say something genuinely interesting.",
  },
  {
    id: "neutral",
    min: 42,
    label: "is open",
    modifier: "You're neutral and polite. Answer normally and sometimes add a small detail they could pick up on.",
  },
  {
    id: "interested",
    min: 62,
    label: "is getting interested",
    modifier: "You're enjoying this. Open up a little more, share a small story, and now and then ask them a question back.",
  },
  {
    id: "delighted",
    min: 82,
    label: "is enjoying this",
    modifier: "You're really enjoying this conversation. Be warm and playful, share freely, and show you'd like to keep talking.",
  },
];

export const moodFor = (warmth: number): Mood => [...MOODS].reverse().find((m) => warmth >= m.min) ?? MOODS[0];

// Shared detectors
// Spoken forms as speech recognition writes them, commas included ("Me, too.").
const COMMON_GROUND =
  /\b(me,? too|me,? neither|me as well|mine,? too|us,? too|neither do i|same here|same with me|same for me|so (do|am|have|did) i|likewise|we both|both of us|in common|i know the feeling|(i have|i've got|i had) the same|i('m| am) the same|i('m|'ve|'d| was| am| have| had)? also|no way|i('m| am) (also )?(really )?into|i used to|i('ve| have) (been|done|tried) that)\b|^\W*((oh|yeah|ha|haha)\W+)?same\b|\bi\b[^.?!]{0,60}\b(too|as well)\b/i;
// Every goodbye that can end the session (FAREWELL) also counts as leaving gracefully.
const EXIT = new RegExp(
  `${FAREWELL.source}|\\b(((i'?m |i am )?(gonna|going to|wanna|want to|should|need to|have to|got to|gotta)|i'?ll|let me)( probably| just| quickly| actually)? (go|get going|grab|get|head|find|mingle|say hi|check|run)|(i'?m |i am )?heading (out|off)|leave you to it|let you (go|get back)|see (you|ya)|enjoy (the|your) (party|rest|evening|night))\\b`,
  "i",
);

export const SCENES: Scene[] = [
  {
    id: "cafe",
    emoji: "2615",
    level: 1,
    kind: "conversation",
    title: "Order a coffee",
    setting: "A small neighborhood café on a quiet Tuesday morning. There's no line, and the barista is in a chatty mood.",
    blurb: "Order, answer a bit of small talk, ask something back.",
    personas: [
      {
        name: "Jess",
        pronouns: "she/her",
        age: 26,
        voice: "mary",
        portrait: { src: "/personas/Jess-Persona.png", circle: [0.877, 0.4975, 0.5183] },
        intro: "The barista. Friendly, a little chatty.",
        bio: "You've worked at this café for two years. You're saving up for a trip to Japan in the spring. You're training for your first half marathon and your knees hate you. You think oat milk is overrated but you'd never say that to a customer.",
        style: "Easygoing and upbeat, with a dry sense of humor. You chat while you work.",
      },
    ],
    greetings: ["Hi there, what can I get started for you?", "Morning. What are we having today?"],
    goals: [
      { id: "order", label: "Order a drink", check: { kind: "regex", who: "you", re: /\b(latte|coffee|tea|cappuccino|espresso|americano|mocha|chai|flat white|cold brew|matcha|macchiato|cortado|hot chocolate|frappuccino|i'?ll (have|get|take)|can i (get|have)|could i (get|have)|i'?d like)\b/i } },
      { id: "answer", label: "Answer their small talk with more than a few words", check: { kind: "words", who: "you", min: 9 } },
      { id: "ask", label: "Ask them something back", check: { kind: "question" } },
    ],
    tips: ["It's fine to start with just your order.", "When she asks you something, answer and add one detail."],
    profile: { baseline: 58, gain: 1.2, loss: 0.7 },
    minutes: "2–3 min",
    extraRules:
      "You're working the counter. When they order, repeat it back naturally and ask for their name for the cup. Make light small talk while you make the drink, like asking about their plans for the day. After four or five exchanges the drink is ready: hand it over and wish them a good day.",
    keyterms: ["Jess", "oat milk", "flat white", "cortado", "matcha"],
    backdrop: "/backdrops/cafe.webp", // blurred behind the page, so a small WebP of cafe.png is enough
  },
  {
    id: "coworker",
    emoji: "1F3E2",
    level: 2,
    kind: "conversation",
    title: "Coffee machine small talk",
    setting: "Monday morning at the office coffee machine. You've said hi to this coworker from another team before, but you've never really talked.",
    blurb: "Ask about the weekend, share yours, find something in common.",
    personas: [
      {
        name: "Marcus",
        pronouns: "he/him",
        age: 34,
        voice: "george",
        portrait: { src: "/personas/Marcus.png", circle: [0.881, 0.498, 0.514] },
        intro: "A designer from another team. You've only ever said hi.",
        bio: "You're a product designer. You spent the weekend at your sister's place helping her move, and you're sore. You play five-a-side football on Wednesdays. You've been rewatching an old detective show and you're weirdly invested. You have a two-year-old who wakes up at 5am.",
        style: "Friendly, a bit tired, self-deprecating. You warm up quickly if someone's curious.",
      },
    ],
    greetings: ["Morning. Is this machine broken again, or is it just me?", "Hey. Please tell me this thing still makes coffee."],
    goals: [
      { id: "weekend", label: "Ask about their weekend", check: { kind: "regex", who: "you", re: /\b(weekend|saturday|sunday)\b/i } },
      { id: "share", label: "Share something about yours", check: { kind: "words", who: "you", min: 12, re: /\b(i|my|we)\b/i } },
      { id: "common", label: "Find one thing in common", check: { kind: "regex", who: "you", re: COMMON_GROUND } },
    ],
    tips: ["Monday small talk is low stakes. Nobody expects brilliance.", "If he mentions something specific, ask about that."],
    profile: { baseline: 55, gain: 1.1, loss: 0.9 },
    minutes: "3 min",
    extraRules: "You're waiting for the coffee machine. After a few minutes, your coffee is ready and you head to a meeting.",
    keyterms: ["Marcus"],
    backdrop: "/backdrops/coworker.webp",
  },
  {
    id: "party",
    emoji: "1F389",
    level: 3,
    kind: "conversation",
    title: "Talk to a stranger at a party",
    setting: "A friend's house party on a Saturday night. You're at the snack table next to someone you've never met.",
    blurb: "Learn their name, find common ground, leave gracefully.",
    personas: [
      {
        name: "Sam",
        pronouns: "she/her",
        age: 29,
        voice: "jane",
        portrait: { src: "/personas/Sam.png", circle: [0.915, 0.4996, 0.5203] },
        intro: "Someone at the snack table. You don't know her.",
        bio: "You edit podcasts for a living. You moved to the city a year ago from Portland. You have an anxious rescue dog named Pixel. You just got back from a hiking trip in the mountains. You know the host, Maya, from the climbing gym.",
        style: "Relaxed and a little sarcastic. Warm once someone shows real curiosity.",
      },
    ],
    greetings: [
      "Hey. These chips are dangerously good. Do you know Maya from work or something?",
      "Hi. I think I've eaten half this bowl already. How do you know Maya?",
    ],
    goals: [
      { id: "name", label: "Learn her name", check: { kind: "regex", who: "them", re: /\b(i'?m|i am|name'?s|name is|it'?s|call me)\s+sam\b|^\W*sam\b/i } },
      { id: "common", label: "Find something in common", check: { kind: "regex", who: "you", re: COMMON_GROUND } },
      { id: "exit", label: "Leave the conversation gracefully", check: { kind: "regex", who: "you", re: EXIT } },
    ],
    tips: ["People love talking about the thing they just mentioned.", "Leaving well is a skill: thank her, say where you're going."],
    profile: { baseline: 50, gain: 1, loss: 1 },
    minutes: "3–5 min",
    extraRules: "You don't volunteer your name. If they ask, tell them.",
    keyterms: ["Sam", "Maya", "Pixel", "Portland"],
    backdrop: "/backdrops/party.webp",
  },
  {
    id: "networking",
    emoji: "1F91D",
    level: 4,
    kind: "conversation",
    title: "The quiet one at a networking event",
    setting: "Drinks after the talks at a tech networking event. The person next to you is standing alone, scrolling their phone.",
    blurb: "Get a reserved stranger talking and leave with a way to follow up.",
    personas: [
      {
        name: "Daniel",
        pronouns: "he/him",
        age: 41,
        voice: "charles",
        portrait: { src: "/personas/Daniel.png", circle: [0.923, 0.4988, 0.5179] },
        intro: "Standing alone with a drink. Doesn't look chatty.",
        bio: "You run operations at a company that builds software for shipping ports. Your boss made you come tonight. Secretly you love your work: you once rerouted a whole ship because of a spreadsheet error and saved the company a fortune. You restore old bicycles on weekends. You're British and moved here three years ago.",
        style: "Reserved, dry, and brief at first. You light up when someone asks a specific, curious question, especially about ports or bikes.",
      },
    ],
    greetings: ["Hi.", "Evening."],
    goals: [
      { id: "work", label: "Find out what he actually works on", check: { kind: "regex", who: "you", re: /\b(work(ing)? on|what do you do|your (job|role|company|team|work)|what brings you|what line of work)\b/i } },
      { id: "open", label: "Get him to open up with a longer answer", check: { kind: "words", who: "them", min: 18 } },
      { id: "follow", label: "Leave with a way to follow up", check: { kind: "regex", who: "you", re: /\b(linkedin|e-?mail|cards?|numbers?|contacts?|connect|(keep|stay) in (touch|contact)|follow up|(grab|get) (a )?coffee|coffee sometime|reach out|send you|message you|text you|swap|exchange)\b/i } },
    ],
    tips: ["Short answers aren't rejection. He's just not warmed up yet.", "Specific questions beat general ones."],
    profile: { baseline: 32, gain: 0.9, loss: 1.2 },
    minutes: "3–5 min",
    extraRules: "At first give short answers of a few words. Don't ask questions back until they've asked you something specific and curious.",
    keyterms: ["Daniel", "LinkedIn", "logistics"],
    backdrop: "/backdrops/networking.webp",
  },
  {
    id: "first-date",
    emoji: "1F377",
    level: 4,
    kind: "conversation",
    title: "First date",
    setting: "A wine bar on a Thursday evening. You matched on an app a week ago, and this is your first time meeting in person.",
    blurb: "Skip the interview. Share real stories, find what you both love.",
    personas: [
      {
        name: "Theo",
        pronouns: "he/him",
        age: 31,
        voice: "paul",
        portrait: { src: "/personas/Theo.png", circle: [0.897, 0.4992, 0.5075] },
        intro: "Your date. Chef, British, loves hiking.",
        bio: "You're a chef at a busy restaurant and you've burned your arm more times than you can count. You grew up in Manchester. You're learning to surf and you're terrible at it. You once cooked for a famous musician who sent the soup back. You're a bit nervous too, but you hide it well.",
        style: "Warm, funny, self-deprecating. You have opinions and you don't flatter.",
      },
      {
        name: "Nina",
        pronouns: "she/her",
        age: 30,
        voice: "anna",
        portrait: { src: "/personas/Nina.png", circle: [0.886, 0.4972, 0.5036] },
        intro: "Your date. Architect, British, loves live music.",
        bio: "You're an architect who designs libraries and schools. You grew up in Bristol. You play bass badly in a band that has had exactly two gigs. You once got lost in Lisbon for a whole day and it was the best day of the trip. You're a bit nervous too, but you hide it well.",
        style: "Witty and curious, a little teasing. You have opinions and you don't flatter.",
      },
    ],
    greetings: [
      "Hi, you made it. I was starting to worry I'd walk up to a total stranger.",
      "Hey, you must be my date. Or this is about to get very awkward.",
    ],
    goals: [
      { id: "deeper", label: "Ask a follow-up about something they said", check: { kind: "followup" } },
      { id: "story", label: "Tell a real story about yourself", check: { kind: "words", who: "you", min: 28, re: /\b(i|my)\b/i } },
      { id: "common", label: "Find something you both love", check: { kind: "regex", who: "you", re: COMMON_GROUND } },
    ],
    tips: ["Rapid-fire questions feel like an interview. Follow one thread instead.", "Stories beat facts. Say what happened, not just what you do."],
    profile: { baseline: 50, gain: 1, loss: 1.1 },
    minutes: "4–6 min",
    extraRules:
      "Keep it respectful and PG. You get bored by interview-style questions asked one after another, and by bragging. You warm up to curiosity, humor, and real stories.",
    keyterms: ["Theo", "Nina", "Manchester", "Bristol", "Lisbon"],
    backdrop: "/backdrops/first-date.webp",
  },
  {
    id: "ask-out",
    emoji: "1F48C",
    level: 5,
    kind: "conversation",
    title: "Ask someone out",
    setting: "A bookstore café on a Sunday afternoon. You've been sharing a table and chatting for a few minutes about the book they're reading.",
    blurb: "Keep it going, then ask them out. Their answer depends on you.",
    personas: [
      {
        name: "Lena",
        pronouns: "she/her",
        age: 28,
        voice: "vera",
        portrait: { src: "/personas/Lena.png", circle: [0.908, 0.4996, 0.4996] },
        intro: "Reading a mystery novel. You've been chatting for a few minutes.",
        bio: "You're a vet nurse. You're reading a mystery novel and you already guessed the killer. You love old films and terrible puns. You moved here last year and you're still finding your people.",
        style: "Bright and quick, with a gentle, teasing humor.",
      },
      {
        name: "Jonah",
        pronouns: "he/him",
        age: 29,
        voice: "jean",
        portrait: { src: "/personas/Jonah.png", circle: [0.91, 0.4992, 0.5142] },
        intro: "Reading a sci-fi novel. You've been chatting for a few minutes.",
        bio: "You're a high school physics teacher. You're reading a sci-fi novel your students recommended. You love board games and bad puns. You moved here last year and you're still finding your people.",
        style: "Calm, warm, and a bit nerdy, with a gentle, teasing humor.",
      },
    ],
    greetings: ["Okay, I have to know. Do you always read the ending first, or is that just me?", "Sorry, I keep laughing at this book. Have you read it?"],
    goals: [
      { id: "going", label: "Keep the conversation going", check: { kind: "turns", min: 4 } },
      { id: "common", label: "Find a shared interest", check: { kind: "regex", who: "you", re: COMMON_GROUND } },
      { id: "ask", label: "Ask them out clearly", check: { kind: "regex", who: "you", re: /\b((would|do) you (maybe )?(like|want|wanna) to (grab|get|go|hang|see|meet|have)|(wanna|want to) (grab|get|go|hang|see|meet|have)|(can|could|may) i (get|have) your (number|insta(gram)?)|(can|could|may) i take you|take you (out|to)|up for (a )?(coffee|drink|dinner|lunch)|how about (we|a|coffee|dinner|drinks?)|let'?s (grab|get|go)|hang out|are you free|go out|get (a )?(drink|coffee|dinner|lunch) (sometime|together|with me)|see you again|(exchange|swap) numbers)\b/i } },
    ],
    tips: ["Asking someone out is just a clear question. Keep it simple.", "They can say no. The skill is asking kindly and handling either answer."],
    profile: { baseline: 52, gain: 1, loss: 1 },
    minutes: "3–5 min",
    extraRules: "Keep it respectful and PG. Never agree to a date just because they asked; decide based on how you feel right now.",
    moodExtras: {
      leaving: "If they ask you out now, kindly say no.",
      bored: "If they ask you out now, politely decline, say it was nice chatting.",
      neutral: "If they ask you out now, hesitate, then suggest swapping numbers and seeing.",
      interested: "If they ask you out now, say yes and suggest something specific.",
      delighted: "If they ask you out now, say yes happily and suggest something specific.",
    },
    keyterms: ["Lena", "Jonah"],
    backdrop: "/backdrops/ask-out.webp",
  },
  {
    id: "stage",
    emoji: "1F3A4",
    level: 5,
    kind: "talk",
    title: "Speak on the spot",
    setting: "A small evening meetup with about forty people. The host calls you up and hands you a random topic.",
    blurb: "Talk for 90 seconds on a random topic, then take two questions.",
    personas: [
      {
        name: "Priya",
        pronouns: "she/her",
        age: 38,
        voice: "eve",
        portrait: { src: "/personas/Priya.png", circle: [0.924, 0.4971, 0.4904] },
        intro: "The host. Kind, but her audience asks sharp questions.",
        bio: "You host a monthly meetup where people give surprise talks. You're encouraging but honest, and you ask questions that make people think.",
        style: "Warm, crisp, and a little playful. Clear stage-host energy.",
      },
    ],
    greetings: [], // built from a random topic at start
    goals: [
      { id: "long", label: "Talk for at least 60 seconds", check: { kind: "talkSeconds", min: 60 } },
      { id: "answers", label: "Answer both audience questions", check: { kind: "answers", min: 2 } },
    ],
    tips: ["Pick one angle and give one example. That's a whole talk.", "A pause feels long to you and normal to the audience."],
    profile: { baseline: 60, gain: 1, loss: 1 },
    minutes: "3–4 min",
    keyterms: ["Priya"],
    backdrop: "/backdrops/stage.webp",
  },
];

export const TALK_TOPICS = [
  "The most underrated invention of all time",
  "Why everyone should learn to cook one great meal",
  "A place that changed how you see the world",
  "Should cities ban cars from their centers?",
  "The best advice you've ever ignored",
  "What makes a good friend",
  "A skill that should be taught in every school",
  "Is it better to be early or exactly on time?",
  "The most interesting thing about your job or studies",
  "Why boredom is good for you",
  "If you could master one instrument overnight",
  "The case for (or against) pineapple on pizza",
];

/** Each level's name, a line about it, and its pastel (the home ladder's steps, the practice list). */
export const LEVELS: Record<Level, { name: string; note: string; tint: string }> = {
  1: { name: "Low stakes", note: "Short, friendly, easy to leave.", tint: "#dce8f8" },
  2: { name: "Familiar faces", note: "People you'll see again.", tint: "#dcebe0" },
  3: { name: "Strangers", note: "Nobody to lean on but you.", tint: "#fae2d4" },
  4: { name: "Higher stakes", note: "Someone to win over.", tint: "#e8e2f5" },
  5: { name: "The big ones", note: "The moments you'd rather avoid.", tint: "#f8edcf" },
};

export const sceneById = (id: string) => SCENES.find((s) => s.id === id);

/** Three at-a-glance traits for the briefing: the stakes, how warm they start, how hard it is. */
export function sceneTraits(s: Scene): { emoji: string; label: string }[] {
  const start = s.profile.baseline;
  return [
    { emoji: s.emoji, label: LEVELS[s.level].name },
    start >= 55
      ? { emoji: "1F331", label: "Friendly vibe" }
      : start >= 45
        ? { emoji: "1F642", label: "Open to a chat" }
        : { emoji: "1F9CA", label: "Slow to warm up" },
    s.level <= 2
      ? { emoji: "1F423", label: "Great for beginners" }
      : s.level === 3
        ? { emoji: "1FA9C", label: "A step up" }
        : s.level === 4
          ? { emoji: "1F9D7", label: "A real stretch" }
          : { emoji: "1F525", label: "Boss level" },
  ];
}

export const pronoun = (p: Persona) => (p.pronouns === "she/her" ? { sub: "she", obj: "her", pos: "her" } : { sub: "he", obj: "him", pos: "his" });

const VOICE_RULES = `Never say "great question", "that's so interesting", "I'd be happy to", or anything an assistant would say. No exclamation marks, no lists, no emojis, no stage directions in brackets.`;

const SAFETY = `If they're rude or creepy, react like a real person would: get cold and end the conversation. If they say something suggesting they're in real danger or crisis, step out of character and gently encourage them to reach out to someone they trust or a local crisis line.`;

export function personaPrompt(scene: Scene, p: Persona, mood: Mood, history?: string): string {
  const extra = scene.moodExtras?.[mood.id];
  const earlier = history
    ? `\n\nThis conversation already started. What's been said so far (continue from here, never repeat it):\n${history}`
    : "";
  return `You are ${p.name}, ${p.age}. ${scene.setting} You're a real person in this moment, not an assistant, and you never break character.

MOST IMPORTANT: talk like a real person, out loud. One or two short sentences, usually under 20 words. Never lecture, never give advice about how to have a conversation, never ask more than one question at a time.

Who you are: ${p.bio}

How you talk: ${p.style}

How you behave: you don't carry the conversation. Answer what you're asked and sometimes add one small detail they could pick up on. Share the interesting things about yourself only when they ask or follow up. Match their energy: flat answers get short answers, curiosity gets warmth.${scene.extraRules ? `\n\n${scene.extraRules}` : ""}

Right now: ${mood.modifier}${extra ? ` ${extra}` : ""}${earlier}

${SAFETY}

${VOICE_RULES}`;
}

export function hostTalkPrompt(p: Persona, topic: string): string {
  return `You are ${p.name}, the host of a small evening meetup where people give surprise talks. The speaker on stage is now giving a short talk on: "${topic}".

MOST IMPORTANT: do not interrupt the talk. If you're ever prompted to respond while they're talking, say only "Mm." and nothing else. Don't assume the speaker's gender.

${VOICE_RULES}`;
}

/** Q&A host prompt. `asked` is how many questions the host has already asked (the client tracks it). */
export function hostQaPrompt(p: Persona, topic: string, asked = 0): string {
  const step =
    asked === 0
      ? "Right now: thank them in a few words, then ask your first question."
      : asked === 1
        ? "Right now: you've asked your first question. When they answer, react in a few words, then ask your second and final question."
        : "Right now: you've asked both questions. When they answer, don't ask anything else. Thank them, give one honest sentence of encouragement about something specific in their talk, and invite the audience to applaud.";
  return `You are ${p.name}, the host of a small evening meetup. The speaker just gave a short surprise talk on "${topic}", and now you run a quick Q&A with exactly two questions on behalf of the audience. ${p.style}

MOST IMPORTANT: at most one question per turn, in one or two short sentences. Make each question specific to something they actually said, and a little challenging, like a curious audience member would ask.

${step}

Don't assume the speaker's gender: say "our speaker" or "them".

${VOICE_RULES}`;
}

export function talkGreeting(p: Persona, topic: string) {
  return `Hi, welcome up. I'm ${p.name}, I'll be your host. Okay, your topic is: ${topic}. Take a breath and start whenever you're ready. You've got about ninety seconds.`;
}
