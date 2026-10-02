// The live practice session: wires the mic, the Voice Agent WebSocket and playback together,
// turns raw events into conversation turns, runs the engagement model after each turn and
// steers the persona's mood mid-session with session.update.
import { AgentConnection, type AgentEvent } from "./voice/agent";
import { MicCapture, Player } from "./voice/audio";
import { EchoGuard, type EchoMode } from "./voice/echo";
import { checkGoal, FAREWELL, isQuestion, nextWarmth, scoreTurn, sharedTopic, suggestTip, words, type Signal } from "./engagement";
import {
  hostQaPrompt,
  hostTalkPrompt,
  moodFor,
  personaPrompt,
  talkGreeting,
  TALK_TOPICS,
  type Mood,
  type Persona,
  type Scene,
} from "./scenarios";
import type { RetakePlan } from "./retake";
import { saveRetake, saveSession, type Outcome, type SessionRecord, type WarmthPoint } from "./store";

export interface Line {
  id: string;
  who: "you" | "them";
  text: string;
  final: boolean;
  /** seconds since the session started */
  t: number;
  interrupted?: boolean;
}

export interface LiveState {
  status: "idle" | "connecting" | "live" | "ending" | "ended" | "error";
  error: string | null;
  lines: Line[];
  warmth: number;
  mood: Mood;
  points: WarmthPoint[];
  feed: { id: number; signals: Signal[] } | null;
  goals: Record<string, boolean>;
  tip: string | null;
  speaking: "you" | "them" | null;
  thinking: boolean;
  elapsed: number;
  outcome: Outcome | null;
  recordId: string | null;
  topic: string | null;
  phase: "talk" | "qa" | null;
  /** Talk mode: seconds left in the talk; null while the host is still introducing it. */
  talkLeft: number | null;
  answers: number;
  /** Echo handling: "gated" means the mic is muted while the persona talks (see EchoGuard). */
  echo: EchoMode;
  /** How the persona's voice is played: "webrtc" is call audio, which phones echo-cancel. */
  output: "direct" | "webrtc" | null;
}

const FILLER = /\b(um+|uh+|erm|er)\b/gi;
const VAD_BIAS_MS = 350; // input.speech.started lands a little after speech actually starts
export const TALK_SECONDS = 90;
const THINKING_GIVE_UP_MS = 12000; // replies normally start within 5 s

export class Conversation {
  readonly scene: Scene;
  readonly persona: Persona;
  state: LiveState;

  private listeners = new Set<() => void>();
  private agent = new AgentConnection();
  private mic = new MicCapture();
  private player: Player | null = null;
  private echo = new EchoGuard((t) => this.player?.levelAt(t) ?? 0);
  private micMuted = false;
  private t0 = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private thinkingSince: number | null = null;
  private raf = 0;

  // turn bookkeeping
  private pendingYou = "";
  private youTurns: string[] = [];
  /** Retake: the user's turns before the replayed moment, so the new line is scored in the same context. */
  private earlierYou: string[] = [];
  private pairs: { them: string; you: string }[] = [];
  private lastThem = "";
  private agentEndAt = 0;
  private latency: number | null = null;
  private talkedOver = false;
  private feedId = 0;
  private goalCtx = { talkSeconds: 0, answers: 0 };

  // current persona reply
  private replyLine: Line | null = null;
  private replyFinal: string | null = null;
  private replyStartAt = 0;
  private replyCount = 0;
  private captionQueue: { word: string; at: number }[] = [];
  /** Finished replies whose caption settles when their playback ends, with their final text. */
  private settling = new Map<string, string>();
  private earlyDeltas: { word: string; ms: number | null }[] = [];

