"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Emoji from "./Emoji";
import GoalList from "./GoalList";
import InterestGauge from "./InterestGauge";
import { Conversation, TALK_SECONDS, type LiveState } from "@/lib/conversation";
import { mmss } from "@/lib/metrics";
import { planRetake, type RetakePlan } from "@/lib/retake";
import { portraitFit, sceneById, sceneTraits, type Persona, type Scene } from "@/lib/scenarios";
import { getSession } from "@/lib/store";
import { warmthColor } from "@/lib/warmth";

const noSub = () => () => {};
const noSnap = () => null;

export default function Practice({ sceneId }: { sceneId: string }) {
  const scene = sceneById(sceneId)!;
  const [personaIdx, setPersonaIdx] = useState(0);
  const [hints, setHints] = useState(scene.level <= 2);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [retake, setRetake] = useState<RetakePlan | null>(null);
  const state = useSyncExternalStore(conv?.subscribe ?? noSub, conv?.getSnapshot ?? noSnap, noSnap);

  // ?retake=<sessionId>.<momentIndex> replays one moment of an earlier conversation
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("retake");
    if (!q) return;
    const [rid, mi] = q.split(".");
    const rec = getSession(rid);
    const plan = rec && rec.sceneId === scene.id ? planRetake(rec, Number(mi)) : null;
    if (!plan || !rec) return;
    setRetake(plan);
    setPersonaIdx(Math.max(0, scene.personas.findIndex((p) => p.name === rec.personaName)));
  }, [scene]);

  // A full page load, not a client-side navigation: that one needs a server round trip nothing
  // prefetched (the report's id only exists now), which Vercel's firewall or a new deployment can
  // fail, leaving an error page that only a reload fixed. The report reads everything from storage.
  useEffect(() => {
    if (state?.status === "ended" && state.recordId)
      window.location.assign(retake ? `/report/${state.recordId}#moment-${retake.momentIndex}` : `/report/${state.recordId}`);
  }, [state?.status, state?.recordId, retake]);

  // Leaving the page mid-session ends it cleanly (and saves what happened).
  useEffect(
    () => () => {
      if (conv && (conv.state.status === "live" || conv.state.status === "connecting")) void conv.end();
    },
    [conv],
  );

  const start = () => {
    const c = new Conversation(scene, scene.personas[personaIdx], retake);
    setConv(c);
    void c.start();
  };

  if ((!state || state.status === "idle" || state.status === "connecting" || state.status === "error") && retake) {
    return (
      <RetakeBriefing
        scene={scene}
        plan={retake}
        personaName={scene.personas[personaIdx].name}
        onStart={start}
        connecting={state?.status === "connecting"}
        error={state?.status === "error" ? state.error : null}
      />
    );
  }
  if (!state || state.status === "idle" || state.status === "connecting" || state.status === "error") {
    return (
      <Briefing
        scene={scene}
        personaIdx={personaIdx}
        setPersonaIdx={setPersonaIdx}
        hints={hints}
        setHints={setHints}
        onStart={start}
        connecting={state?.status === "connecting"}
        error={state?.status === "error" ? state.error : null}
      />
    );
  }
  return <Room conv={conv!} state={state} hints={hints} setHints={setHints} />;
}

