// Learn: the glossary, Marble Trivia and Speed ID. Scores are saved on the server, which keeps
// the personal best and decides on the Quiz Whiz badge itself.
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { GLOSSARY, QUIZ } from '../lib/learnData';

// tests shorten these
export const timing = { reveal: 900, speedRound: 6000 };

export default function Learn() {
  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Marble School</span>
          <h1>Learn</h1>
          <p className="muted">Know your swirls from your sulphides.</p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', marginBottom: 20 }}>
        <Trivia />
        <SpeedId />
      </div>
      <h2 style={{ fontSize: 26, marginBottom: 10 }}>Glossary</h2>
      <div className="grid">
        {GLOSSARY.map((g) => (
          <div key={g.nm} className="card stack" style={{ gap: 4 }}>
            <strong><span aria-hidden="true">{g.ic}</span> {g.nm}</strong>
            <span className="muted" style={{ fontSize: 14 }}>{g.d}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function verdict(score, outOf) {
  if (score === outOf) return 'Perfect score — true collector!';
  if (score / outOf >= 0.7) return 'Great job — you know your marbles!';
  if (score / outOf >= 0.4) return 'Not bad — keep collecting knowledge.';
  return 'Keep learning — check the glossary below.';
}

function Trivia() {
  const [i, setI] = useState(0);
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState(null);
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(null); // { best, newBest, whiz } | { error }
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function finish(final) {
    setDone(true);
    try {
      const r = await apiFetch('/api/games/trivia/score', { method: 'POST', body: JSON.stringify({ score: final, outOf: QUIZ.length }) });
      let whiz = false;
      if (final / QUIZ.length >= 0.7) {
        const list = await apiFetch('/api/achievements').catch(() => []);
        whiz = !!list.find((a) => a.key === 'quizWhiz' && a.unlocked);
      }
      setSaved({ ...r, whiz });
    } catch (e) { setSaved({ error: e.message }); }
  }
  function pick(idx) {
    if (picked !== null) return;
    setPicked(idx);
    const final = score + (idx === QUIZ[i].a ? 1 : 0);
    setScore(final);
    timer.current = setTimeout(() => {
      if (i + 1 >= QUIZ.length) finish(final);
      else { setI(i + 1); setPicked(null); }
    }, timing.reveal);
  }
  function restart() { setI(0); setScore(0); setPicked(null); setDone(false); setSaved(null); }

  const q = QUIZ[i];
  return (
    <div className="card stack quiz-card">
      <h3 style={{ fontSize: 22 }}>🧠 Marble Trivia</h3>
      {!done ? (
        <>
          <span className="muted">Question {i + 1} of {QUIZ.length}</span>
          <strong>{q.q}</strong>
          <div className="stack" style={{ gap: 6 }}>
            {q.opts.map((o, idx) => {
              const state = picked === null ? '' : idx === q.a ? 'right' : idx === picked ? 'wrong' : '';
              return (
                <button key={o} className={`quiz-opt ${state}`} disabled={picked !== null} onClick={() => pick(idx)}
                  style={state === 'right' ? { borderColor: 'var(--success, #2e7d32)' } : state === 'wrong' ? { borderColor: 'var(--danger)' } : undefined}>
                  {o}
                </button>
              );
            })}
          </div>
          {picked !== null && <span role="status">{picked === q.a ? '✓ Correct' : `✗ It was: ${q.opts[q.a]}`}</span>}
        </>
      ) : (
        <>
          <strong style={{ fontSize: 28 }}>{score} / {QUIZ.length}</strong>
          <p>{verdict(score, QUIZ.length)}</p>
          {saved === null ? <span className="muted">Saving your score…</span>
            : saved.error ? <span className="error">Your score could not be saved: {saved.error}</span>
              : <span className="muted">{saved.newBest ? 'New personal best!' : `Your best: ${saved.best} / ${QUIZ.length}`}</span>}
          {saved?.whiz && <span role="status">🧠 Quiz Whiz earned!</span>}
          <button onClick={restart}>↻ Try Again</button>
        </>
      )}
    </div>
  );
}

const shuffle = (a) => { const b = [...a]; for (let k = b.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [b[k], b[j]] = [b[j], b[k]]; } return b; };
function makeRound() {
  const answer = GLOSSARY[Math.floor(Math.random() * GLOSSARY.length)];
  const others = shuffle(GLOSSARY.filter((g) => g.nm !== answer.nm)).slice(0, 3);
  return { answer, opts: shuffle([answer, ...others]).map((g) => g.nm) };
}

// Read the description, name the marble. One wrong answer (or running out of time) ends the run.
function SpeedId() {
  const [phase, setPhase] = useState('idle'); // idle | playing | over
  const [round, setRound] = useState(null);
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState(null);
  const [saved, setSaved] = useState(null);
  const timers = useRef([]);
  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => clear, []);

  async function end(final) {
    clear();
    setPhase('over');
    try { setSaved(await apiFetch('/api/games/speed/score', { method: 'POST', body: JSON.stringify({ score: final }) })); } catch (e) { setSaved({ error: e.message }); }
  }
  function next(current) {
    clear();
    setRound(makeRound());
    setPicked(null);
    timers.current.push(setTimeout(() => end(current), timing.speedRound));
  }
  function start() { setScore(0); setSaved(null); setPhase('playing'); next(0); }
  function pick(name) {
    if (picked !== null) return;
    clear();
    setPicked(name);
    if (name === round.answer.nm) {
      const s = score + 1;
      setScore(s);
      timers.current.push(setTimeout(() => next(s), timing.reveal / 2));
    } else {
      timers.current.push(setTimeout(() => end(score), timing.reveal / 2));
    }
  }

  return (
    <div className="card stack" data-testid="speed-game">
      <h3 style={{ fontSize: 22 }}>⚡ Speed ID</h3>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">Name the marble from its description. One miss ends the run.</span>
        <span>Score: <strong className="score mono">{score}</strong></span>
      </div>
      {phase === 'idle' && <button className="primary-btn" onClick={start}>▶ Start</button>}
      {phase === 'playing' && round && (
        <>
          <p style={{ margin: 0 }}>{round.answer.d}</p>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
            {round.opts.map((o) => (
              <button key={o} className="quiz-opt" disabled={picked !== null} onClick={() => pick(o)}
                style={picked !== null && o === round.answer.nm ? { borderColor: 'var(--success, #2e7d32)' } : picked === o ? { borderColor: 'var(--danger)' } : undefined}>
                {o}
              </button>
            ))}
          </div>
        </>
      )}
      {phase === 'over' && (
        <>
          <p style={{ margin: 0 }}>Run over: {score} in a row.</p>
          {saved && (saved.error ? <span className="error">Your score could not be saved: {saved.error}</span>
            : <span className="muted">{saved.newBest ? 'New personal best!' : `Your best: ${saved.best}`}</span>)}
          <button className="primary-btn" onClick={start}>↻ Play Again</button>
        </>
      )}
    </div>
  );
}
