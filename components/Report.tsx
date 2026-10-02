"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BadgeCelebration } from "./Badges";
import { Blob, Cloud, Sparks } from "./Decor";
import SceneGuide from "./SceneGuide";
import GoalList from "./GoalList";
import WarmthChart from "./WarmthChart";
import { PlayButton, spotOf, type Playback } from "./playback";
import { outcomeText, rulesCoach } from "@/lib/coach";
import { isFiller, mmss } from "@/lib/metrics";
import { fetchCoach, runAnalysis, upgradeAnalysis } from "@/lib/report";
import { compareRetake, planRetake } from "@/lib/retake";
import { portraitFit, SCENES, sceneById, type Scene } from "@/lib/scenarios";
import { badgesFrom, earnedBadges } from "@/lib/badges";
import { GUIDES, usedTips } from "@/lib/guides";
import { getSession, listSessions, updateSession, type Metrics, type SessionRecord } from "@/lib/store";

type Status = "good" | "meh" | "bad";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Report({ id }: { id: string }) {
  const [rec, setRec] = useState<SessionRecord | null | undefined>(undefined);
  const [phase, setPhase] = useState<"idle" | "transcribing" | "coaching" | "done">("idle");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [coachNotice, setCoachNotice] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const initial = getSession(id);
    setRec(initial);
    if (!initial) return;
    const ctrl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let waits = 0; // a busy coach is asked again a few times, not for as long as the page is open

    const coach = async (r: SessionRecord) => {
      if (r.coach?.source === "llm") return setPhase("done");
      setPhase("coaching");
      const res = await fetchCoach(r, ctrl.signal).catch((e) => ({ error: errMsg(e), report: undefined, retryAfter: undefined }));
      if (ctrl.signal.aborted) return;
      if (res.report) {
        updateSession(id, { coach: res.report });
        setRec((cur) => cur && { ...cur, coach: res.report });
        setCoachNotice(null);
      } else {
        const quick = rulesCoach(r);
        setRec((cur) => cur && { ...cur, coach: cur.coach?.source === "llm" ? cur.coach : quick });
        if (res.retryAfter && res.retryAfter <= 90 && waits++ < 3) {
          setCoachNotice(`The AI coach is busy, so these are quick notes for now. Detailed notes load in about ${res.retryAfter} seconds.`);
          retry = setTimeout(() => void coach(r), res.retryAfter * 1000 + 800);
          return; // still coaching: the detailed notes are on their way
        } else {
          setCoachNotice(`These are quick notes. ${res.error ?? ""}`.trim());
        }
      }
      setPhase("done");
    };

    (async () => {
      let r = initial;
      if (r.analysis) {
        const analysis = upgradeAnalysis(r.analysis);
        if (analysis !== r.analysis) {
          r = { ...r, analysis };
          updateSession(id, { analysis });
          setRec(r);
        }
      }
      if (!r.analysis && r.sessionId && r.durationSec > 3) {
        setPhase("transcribing");
        try {
          const analysis = await runAnalysis(r, ctrl.signal);
          r = { ...r, analysis };
          updateSession(id, { analysis });
          setRec(r);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          setAnalysisError(errMsg(e));
        }
      }
      await coach(r);
    })();

    return () => {
      ctrl.abort();
      clearTimeout(retry);
    };
  }, [id]);

  // Coming back from a retake: bring the moment into view once the report has rendered.
  const loaded = !!rec?.coach;
  useEffect(() => {
    if (!loaded || !window.location.hash.startsWith("#moment-")) return;
    const id = requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(id);
  }, [loaded]);

  // Right after a session the recording usually isn't ready yet (409), so keep asking for a while.
  const sessionId = rec?.sessionId;
  const loadAudio = useCallback(
    async (signal?: AbortSignal) => {
      if (!sessionId) return;
      for (let i = 0; i < 12 && !signal?.aborted; i++) {
        const res = await fetch(`/api/recording/${sessionId}`, { cache: "no-store", signal }).catch(() => null);
        if (res?.ok) return setAudioUrl((await res.json()).url);
        if (res?.status !== 409) return;
        await new Promise((r) => setTimeout(r, 5000));
      }
    },
    [sessionId],
  );
  useEffect(() => {
    const ctrl = new AbortController();
    void loadAudio(ctrl.signal);
    return () => ctrl.abort();
  }, [loadAudio]);
  // The recording's URL expires, so a failed load fetches a fresh one, but at most every 30 s:
  // a recording that can't play at all would otherwise ask again and again.
  const audioRetried = useRef(0);
  const onAudioError = () => {
    if (Date.now() - audioRetried.current < 30_000) return;
    audioRetried.current = Date.now();
    void loadAudio();
  };

  // Every play button toggles: play from its spot, or pause if that spot is already playing.
  // Only playing, pausing and seeking change this; the chart's playhead follows the audio by itself,
  // so the report doesn't re-render while audio plays.
  const [pb, setPb] = useState<Playback>({ spot: null, playing: false });
  const seek = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    const spot = spotOf(t);
    if (!a.paused && pb.spot === spot) return a.pause();
    a.currentTime = spot;
    setPb((p) => (p.spot === spot ? p : { ...p, spot }));
    void a.play().catch(() => {});
  };
  const audioEvents = {
    onPlay: () => setPb((p) => (p.playing ? p : { ...p, playing: true })),
    onPause: () => setPb((p) => (p.playing ? { ...p, playing: false } : p)),
    // Scrubbing in the player moves playback away from the spot it started at.
    onSeeked: (e: React.SyntheticEvent<HTMLAudioElement>) => {
      const now = e.currentTarget.currentTime;
      setPb((p) => (p.spot !== null && Math.abs(now - p.spot) > 0.5 ? { ...p, spot: null } : p));
    },
  };

  // Badges this session earned for the first time (recomputed as the coach's goal notes arrive).
  // Uses this session as shown, even if saving its latest update to storage failed.
  const newBadges = useMemo(
    () => (rec ? badgesFrom(rec.id, earnedBadges([rec, ...listSessions().filter((r) => r.id !== rec.id)])) : []),
    [rec],
  );

  if (rec === undefined)
    return (
      <div className="wrap center-state">
        <span className="spinner" />
      </div>
    );
  if (rec === null)
    return (
      <div className="wrap center-state">
        <h1 className="h2">This replay isn&rsquo;t on this device</h1>
        <p className="lede">Practice history is saved in the browser where you practiced.</p>
        <Link className="btn" href="/#scenes">
          Choose a scene
        </Link>
      </div>
    );

  const scene = sceneById(rec.sceneId) as Scene;
  const persona = scene.personas.find((p) => p.name === rec.personaName) ?? scene.personas[0];
  const talk = scene.kind === "talk";
  const next = SCENES.find((s) => s.level > scene.level) ?? SCENES.find((s) => s.id !== scene.id && s.level === scene.level);
  const coach = rec.coach;
  const goalsDone = { ...rec.goals };
  if (!talk) for (const g of coach?.goals ?? []) if (g.done) goalsDone[g.id] = true;
  const reached = scene.goals.filter((g) => goalsDone[g.id]).length;
  // Which of the scene's tips you already said or used this time; the rest are marked to try next.
  const yours = rec.analysis ? rec.analysis.utterances.filter((u) => u.who === "you").map((u) => u.text) : rec.lines.filter((l) => l.who === "you").map((l) => l.text);
  const guide = GUIDES[scene.id];
  const used = guide ? usedTips(guide, scene, yours, goalsDone) : undefined;
  const tiles = rec.analysis ? tilesFor(rec.analysis.metrics, rec, talk) : null;
  // What's still on its way. The coach waits for the transcript, so say which one we're waiting for.
  const transcribing = !rec.analysis && !analysisError && !!rec.sessionId && rec.durationSec > 3;
  const writing = transcribing ? "Your feedback is written once the recording is transcribed, in about half a minute." : "The coach is writing your notes. This takes a few seconds.";
  const when = new Date(rec.createdAt).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });

  return (
    <div className="report-page">
      <Cloud className="decor--cloud report-page__cloud-a" />
      <Cloud className="decor--cloud report-page__cloud-b" />
      <div className="wrap report">
        <header className="report__head">
          <Blob className="report__blob report__blob--peach" shape="a" color="#fbe3d3" />
          <Blob className="report__blob report__blob--lilac" shape="c" color="#e9e2f6" />
          <Link href="/#history" className="link-back">
            ← Your practice
          </Link>
          <p className="report__meta">
            {scene.title} with {persona.name}. {when}, {mmss(rec.durationSec)} long.
            {rec.topic ? ` Topic: “${rec.topic}”.` : ""}
          </p>
          {coach ? (
            <h1 className="report__headline">{coach.headline}</h1>
          ) : (
            <div className="report__pending">
              <div className="skeleton" style={{ height: 96, maxWidth: 720 }} aria-hidden="true" />
              <Loading>{writing}</Loading>
            </div>
          )}
          <p className="report__outcome">
            {outcomeText(rec.outcome, persona, scene.kind)} {talk ? "Audience attention" : `${persona.name}'s interest`} went from{" "}
            {rec.startWarmth} to {rec.finalWarmth}.
          </p>

          <aside className="report__goals glass-card" aria-labelledby="goals-title">
            <Sparks className="report__goals-sparks" />
            <div className="report__goals-head">
              <h2 id="goals-title" className="report__goals-title">
                Goals
              </h2>
              <p className="report__goals-count">
                {reached} of {scene.goals.length} reached
              </p>
            </div>
            <GoalList scene={scene} done={goalsDone} openLabel="Next time" />
            <div className="report__actions">
              <Link className="btn report__again" href={`/practice/${scene.id}`}>
                <svg className="report__again-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 3.5v3h-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Practice this again
              </Link>
              {next && (
                <Link className="btn btn--ghost report__next" href={`/practice/${next.id}`}>
                  <NextFace scene={next} />
                  <span className="report__next-text">
                    <span className="report__next-label">Up next</span>
                    {next.title}
                  </span>
                  <svg className="report__next-arrow" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M4 10 H16 M11 5 L16 10 L11 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              )}
            </div>
          </aside>
        </header>

        <BadgeCelebration badges={newBadges} />

        <section className="block" aria-labelledby="curve-title">
          <div className="block__head">
            <h2 id="curve-title" className="h2">
              {talk ? "How the room's attention moved" : `How ${persona.name}'s interest moved`}
            </h2>
            <p className="muted">
              {talk ? "Attention sags in long silences and rises with clear answers." : "Hover or tab through the dots to see what moved it."}
            </p>
          </div>
          <div className="card">
            <WarmthChart
              points={rec.points}
              start={rec.startWarmth}
              duration={rec.durationSec}
              moments={coach?.moments ?? []}
              talk={talk}
              onSeek={audioUrl ? seek : undefined}
              playback={pb}
              audio={audioRef}
              youTurns={rec.analysis?.utterances.filter((u) => u.who === "you").map((u) => ({ start: u.start / 1000, end: u.end / 1000 }))}
            />
          </div>
        </section>

        <section className="block" aria-labelledby="coach-title">
          <div className="block__head">
            <h2 id="coach-title" className="h2">
              Coach notes
            </h2>
            {coach && coachNotice && (
              <p className="progress-note small" role="status">
                {phase === "coaching" && <span className="spinner" aria-hidden="true" />} {coachNotice}
              </p>
            )}
          </div>
          {coach ? (
            <>
              {coach.nextStep && (
                <div className="coach-says">
                  <svg className="coach-says__coach" viewBox="180 196 940 770" aria-hidden="true">
                    <image href="/backdrops/Coach.svg" width="1254" height="1254" />
                  </svg>
                  <blockquote className="next-step">
                    <b>Your one thing for next time</b>
                    <p>{coach.nextStep}</p>
                  </blockquote>
                </div>
              )}
              <div className="notes">
                {coach.strengths.length > 0 && (
                  <section className="notes__col" aria-label="What worked">
                    <StatusLabel status="good" text="What worked" />
                    {coach.strengths.map((s, i) => (
                      <article key={i} className="note note--good">
                        <span className="note__icon" aria-hidden="true">
                          <svg viewBox="0 0 16 16">
                            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <div className="note__body">
                          <h3 className="note__title">{s.title}</h3>
                          <p>{s.detail}</p>
                        </div>
                      </article>
                    ))}
                  </section>
                )}
                {coach.improvements.length > 0 && (
                  <section className="notes__col" aria-label="Try next time">
                    <StatusLabel status="meh" text="Try next time" />
                    {coach.improvements.map((s, i) => (
                      <article key={i} className="note note--try">
                        <span className="note__icon" aria-hidden="true">
                          <svg viewBox="0 0 16 16">
                            <path d="M8 3v7M8 13v.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                          </svg>
                        </span>
                        <div className="note__body">
                          <h3 className="note__title">{s.title}</h3>
                          <p>{s.detail}</p>
                          {s.tryInstead && (
                            <p className="note__try">
                              <span className="note__try-label">You could say</span>
                              {s.tryInstead}
                            </p>
                          )}
                        </div>
                      </article>
                    ))}
                  </section>
                )}
              </div>
            </>
          ) : (
            <>
              <Loading>{writing}</Loading>
              <div className="skeleton" style={{ height: 240 }} aria-hidden="true" />
            </>
          )}
        </section>

        {guide && <SceneGuide guide={guide} used={used} title="Try these next time" />}

        {/* the moments come with the coach's notes; until then, hold their place */}
        {!coach && (
          <section className="block" aria-labelledby="moments-title" aria-busy="true">
            <h2 id="moments-title" className="h2">
              Moments to replay
            </h2>
            <Loading>The coach is picking the moments worth another try.</Loading>
            <div className="skeleton" style={{ height: 300 }} aria-hidden="true" />
          </section>
        )}

        {coach && coach.moments.length > 0 && (
          <section className="block" aria-labelledby="moments-title">
            <h2 id="moments-title" className="h2">
              Moments to replay
            </h2>
            <ol className="moments">
              {coach.moments.map((mo, i) => (
                <li key={i} className="moment" id={`moment-${i}`}>
                  <div className="moment__time">
                    <span className={`moment__num moment__num--${mo.kind}`} aria-label={`Moment ${i + 1}`}>
                      {i + 1}
                    </span>
                    <PlayButton at={mo.at} playback={pb} onToggle={seek} disabled={!audioUrl} />
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    <StatusLabel
                      status={mo.kind === "great" ? "good" : mo.kind === "missed" ? "meh" : "bad"}
                      text={mo.kind === "great" ? "Great moment" : mo.kind === "missed" ? "Missed chance" : "Awkward moment"}
                    />
                    <p className="moment__quote">“{mo.quote}”</p>
                    <p>{mo.comment}</p>
                    {mo.better && <p className="moment__better">You could say: “{mo.better.replace(/^[“"]|[”"]$/g, "")}”</p>}
                    <Retake rec={rec} index={i} talk={talk} kind={mo.kind} />
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <div className="report-page__ground">
        <div className="wrap report report--lower">
          <section className="block" aria-labelledby="sound-title">
            <div className="block__head">
              <h2 id="sound-title" className="h2">
                How you sounded
              </h2>
              {tiles && <TileSummary tiles={tiles} />}
            </div>
            {tiles ? (
              <div className="tiles">
                {tiles.map((t) => (
                  <Tile key={t.label} {...t} />
                ))}
              </div>
            ) : transcribing ? (
              <>
                <Loading>Transcribing your recording. This takes about 10 to 30 seconds.</Loading>
                <div className="skeleton" style={{ height: 280 }} aria-hidden="true" />
              </>
            ) : (
              <p className="notice">{analysisError ?? "There's no recording for this session, so speaking metrics aren't available."}</p>
            )}
          </section>

          <details className="script-block">
            <summary>
              <h2 className="h2">The conversation</h2>
              <span className="muted">{rec.analysis ? "Every word, with filler words highlighted." : "Live transcript from the session."}</span>
            </summary>
            <div className="card">
              <Script rec={rec} name={persona.name} onSeek={audioUrl ? seek : undefined} playback={pb} />
            </div>
          </details>

          {(rec.analysis || coach?.source === "llm") && (
            <p className="report__credit small muted">
              {rec.analysis && "Speaking metrics come from transcribing the recording with AssemblyAI's Universal-3.5 Pro. "}
              {coach?.source === "llm" && `Coach notes are written by ${coach.model} through AssemblyAI's LLM Gateway.`}
            </p>
          )}

          {audioUrl && (
            <div className="player">
              <span className="player__label">Recording</span>
              <audio ref={audioRef} controls preload="metadata" src={audioUrl} onError={onAudioError} {...audioEvents} />
            </div>
          )}
        </div>
      </div>

      <img className="report-page__bottom" src="/backdrops/Results-Bottom.svg" alt="" width={2170} height={428} aria-hidden="true" />

    </div>
  );
}

function Retake({ rec, index, talk, kind }: { rec: SessionRecord; index: number; talk: boolean; kind: string }) {
  if (talk) return null;
  const result = rec.retakes?.[index];
  const plan = planRetake(rec, index);
  if (!plan) return null;
  return (
    <div className="retake">
      {result && (
        <div className="retake__result">
          <p className="note__try-label">Your retake</p>
          <p className="moment__quote">“{result.said}”</p>
          <div className="feed">
            {result.signals.map((s, k) => (
              <span key={k} className={`chip ${s.delta > 0 ? "chip--up" : "chip--down"}`}>
                <span className="chip__delta">{s.delta > 0 ? `+${s.delta}` : `−${-s.delta}`}</span>
                {s.label}
              </span>
            ))}
          </div>
          <p className="small muted">{compareRetake(plan, result)}</p>
        </div>
      )}
      {kind !== "great" && (
        <Link className="btn btn--ghost btn--quiet" href={`/practice/${rec.sceneId}?retake=${rec.id}.${index}`}>
          {result ? "Try it once more" : "Try this moment again"}
        </Link>
      )}
    </div>
  );
}

function Script({ rec, name, onSeek, playback }: { rec: SessionRecord; name: string; onSeek?: (t: number) => void; playback: Playback }) {
  if (!rec.analysis) {
    return (
      <div className="script">
        {rec.lines.map((l, i) => (
          <p key={i} className={`script__line script__line--${l.who}`}>
            <span className="script__time">{mmss(l.t)}</span>
            <span>
              <span className="script__who">{l.who === "you" ? "You" : name}</span>
              <span className="script__text">{l.text}</span>
            </span>
          </p>
        ))}
      </div>
    );
  }
  const utts = rec.analysis.utterances;
  return (
    <div className="script">
      {utts.map((u, i) => {
        const prev = utts[i - 1];
        const gap = prev && prev.who === "them" && u.who === "you" ? (u.start - prev.end) / 1000 : 0;
        return (
          <div key={i} className={`script__line script__line--${u.who}`}>
            {onSeek ? (
              <PlayButton at={u.start / 1000} playback={playback} onToggle={onSeek} className="script__time" />
            ) : (
              <span className="script__time">{mmss(u.start / 1000)}</span>
            )}
            <p>
              {gap >= 2.5 && <span className="script__gap">{gap.toFixed(1)} seconds before you answered</span>}
              <span className="script__who">{u.who === "you" ? "You" : name}</span>
              <span className="script__text">
                {u.who === "you" && u.words.length
                  ? u.words.map((w, k) => (
                      <span key={k}>
                        {k > 0 && " "}
                        {isFiller(w.text) ? <mark className="filler">{w.text}</mark> : w.text}
                      </span>
                    ))
                  : u.text}
              </span>
            </p>
          </div>
        );
      })}
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  unit?: string;
  status: Status;
  statusText: string;
  note: string;
}

function Tile({ label, value, unit, status, statusText, note }: TileProps) {
  return (
    <div className={`tile tile--${status}`}>
      <div className="tile__head">
        <span className="tile__label">{label}</span>
        <StatusLabel status={status} text={statusText} />
      </div>
      <span className="tile__value">
        {value}
        {unit && <span className="tile__unit">{unit}</span>}
      </span>
      <span className="tile__note">{note}</span>
    </div>
  );
}

/** At a glance: how many metrics went well and how many are worth working on. */
function TileSummary({ tiles }: { tiles: TileProps[] }) {
  const groups: [Status, string][] = [
    ["good", "going well"],
    ["meh", "worth watching"],
    ["bad", "to work on"],
  ];
  return (
    <p className="tile-summary">
      {groups.map(([status, text]) => {
        const n = tiles.filter((t) => t.status === status).length;
        return n ? <StatusLabel key={status} status={status} text={`${n} ${text}`} /> : null;
      })}
    </p>
  );
}

function tilesFor(m: Metrics, rec: SessionRecord, talk: boolean): TileProps[] {
  const fillerBreakdown = Object.entries(m.fillerWords)
    .map(([w, n]) => `${w} ×${n}`)
    .join(", ");
  const pace: TileProps = {
    label: "Pace",
    value: m.wpm === null ? "–" : String(m.wpm),
    unit: "words/min",
    status: m.wpm === null ? "meh" : m.wpm < 105 ? "meh" : m.wpm > 180 ? "meh" : "good",
    statusText:
      m.wpm === null ? "Not enough speech" : m.wpm < 105 ? "On the slow side" : m.wpm > 180 ? "On the fast side" : "Easy to follow",
    note: "Around 120 to 170 words a minute is comfortable to listen to.",
  };
  const fillers: TileProps = {
    label: "Filler words",
    value: m.fillersPerMin === null ? String(m.fillers) : String(m.fillersPerMin),
    unit: m.fillersPerMin === null ? "total" : "per min",
    // In short sessions one "uh" is a high per-minute rate, so 0-1 fillers always count as barely any.
    status: m.fillers <= 1 || m.fillersPerMin === null || m.fillersPerMin < 2 ? "good" : m.fillersPerMin < 4 ? "meh" : "bad",
    statusText:
      m.fillers <= 1 || m.fillersPerMin === null || m.fillersPerMin < 2 ? "Barely any" : m.fillersPerMin < 4 ? "A few" : "Quite a lot",
    note: fillerBreakdown ? `${m.fillers} in total: ${fillerBreakdown}.` : "No ums or uhs detected.",
  };
  const pause: TileProps = {
    label: "Longest pause",
    value: m.longestPause.toFixed(1),
    unit: "sec",
    status: m.longestPause <= 2 ? "good" : m.longestPause <= 3.5 ? "meh" : "bad",
    statusText: m.longestPause <= 2 ? "Smooth" : m.longestPause <= 3.5 ? "Noticeable" : "Long",
    note: `${m.pauses} ${m.pauses === 1 ? "pause" : "pauses"} over 1.5 seconds inside your own turns. Short pauses sound thoughtful.`,
  };

  if (talk) {
    const secs = rec.talkSeconds ?? 0;
    const tics = Object.entries(m.tics).sort((a, b) => b[1] - a[1]);
    const ticCount = tics.reduce((s, [, n]) => s + n, 0);
    return [
      {
        label: "Talk length",
        value: String(secs),
        unit: "sec",
        status: secs >= 60 ? "good" : secs >= 40 ? "meh" : "bad",
        statusText: secs >= 60 ? "Filled the time" : secs >= 40 ? "A bit short" : "Very short",
        note: "The target was 60 to 90 seconds before questions.",
      },
      pace,
      fillers,
      pause,
      {
        label: "Verbal tics",
        value: String(ticCount),
        status: ticCount <= 3 ? "good" : ticCount <= 7 ? "meh" : "bad",
        statusText: ticCount <= 3 ? "Hardly any" : ticCount <= 7 ? "Noticeable" : "Frequent",
        note: tics.length
          ? `Most used: ${tics
              .slice(0, 3)
              .map(([w, n]) => `“${w}” ×${n}`)
              .join(", ")}.`
          : "No “like”, “you know” or “basically” habits.",
      },
      qaTile(rec),
    ];
  }

  return [
    {
      label: "Response time",
      value: m.avgGap === null ? "–" : m.avgGap.toFixed(1),
      unit: "sec",
      status: m.avgGap === null || m.avgGap <= 1.8 ? "good" : m.avgGap <= 3 ? "meh" : "bad",
      statusText: m.avgGap === null ? "Not measured" : m.avgGap <= 1.8 ? "Natural" : m.avgGap <= 3 ? "A little hesitant" : "Long pauses",
      note:
        m.longestGap === null
          ? "Time from the end of their line to your first word."
          : `Time from the end of their line to your first word. Longest: ${m.longestGap}s.`,
    },
    {
      label: "Your share of the talking",
      value: m.talkShare === null ? "–" : String(Math.round(m.talkShare * 100)),
      unit: "%",
      status: m.talkShare === null ? "meh" : m.talkShare >= 0.35 && m.talkShare <= 0.65 ? "good" : "meh",
      statusText:
        m.talkShare === null ? "Not measured" : m.talkShare < 0.35 ? "They carried it" : m.talkShare > 0.65 ? "You carried it" : "Balanced",
      note: "Between 35% and 65% feels like a two-way conversation.",
    },
    {
      label: "Questions you asked",
      value: String(m.questions),
      status: m.questions >= 2 ? "good" : m.questions === 1 ? "meh" : "bad",
      statusText: m.questions >= 2 ? "Curious" : m.questions === 1 ? "Just one" : "None",
      note: "Questions, especially follow-ups, are what make people open up.",
    },
    fillers,
    pace,
    pause,
  ];
}

/** Talk mode: how long the Q&A answers were: your turns after the host's first question. */
function qaTile(rec: SessionRecord): TileProps {
  const from = (rec.qaStartedAt ?? Infinity) * 1000 - 1500;
  const turns = rec.analysis?.utterances ?? [];
  const firstQuestion = turns.findIndex((u) => u.who === "them" && u.start >= from);
  const answers = firstQuestion < 0 ? [] : turns.slice(firstQuestion).filter((u) => u.who === "you");
  const avg = answers.length ? answers.reduce((s, u) => s + (u.end - u.start), 0) / answers.length / 1000 : null;
  return {
    label: "Average Q&A answer",
    value: avg === null ? "–" : avg.toFixed(0),
    unit: avg === null ? undefined : "sec",
    status: avg !== null && avg >= 15 && avg <= 45 ? "good" : "meh",
    statusText:
      avg === null ? "No answers recorded" : avg < 8 ? "Very brief" : avg < 15 ? "A bit short" : avg > 45 ? "Long-winded" : "Well sized",
    note: "Good answers take 15 to 45 seconds: answer, give a reason, stop.",
  };
}

/** A part of the report that's still on its way: a spinner and what's coming. */
function Loading({ children }: { children: React.ReactNode }) {
  return (
    <p className="progress-note" role="status">
      <span className="spinner" aria-hidden="true" />
      {children}
    </p>
  );
}

function StatusLabel({ status, text }: { status: Status; text: string }) {
  return (
    <span className={`status status--${status}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        {status === "good" ? (
          <path
            d="M2.5 7.5 5.5 10.5 11.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : status === "meh" ? (
          <path d="M3 7h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        ) : (
          <path d="M7 2.5v5.5M7 11v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        )}
      </svg>
      {text}
    </span>
  );
}

/** The next scene's person, as a small portrait (or their initial). */
function NextFace({ scene }: { scene: Scene }) {
  const p = scene.personas[0];
  return (
    <span className={`avatar report__next-face${p.portrait ? " avatar--portrait" : ""}`} style={p.portrait ? portraitFit(p.portrait) : undefined} aria-hidden="true">
      {p.portrait ? <img src={p.portrait.src} alt="" width={44} height={44} /> : p.name[0]}
    </span>
  );
}