  // flow control
  private muteAgent = false; // talk mode: the host stays silent during the talk
  private unmuteOnNextReply = false;
  private qaStartedAt: number | null = null;
  private qaAsked = 0; // questions the host has finished asking
  private lastSample = 0;
  private dropPendingYou = false;
  private afterReply: (() => void) | null = null; // runs once the reply being spoken finishes
  private endOnNextReply: Outcome | null = null;
  private endAt: number | null = null;
  private endDeadline = 0; // ends even if the user is still talking, so a stray partial can't keep it open
  private endOutcome: Outcome = "wrapped-up";
  private leaveAsked = false;
  private wrapAsked = false;
  private talkStartedAt: number | null = null;
  private silenceSince: number | null = null;
  private longestPause = 0;

  /** Retake mode: replay one moment of an earlier conversation, then stop after one exchange. */
  readonly retake: RetakePlan | null;
  private history: string | undefined;

  constructor(scene: Scene, persona: Persona, retake: RetakePlan | null = null) {
    this.scene = scene;
    this.persona = persona;
    this.retake = retake;
    this.history = retake?.context.map((l) => `${l.who === "you" ? "Them" : "You"}: ${l.text}`).join("\n") || undefined;
    this.earlierYou = retake?.context.filter((l) => l.who === "you").map((l) => l.text) ?? [];
    const warmth = retake?.startWarmth ?? scene.profile.baseline;
    this.state = {
      status: "idle",
      error: null,
      lines: [],
      warmth,
      mood: moodFor(warmth),
      points: [],
      feed: null,
      goals: Object.fromEntries(scene.goals.map((g) => [g.id, false])),
      tip: null,
      speaking: null,
      thinking: false,
      elapsed: 0,
      outcome: null,
      recordId: null,
      topic: null,
      phase: scene.kind === "talk" ? "talk" : null,
      talkLeft: null,
      answers: 0,
      echo: "probe",
      output: null,
    };
  }

  // ---------- store plumbing for useSyncExternalStore ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private now = () => (performance.now() - this.t0) / 1000;

  /** Live audio levels for animation, read every frame without re-rendering React. */
  levels() {
    return { you: this.micMuted ? 0 : this.mic.level, them: this.player?.level() ?? 0 };
  }

  // ---------- lifecycle ----------