function Briefing(props: {
  scene: Scene;
  personaIdx: number;
  setPersonaIdx: (i: number) => void;
  hints: boolean;
  setHints: (v: boolean) => void;
  onStart: () => void;
  connecting: boolean;
  error: string | null;
}) {
  const { scene, personaIdx } = props;
  const p = scene.personas[personaIdx];
  const traits = sceneTraits(scene);
  return (
    <div className="brief-page">
      {scene.backdrop && <Backdrop src={scene.backdrop} soft />}
      <div className="wrap">
        <Link href="/#scenes" className="link-back">
          ← All scenes
        </Link>
        <div className="brief">
          <div className="brief__head">
            <p className="level-pill">
              Level <b>{scene.level}</b> · {scene.minutes}
            </p>
            <h1 className="display brief__title">{scene.title}</h1>
            <p className="lede">{scene.setting}</p>

            <ul className="traits" aria-label="At a glance">
              {traits.map((t) => (
                <li key={t.label} className="trait">
                  <span className="trait__icon">
                    <Emoji code={t.emoji} size={54} />
                  </span>
                  {t.label}
                </li>
              ))}
            </ul>

            {scene.personas.length > 1 && (
              <fieldset className="choice-set brief__choice">
                <legend className="brief__label">Who you talk to</legend>
                <div className="choice">
                  {scene.personas.map((q, i) => (
                    <label key={q.name} className="choice__opt">
                      <input type="radio" name="persona" checked={i === personaIdx} onChange={() => props.setPersonaIdx(i)} />
                      <span className="choice__name">{q.name}</span>
                      <span className="choice__desc">{q.intro}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>

          <div className="brief__cards">
            <section className="glass-card" aria-labelledby="goals-title">
              <h2 id="goals-title" className="glass-card__title">
                <Emoji code="1F3AF" size={34} />
                Your goals
              </h2>
              <GoalList scene={scene} done={{}} />
            </section>

            <section className="glass-card" aria-labelledby="tips-title">
              <h2 id="tips-title" className="glass-card__title">
                <Emoji code="1F4A1" size={34} />
                Tips before you start
              </h2>
              <ul className="checklist">
                {scene.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          </div>

          <aside className="brief__panel glass-card" aria-label="Start">
            <div className="brief__who">
              <Avatar persona={p} />
              <div>
                <h2 className="h3">{scene.kind === "talk" ? "You'll get a random topic" : `${p.name} speaks first`}</h2>
                <p className="small muted">
                  {p.name}, {p.pronouns}. {p.intro}
                </p>
              </div>
            </div>

            <p className="muted brief__how">
              {scene.kind === "talk"
                ? `Talk for about ${TALK_SECONDS} seconds, then answer two questions. Press "I'm done" when you finish early.`
                : "Just talk, and pause when you're done. There's no button to hold."}
            </p>
            {scene.kind === "conversation" && (
              <label className="toggle">
                <input type="checkbox" checked={props.hints} onChange={(e) => props.setHints(e.target.checked)} />
                Show a hint for what to say next
              </label>
            )}
            <div className="brief__go">
              {props.error && (
                <p className="notice" role="alert">
                  {props.error}
                </p>
              )}
              <button className="btn btn--big" onClick={props.onStart} disabled={props.connecting}>
                {props.connecting ? "Connecting…" : "Start talking"}
              </button>
              <p className="mic-note small muted">
                <Emoji code="1F399" size={22} />
                {props.connecting ? (
                  "Allow the microphone if your browser asks."
                ) : (
                  <>
                    <span className="mic-note__long">Uses your microphone. The conversation is recorded so you can replay it in your report.</span>
                    <span className="mic-note__short">Uses your microphone. Recorded for your replay.</span>
                  </>
                )}
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

/** The scene's illustration, blurred behind the page. `soft` frosts it more, for reading. */
function Backdrop({ src, soft }: { src: string; soft?: boolean }) {
  return (
    <div className={`backdrop${soft ? " backdrop--soft" : ""}`} aria-hidden="true">
      <img src={src} alt="" />
    </div>
  );
}

/** A persona's portrait (or initial) in a small circle. */
function Avatar({ persona }: { persona: Persona }) {
  return (
    <span
      className={`avatar${persona.portrait ? " avatar--portrait" : ""}`}
      style={persona.portrait ? portraitFit(persona.portrait) : undefined}
      aria-hidden="true"
    >
      {persona.portrait ? <Image src={persona.portrait.src} alt="" width={1254} height={1254} sizes="120px" /> : persona.name[0]}
    </span>
  );
}

function RetakeBriefing(props: { scene: Scene; plan: RetakePlan; personaName: string; onStart: () => void; connecting: boolean; error: string | null }) {
  const { scene, plan, personaName } = props;
  return (
    <div className="wrap">
      <Link href={`/report/${plan.recordId}`} className="link-back">
        ← Back to your replay
      </Link>
      <div className="brief brief--simple">
        <div className="brief__main">
          <p className="muted">
            {scene.title} with {personaName}
          </p>
          <h1 className="display" style={{ fontSize: "clamp(2.2rem, 4.6vw, 3.6rem)", maxWidth: "18ch" }}>
            Try this moment again
          </h1>
          <p className="lede">
            {personaName} will say the same line again, remembering everything that came before it. Answer it a new way, hear the reaction, and see
            how it compares.
          </p>
          <div className="brief__block">
            <h2 className="brief__label">{personaName} says</h2>
            <p className="caption caption--them" style={{ fontSize: "1.4rem" }}>
              “{plan.themLine}”
            </p>
          </div>
          <div className="brief__block">
            <h2 className="brief__label">Last time you said</h2>
            <p className="muted">“{plan.oldSaid}”</p>
            {plan.comment && <p>{plan.comment}</p>}
            {plan.better && (
              <p className="note__try">
                <span className="note__try-label">One idea</span>
                {plan.better}
              </p>
            )}
          </div>
        </div>
        <aside className="brief__panel glass-card" aria-label="Start">
          <h2 className="h3">One exchange, then back to your replay</h2>
          <p className="muted">Say your new version when {personaName} finishes. The retake ends after {personaName} reacts.</p>
          {props.error && (
            <p className="notice" role="alert">
              {props.error}
            </p>
          )}
          <button className="btn btn--big" onClick={props.onStart} disabled={props.connecting}>
            {props.connecting ? "Connecting…" : "Start the retake"}
          </button>
        </aside>
      </div>
    </div>
  );
}

function Room({ conv, state, hints, setHints }: { conv: Conversation; state: LiveState; hints: boolean; setHints: (v: boolean) => void }) {
  const { scene, persona } = conv;
  const orbRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLSpanElement>(null);
  const captionsRef = useRef<HTMLDivElement>(null);

  // Start at the top: on a phone you scroll down the briefing to press Start, and the room would
  // otherwise open at that scroll position, with the title and the End button out of view.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" }); // braces: an effect may only return a cleanup
  }, []);

  // Audio levels drive the orb and mic dot every frame without re-rendering React.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const { you, them } = conv.levels();
      orbRef.current?.style.setProperty("--lvl", Math.min(1, them * 5).toFixed(3));
      micRef.current?.style.setProperty("--mic", Math.min(1, you * 4).toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [conv]);

  const talk = scene.kind === "talk";
  const talkView = talk && state.phase === "talk" && state.talkLeft !== null;
  const lastThem = [...state.lines].reverse().find((l) => l.who === "them");
  const lastYou = [...state.lines].reverse().find((l) => l.who === "you");
  const youAfterThem = lastYou && lastThem ? state.lines.indexOf(lastYou) > state.lines.indexOf(lastThem) : !!lastYou;
  const ending = state.status === "ending" || state.status === "ended"; // "ended" shows until the report opens

  // The captions have a fixed height, so the room doesn't jump as words arrive. When a long reply
  // doesn't fit, keep the newest words in view and fade the oldest out at the top, like subtitles.
  const shownThem = lastThem?.text;
  const shownYou = youAfterThem ? lastYou?.text : undefined;
  useEffect(() => {
    const el = captionsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    el.dataset.overflow = String(el.scrollHeight > el.clientHeight + 1);
  }, [shownThem, shownYou]);

  const gaugeLabel = talk ? "Audience attention" : `${persona.name}'s interest`;

  const statusText = ending
    ? "Wrapping up and saving your session…"
    : state.speaking === "you"
      ? "Listening…"
      : state.thinking
        ? `${persona.name} is thinking…`
        : state.speaking === "them"
          ? state.echo === "gated"
            ? `Your mic is paused while ${persona.name} talks, so they don't hear themselves.`
            : ""
          : talkView
            ? state.talkLeft === TALK_SECONDS
              ? "Start whenever you're ready."
              : "Keep going, or press “I'm done”."
            : lastThem
              ? "Your turn. Take your time."
              : "";

  return (
    <div
      className={`room${scene.backdrop ? " room--scene" : ""}`}
      data-echo={state.echo}
      data-output={state.output ?? undefined}
      style={{ "--room": warmthColor(state.warmth), "--warm-c": (state.warmth / 100).toFixed(2) } as React.CSSProperties}
    >
      {scene.backdrop && <Backdrop src={scene.backdrop} />}
      <div className="wrap room__bar">
        <div className="room__title">
          <span className="room__scene">
            {scene.title} with {persona.name}
          </span>
          <span className="room__time" aria-label="Time elapsed">
            {mmss(state.elapsed)}
          </span>
        </div>
        <div className="room__actions">
          {!talk && (
            <button className="btn btn--ghost btn--quiet" onClick={() => setHints(!hints)} aria-pressed={hints}>
              {hints ? "Hide hints" : "Show hints"}
            </button>
          )}
          <button className="btn btn--quiet" onClick={() => void conv.end()} disabled={ending}>
            {talk ? "End session" : "End conversation"}
          </button>
        </div>
      </div>

      <div className="wrap room__grid">
        <div className="stage">
          {talkView ? (
            <>
              <p className="muted">Your topic</p>
              <p className="topic">{state.topic}</p>
              <div className="dial">
                <InterestGauge value={state.warmth} label={gaugeLabel} />
                <Countdown left={state.talkLeft!} />
              </div>
              <p className="stage__mood">The audience {state.mood.label}</p>
              <p className="small muted">Attention dips during silences longer than 3 seconds and recovers while you speak.</p>
              <div className="transcript-live" aria-live="off">
                {state.lines
                  .filter((l) => l.who === "you")
                  .slice(-6)
                  .map((l) => (
                    <span key={l.id}>{l.text} </span>
                  ))}
              </div>
              <button className="btn" onClick={() => conv.finishTalk()} disabled={state.talkLeft === TALK_SECONDS}>
                I&rsquo;m done, take questions
              </button>
            </>
          ) : (
            <>
              <div
                className={`orb${persona.portrait ? " orb--portrait" : ""}`}
                style={persona.portrait ? portraitFit(persona.portrait) : undefined}
                ref={orbRef}
              >
                <div className="orb__halo" aria-hidden="true" />
                <InterestGauge value={state.warmth} label={gaugeLabel} />
                <div className="orb__core" aria-hidden="true">
                  {!persona.portrait && persona.name[0]}
                </div>
                {persona.portrait && (
                  <Image className="orb__face" src={persona.portrait.src} alt="" width={1254} height={1254} sizes="260px" priority />
                )}
              </div>
              <p className="stage__mood">
                {talk
                  ? state.phase === "qa"
                    ? `Question ${Math.min(2, state.answers + 1)} of 2`
                    : "Introducing your topic"
                  : `${persona.name} ${state.mood.label}`}
              </p>
              <Feed feed={state.feed} />
              <div className="captions" aria-live="polite" ref={captionsRef}>
                {lastThem && (
                  <p className="caption caption--them">
                    <span className="sr-only">{persona.name}: </span>
                    {lastThem.text || "…"}
                  </p>
                )}
                {lastYou && youAfterThem && (
                  <p className={`caption caption--you${lastYou.final ? "" : " is-partial"}`}>
                    <span className="sr-only">You: </span>
                    {lastYou.text}
                  </p>
                )}
              </div>
              {/* the bubble comes and goes every turn, so its space is kept */}
              {hints && !talk && (
                <div className="tip-slot">
                  {state.tip && state.speaking !== "them" && (
                    <p className="tip">
                      <span className="tip__label">
                        <Emoji code="1F4A1" size={18} />
                        Try this
                      </span>
                      {state.tip}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          <p className="status-line" role="status">
            {state.speaking === "you" && !ending ? (
              <span className="listening">
                <span className="listening__dot" ref={micRef} />
                Listening…
              </span>
            ) : (
              statusText
            )}
          </p>
        </div>

        <aside className="side side--goals panel" aria-label="Goals">
          <h2 className="panel__title">
            <Emoji code="1F3AF" size={26} />
            Goals
          </h2>
          <GoalList scene={scene} done={state.goals} />
        </aside>
      </div>
    </div>
  );
}

/** What moved their interest on your last turn: +8 Followed up on “climbing”. */
function Feed({ feed }: { feed: LiveState["feed"] }) {
  return (
    <div className="feed" aria-live="polite">
      {feed?.signals.map((s, i) => (
        <span key={`${feed.id}-${i}`} className={`chip ${s.delta > 0 ? "chip--up" : "chip--down"}`}>
          <span className="chip__delta">{s.delta > 0 ? `+${s.delta}` : `−${-s.delta}`}</span>
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** The seconds left in your talk, on a disc the audience's attention gauge rings. */
function Countdown({ left }: { left: number }) {
  return (
    <div className="countdown" role="timer" aria-label={`${left} seconds left`}>
      <span className="countdown__num">{left}</span>
      <span className="countdown__unit">seconds left</span>
    </div>
  );
}