  async start() {
    if (this.state.status !== "idle") return;
    this.set({ status: "connecting" });
    try {
      // Audio contexts must be created inside the click handler that called start().
      this.player = new Player();
      await this.player.start();
      await this.mic.start();
      this.mic.onChunk = (pcm, rms, at) => this.onMic(pcm, rms, at);
      this.echo.onChange = (echo) => this.set({ echo });
      await this.player.playAsCallAudio();
      this.set({ output: this.player.route });

      const talk = this.scene.kind === "talk";
      const topic = talk ? pick(TALK_TOPICS) : null;
      this.agent.onEvent = (ev) => this.handle(ev);
      this.agent.onDrop = (reason) => void this.finish("dropped", reason);
      await this.agent.connect({
        system_prompt: talk ? hostTalkPrompt(this.persona, topic!) : personaPrompt(this.scene, this.persona, this.state.mood, this.history),
        greeting: talk ? talkGreeting(this.persona, topic!) : (this.retake?.themLine ?? pick(this.scene.greetings)),
        input: {
          transcription_prompt: `${this.scene.setting} A practice conversation with ${this.persona.name}.`,
          keyterms: this.scene.keyterms ?? [this.persona.name],
        },
        output: { voice: this.persona.voice },
      });
      this.t0 = performance.now();
      this.agentEndAt = performance.now();
      this.set({ status: "live", topic });
      this.timer = setInterval(() => this.tick(), 250);
      const frame = () => {
        this.revealCaptions();
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
      addEventListener("pagehide", this.onPageHide);
    } catch (e) {
      await this.teardown();
      this.set({ status: "error", error: friendlyError(e) });
    }
  }

  /** The user pressed "End conversation". */
  end() {
    return this.finish("you-ended");
  }

  /** Talk mode: the talk is over (button or timer); switch the host to Q&A. */
  finishTalk() {
    if (this.state.phase !== "talk" || this.state.status !== "live" || !this.muteAgent || this.unmuteOnNextReply) return;
    this.goalCtx.talkSeconds = this.talkStartedAt === null ? 0 : Math.round(this.now() - this.talkStartedAt);
    this.pendingYou = "";
    this.dropPendingYou = true; // late fragments of the talk aren't an answer
    this.player?.flush();
    this.unmuteOnNextReply = true; // a muted "Mm." may still be in flight; wait for the Q&A reply
    this.qaStartedAt = Math.round(this.now());
    this.agent.update({
      system_prompt: hostQaPrompt(this.persona, this.state.topic ?? ""),
      input: { turn_detection: { min_silence: 1400, max_silence: 4000 } }, // patient, for thinking out loud
    });
    this.agent.reply("Thank them in a few words, then ask your first question about something specific they said.");
    this.set({ phase: "qa", talkLeft: null, thinking: true, speaking: null });
    this.updateGoals();
  }

  private onPageHide = () => this.agent.endNow();

  private onMic(pcm: ArrayBuffer, rms: number, at: number) {
    const audible = this.player?.audibleAt(at) ?? false;
    this.micMuted = this.echo.frame(at, rms, audible);
    this.agent.sendAudio(this.micMuted ? new ArrayBuffer(pcm.byteLength) : pcm); // silence keeps the stream's timing
  }

  private async finish(outcome: Outcome, error?: string) {
    if (this.state.status !== "live" && this.state.status !== "connecting") return;
    // Score what's already been said first, so the room shows the final goals while it wraps up.
    this.settleReplies();
    this.updateGoals(this.muteAgent ? "" : this.pendingYou);
    this.set({ status: "ending" });
    await this.agent.end().catch(() => {});
    await this.teardown();
    this.commitYou();
    if (this.retake) {
      const p = this.state.points[0];
      if (p) saveRetake(this.retake.recordId, this.retake.momentIndex, { said: p.said, delta: p.delta, signals: p.signals, at: Date.now() });
      this.set({ status: "ended", outcome, recordId: this.retake.recordId, speaking: null, thinking: false, error: error ?? null });
      return;
    }
    const record = this.toRecord(outcome);
    saveSession(record);
    this.set({ status: "ended", outcome, recordId: record.id, speaking: null, thinking: false, error: error ?? null });
  }

  private async teardown() {
    if (this.timer) clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    removeEventListener("pagehide", this.onPageHide);
    await this.mic.stop();
    await this.player?.close();
  }

  // ---------- event handling ----------

  private handle(ev: AgentEvent) {
    const now = this.now();
    switch (ev.type) {
      case "input.speech.started": {
        if (this.endAt !== null && this.endOutcome === "wrapped-up" && this.scene.kind === "conversation") this.endAt = null; // they kept talking
        if (!this.pendingYou) {
          const personaTalking = !this.muteAgent && (this.player?.isPlaying() ?? false);
          this.latency = personaTalking ? null : Math.max(0, performance.now() - this.agentEndAt - VAD_BIAS_MS);
        }
        if (this.state.phase === "talk" && this.muteAgent) {
          if (this.talkStartedAt === null) this.talkStartedAt = now;
          if (this.silenceSince !== null) this.longestPause = Math.max(this.longestPause, now - this.silenceSince);
          this.silenceSince = null;
        }
        this.set({ speaking: "you", thinking: false });
        break;
      }
      case "input.speech.stopped":
        if (this.state.phase === "talk" && this.muteAgent) this.silenceSince = now;
        // A late "stopped" can arrive after the reply has started playing; the reply answers it.
        if (this.state.speaking === "you") this.set({ speaking: null, thinking: !this.muteAgent || this.unmuteOnNextReply });
        break;
      case "transcript.user.delta":
        this.upsertLine(ev.item_id, "you", ev.text, false, now);
        break;
      case "transcript.user":
        this.upsertLine(ev.item_id, "you", ev.text, true, now);
        this.pendingYou = `${this.pendingYou} ${ev.text}`.trim();
        // Tick goals as soon as the words are final. The turn itself is scored once the reply starts.
        if (!this.muteAgent && !this.dropPendingYou) this.updateGoals(this.pendingYou);
        if (this.state.phase === "talk" && this.muteAgent) {
          const fillers = (ev.text.match(FILLER) ?? []).length;
          if (fillers) this.nudgeWarmth(-2 * fillers);
        }
        break;
      case "reply.started":
        this.earlyDeltas = [];
        if (this.unmuteOnNextReply) {
          this.unmuteOnNextReply = false;
          this.muteAgent = false;
        }
        if (!this.muteAgent) this.set({ thinking: true });
        break;
      case "reply.audio":
        if (!this.muteAgent && this.player) this.onReplyAudio(ev.data, now);
        break;
      case "transcript.agent.delta":
        if (this.muteAgent) break;
        if (this.replyLine) this.captionQueue.push({ word: ev.delta, at: ev.start_ms == null ? 0 : this.replyStartAt + ev.start_ms });
        else this.earlyDeltas.push({ word: ev.delta, ms: ev.start_ms ?? null });
        break;
      case "transcript.agent":
        if (this.muteAgent || !this.replyLine) break;
        this.replyFinal = ev.text;
        if (ev.interrupted) this.replaceLine(this.replyLine.id, { interrupted: true });
        break;
      case "reply.done":
        this.onReplyDone(ev.status === "interrupted");
        break;
      case "session.error":
        if (["session_expired", "agent_init_failed", "agent_timeout"].includes(ev.code)) void this.finish("dropped", ev.message);
        break;
      case "session.ended":
        if (this.state.status === "live") void this.finish("time-up");
        break;
    }
  }

  private onReplyAudio(data: string, now: number) {
    const startsAt = this.player!.enqueue(data);
    if (this.replyLine) return;
    // First audio of a new reply: the user's turn is complete.
    if (this.dropPendingYou) {
      this.pendingYou = "";
      this.dropPendingYou = false;
    } else this.commitYou();
    if (this.endOnNextReply) {
      const outcome = this.endOnNextReply;
      this.endOnNextReply = null;
      this.afterReply = () => this.scheduleEnd(outcome, 700);
    }
    this.replyStartAt = startsAt;
    this.replyFinal = null;
    this.captionQueue = this.earlyDeltas.map((d) => ({ word: d.word, at: d.ms === null ? 0 : startsAt + d.ms }));
    this.earlyDeltas = [];
    this.replyLine = { id: `r${++this.replyCount}`, who: "them", text: "", final: false, t: now };
    this.set({ lines: [...this.state.lines, this.replyLine], speaking: "them", thinking: false, tip: null });
  }

  private onReplyDone(interrupted: boolean) {
    // Talk mode: after the greeting, the host goes quiet while the user talks.
    if (this.state.phase === "talk" && !this.muteAgent && this.replyCount <= 1) {
      this.muteAgent = true;
      this.silenceSince = this.now();
      // Only a long silence ends the user's turn while they give the talk, so the host doesn't
      // start replying at every pause (those replies would land in the recording).
      this.agent.update({ input: { turn_detection: { min_silence: 6000, max_silence: 10000 } } });
      this.set({ talkLeft: TALK_SECONDS }); // the talk view appears; the clock starts when they speak
    }
    if (interrupted) {
      this.player?.flush();
      // Cutting in right as they start is usually you finishing your own sentence.
      this.talkedOver = performance.now() - this.replyStartAt > 1500;
    }
    if (this.state.phase === "qa" && this.replyLine && !interrupted && this.qaAsked < 2) {
      this.qaAsked++;
      this.agent.update({ system_prompt: hostQaPrompt(this.persona, this.state.topic ?? "", this.qaAsked) });
    }
    this.agentEndAt = this.player?.endsAt() ?? performance.now();

    const line = this.replyLine;
    const after = this.afterReply;
    this.afterReply = null;
    if (line) {
      const final = this.replyFinal ?? line.text;
      const history = [...this.earlierYou, ...this.youTurns];
      this.lastThem = final;
      this.replyLine = null;
      this.settling.set(line.id, final);
      // Keep the caption in step with the voice: settle it when playback ends.
      setTimeout(
        () => {
          this.settling.delete(line.id);
          this.captionQueue = [];
          this.replaceLine(line.id, { text: final, final: true });
          this.updateGoals();
          this.set({
            speaking: this.state.speaking === "them" ? null : this.state.speaking,
            tip: this.scene.kind === "conversation" ? suggestTip(final, history) : null,
          });
          after?.();
        },
        interrupted ? 0 : Math.max(0, this.agentEndAt - performance.now()),
      );
    } else after?.();

    if (!this.leaveAsked && this.scene.kind === "conversation" && this.state.warmth < 15 && this.youTurns.length >= 3) {
      this.leaveAsked = true;
      this.endOnNextReply = "they-left";
      this.agent.reply("You've had enough of this conversation. Politely excuse yourself in one short sentence and say goodbye.");
    }
  }

  private scheduleEnd(outcome: Outcome, delayMs: number) {
    this.endOutcome = outcome;
    this.endAt = performance.now() + delayMs;
    this.endDeadline = this.endAt + 8000;
  }

  /** A user turn is complete once the persona starts answering it. */
  private commitYou() {
    const text = this.pendingYou.trim();
    this.pendingYou = "";
    if (!text || this.muteAgent) return;
    const history = [...this.earlierYou, ...this.youTurns];
    this.youTurns.push(text);
    this.pairs.push({ them: this.lastThem, you: text });

    if (this.scene.kind === "talk") {
      if (this.state.phase === "qa") {
        const answers = this.state.answers + 1;
        this.goalCtx.answers = answers;
        this.set({ answers });
        this.applySignals(scoreAnswer(text, this.lastThem), text);
        if (answers >= 2) this.afterReply = () => this.scheduleEnd("wrapped-up", 900);
      }
    } else {
      const res = scoreTurn(
        { text, prevThem: this.lastThem, personaName: this.persona.name, latencyMs: this.latency, talkedOver: this.talkedOver, history },
        this.scene.profile,
      );
      this.applySignals(res.signals, text, res.delta);
      if (this.retake) this.afterReply = () => this.scheduleEnd("wrapped-up", 500);
      else if (FAREWELL.test(text) && this.youTurns.length >= 2 && !this.leaveAsked) {
        this.afterReply = () => this.scheduleEnd("wrapped-up", 1200);
      }
    }
    this.latency = null;
    this.talkedOver = false;
    this.updateGoals();
  }

  private applySignals(signals: Signal[], said: string, delta?: number) {
    const p = this.scene.profile;
    const d = delta ?? Math.round(signals.reduce((s, x) => s + x.delta * (x.delta > 0 ? p.gain : p.loss), 0));
    const warmth = nextWarmth(this.state.warmth, d, p.baseline);
    const point: WarmthPoint = { t: Math.round(this.now() * 10) / 10, value: warmth, delta: d, signals, said };
    const mood = moodFor(warmth);
    if (mood.id !== this.state.mood.id && this.scene.kind === "conversation") {
      // The persona feels it too: swap the mood line in their system prompt for the next reply.
      this.agent.update({ system_prompt: personaPrompt(this.scene, this.persona, mood, this.history) });
    }
    this.set({ warmth, mood, points: [...this.state.points, point], feed: signals.length ? { id: ++this.feedId, signals } : this.state.feed });
  }

  private nudgeWarmth(delta: number) {
    const warmth = Math.max(0, Math.min(100, Math.round((this.state.warmth + delta) * 10) / 10));
    if (warmth !== this.state.warmth) this.set({ warmth, mood: moodFor(warmth) });
  }

  /** `pending`: the user's words not yet answered, which count for goals before the turn is scored. */
  private updateGoals(pending = "") {
    const them = this.state.lines.filter((l) => l.who === "them" && l.final).map((l) => l.text);
    const you = pending ? [...this.youTurns, pending] : this.youTurns;
    const pairs = pending ? [...this.pairs, { them: this.lastThem, you: pending }] : this.pairs;
    const ctx = { you, them, pairs, ...this.goalCtx };
    const goals = { ...this.state.goals };
    let changed = false;
    for (const g of this.scene.goals) {
      if (!goals[g.id] && checkGoal(g, ctx)) {
        goals[g.id] = true;
        changed = true;
      }
    }
    if (changed) this.set({ goals });
  }

  // ---------- timers ----------

  private tick() {
    if (this.state.status !== "live") return;
    const now = this.now();
    const patch: Partial<LiveState> = { elapsed: Math.floor(now) };

    // The agent sometimes lets a turn pass without replying (a cough, a stray noise). Hand the
    // turn back rather than showing "thinking" forever.
    if (this.state.thinking && !this.replyLine) {
      this.thinkingSince ??= performance.now();
      if (performance.now() - this.thinkingSince > THINKING_GIVE_UP_MS) patch.thinking = false;
    } else this.thinkingSince = null;

    if (this.state.phase === "talk" && this.muteAgent && this.talkStartedAt !== null) {
      const left = Math.max(0, TALK_SECONDS - Math.floor(now - this.talkStartedAt));
      patch.talkLeft = left;
      // Kept current, so "talk for 60 seconds" ticks live and still counts if the session ends mid-talk.
      this.goalCtx.talkSeconds = Math.round(now - this.talkStartedAt);
      this.updateGoals();
      // Audience attention sags during long silences and recovers while you speak.
      if (this.silenceSince !== null && now - this.silenceSince > 3) this.nudgeWarmth(-0.5);
      else if (this.state.speaking === "you" && this.state.warmth < 85) this.nudgeWarmth(0.1);
      if (now - this.lastSample >= 5) {
        this.lastSample = now;
        const prev = this.state.points[this.state.points.length - 1]?.value ?? this.scene.profile.baseline;
        const value = Math.round(this.state.warmth);
        const silent = this.silenceSince !== null && now - this.silenceSince > 3;
        patch.points = [
          ...this.state.points,
          { t: Math.round(now), value, delta: value - prev, signals: silent ? [{ label: "Long silence", delta: value - prev }] : [], said: "", kind: "tick" },
        ];
      }
      if (left === 0 && (this.state.speaking !== "you" || now - this.talkStartedAt > TALK_SECONDS + 8)) {
        this.set(patch);
        this.finishTalk();
        return;
      }
    }

    // Conversations that run long get wrapped up by the persona, before the session's 5-minute cap.
    if (!this.wrapAsked && now > (this.scene.kind === "talk" ? 250 : 240)) {
      this.wrapAsked = true;
      this.endOnNextReply = "time-up";
      this.agent.reply("You need to go now. Wrap up naturally in one short sentence and say goodbye.");
    }
    // Don't cut off the user's own goodbye: wait while they're still talking.
    const userTalking = this.state.speaking === "you" || this.state.lines.some((l) => l.who === "you" && !l.final);
    if (this.endAt !== null && performance.now() >= this.endAt && !(this.player?.isPlaying() ?? false) && (!userTalking || performance.now() >= this.endDeadline)) {
      this.endAt = null;
      void this.finish(this.endOutcome);
      return;
    }
    this.set(patch);
  }

  private revealCaptions() {
    if (!this.replyLine || !this.captionQueue.length) return;
    const t = performance.now();
    let text = this.replyLine.text;
    while (this.captionQueue.length && this.captionQueue[0].at <= t) text = appendWord(text, this.captionQueue.shift()!.word);
    if (text !== this.replyLine.text) this.replaceLine(this.replyLine.id, { text });
  }

  /** Ending mid-reply: show and count the persona's lines in full, as the recording has them. */
  private settleReplies() {
    const settle = new Map(this.settling);
    if (this.replyLine) settle.set(this.replyLine.id, this.replyFinal ?? this.captionQueue.reduce((t, q) => appendWord(t, q.word), this.replyLine.text));
    this.settling.clear();
    this.captionQueue = [];
    if (!settle.size) return;
    if (this.replyLine) this.replyLine = { ...this.replyLine, text: settle.get(this.replyLine.id)!, final: true };
    this.set({ lines: this.state.lines.map((l) => (settle.has(l.id) ? { ...l, text: settle.get(l.id)!, final: true } : l)) });
    this.updateGoals();
  }

  // ---------- lines ----------

  private upsertLine(id: string, who: "you" | "them", text: string, final: boolean, t: number) {
    const idx = this.state.lines.findIndex((l) => l.id === id);
    if (idx === -1) {
      if (text) this.set({ lines: [...this.state.lines, { id, who, text, final, t }] });
      return;
    }
    const lines = this.state.lines.slice();
    lines[idx] = { ...lines[idx], text, final };
    this.set({ lines });
  }

  private replaceLine(id: string, patch: Partial<Line>) {
    if (this.replyLine?.id === id) this.replyLine = { ...this.replyLine, ...patch };
    this.set({ lines: this.state.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  }

  private toRecord(outcome: Outcome): SessionRecord {
    return {
      id: `s${Date.now().toString(36)}`,
      sceneId: this.scene.id,
      personaName: this.persona.name,
      createdAt: Date.now(),
      durationSec: Math.round(this.now()),
      sessionId: this.agent.sessionId,
      outcome,
      lines: this.state.lines.filter((l) => l.text).map(({ who, text, t, interrupted }) => ({ who, text, t, interrupted })),
      points: this.state.points,
      startWarmth: this.scene.profile.baseline,
      finalWarmth: Math.round(this.state.warmth),
      goals: this.state.goals,
      topic: this.state.topic ?? undefined,
      talkSeconds: this.scene.kind === "talk" ? this.goalCtx.talkSeconds : undefined,
      qaStartedAt: this.qaStartedAt ?? undefined,
      longestPause: this.scene.kind === "talk" ? Math.round(this.longestPause * 10) / 10 : undefined,
    };
  }
}

function scoreAnswer(text: string, question: string): Signal[] {
  const n = words(text).length;
  const out: Signal[] = [];
  if (n < 6) out.push({ label: "Very short answer", delta: -6 });
  else if (n <= 90) out.push({ label: "Clear, complete answer", delta: 6 });
  else if (n > 110) out.push({ label: "Rambling answer", delta: -4 });
  const topic = sharedTopic(text, question);
  if (topic && isQuestion(question)) out.push({ label: `Answered the question about “${topic}”`, delta: 4 });
  const fillers = (text.match(FILLER) ?? []).length;
  if (fillers >= 2) out.push({ label: "Filler words", delta: -Math.min(3, fillers) });
  return out;
}

const appendWord = (text: string, w: string) => (text ? `${text}${/^[,.!?;:'’]/.test(w) ? "" : " "}${w}` : w);

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/insecure-context/.test(msg))
    return "Your browser only allows the microphone on secure pages. Open the app over https, or on localhost.";
  if (/Permission|NotAllowed/i.test(msg)) return "Microphone access is blocked. Allow the microphone for this site in your browser's address bar, then try again.";
  if (/NotFound|device not found/i.test(msg)) return "No microphone found. Plug one in or check your sound settings, then try again.";
  return msg;
}
