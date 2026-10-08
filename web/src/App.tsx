import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { KNOWN_TECH, type PublicUser, type RadarAlert, type RadarStage, type ServerMessage } from '@sos/shared';
import { connectRadar, forgetToken, loginDev, logout, me, savedToken } from './api.js';
// The editor (CodeMirror + Yjs) is only loaded when entering a room.
const Salle = lazy(() => import('./Salle.js').then((m) => ({ default: m.Salle })));

const STAGE_LABEL: Record<RadarStage, string> = {
  ciblee: 'Ta techno',
  elargie: 'Alerte élargie',
  publique: 'File publique',
};

const salleFromHash = () => /^#\/salle\/([0-9a-f-]{36})$/i.exec(location.hash)?.[1] ?? null;

function since(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `il y a ${s} s` : `il y a ${Math.floor(s / 60)} min`;
}

function Login({ onLogin }: { onLogin: (token: string, user: PublicUser) => void }) {
  const [pseudo, setPseudo] = useState('');
  const [error, setError] = useState('');
  return (
    <main className="card narrow">
      <h1>SOS Dev — Radar</h1>
      <p>Les développeurs bloqués t’appellent depuis leur terminal. Indique tes technos et deviens disponible.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const session = await loginDev(pseudo);
            onLogin(session.token, session.user);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label htmlFor="pseudo">Pseudo (mode démo)</label>
        <input id="pseudo" value={pseudo} onChange={(e) => setPseudo(e.target.value)} placeholder="awa" autoFocus required />
        <button type="submit">Se connecter</button>
        {error && <p className="error">{error}</p>}
      </form>
      <p className="hint">La connexion GitHub sur le web arrive bientôt.</p>
    </main>
  );
}

export function App() {
  const [token, setToken] = useState<string | null>(savedToken());
  const [user, setUser] = useState<PublicUser | null>(null);
  const [tech, setTech] = useState<string[]>(() => JSON.parse(localStorage.getItem('sos.tech') ?? '[]') as string[]);
  const [available, setAvailable] = useState(false);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState<RadarAlert[]>([]);
  const [taken, setTaken] = useState<{ requestId: string; requester: PublicUser } | null>(null);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const radar = useRef<ReturnType<typeof connectRadar> | null>(null);
  const [salle, setSalle] = useState<string | null>(salleFromHash());

  useEffect(() => {
    const onHash = () => setSalle(salleFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token) return;
    me(token).then(setUser, () => {
      forgetToken();
      setToken(null);
    });
  }, [token]);

  useEffect(() => {
    if (!token || !user || salle) return;
    const onMessage = (m: ServerMessage) => {
      switch (m.type) {
        case 'bienvenue':
          setConnected(true);
          break;
        case 'alerte':
          setAlerts((list) => [m.alert, ...list.filter((a) => a.requestId !== m.alert.requestId)]);
          break;
        case 'retirer':
          setAlerts((list) => list.filter((a) => a.requestId !== m.requestId));
          break;
        case 'prise':
          setTaken({ requestId: m.requestId, requester: m.requester });
          setAlerts((list) => list.filter((a) => a.requestId !== m.requestId));
          location.hash = `#/salle/${m.requestId}`;
          break;
        case 'erreur':
          setNotice(m.message);
          break;
      }
    };
    radar.current = connectRadar(token, onMessage, () => {
      setConnected(false);
      setAvailable(false);
    });
    return () => radar.current?.close();
  }, [token, user, salle]);

  if (!token || !user) return <Login onLogin={(t, u) => (setToken(t), setUser(u))} />;
  if (salle) {
    return (
      <Suspense fallback={<main className="card narrow">Ouverture de la salle…</main>}>
        <Salle
          token={token}
          user={user}
          requestId={salle}
          onLeave={() => {
            setTaken(null);
            setAvailable(false);
            history.replaceState(null, '', location.pathname);
            setSalle(null);
          }}
        />
      </Suspense>
    );
  }

  const toggleTech = (t: string) => {
    const next = tech.includes(t) ? tech.filter((x) => x !== t) : [...tech, t];
    setTech(next);
    localStorage.setItem('sos.tech', JSON.stringify(next));
    if (available && next.length) radar.current?.send({ type: 'disponible', tech: next });
  };

  const toggleAvailable = () => {
    setNotice('');
    if (available) {
      radar.current?.send({ type: 'pause' });
      setAlerts([]);
      setAvailable(false);
    } else if (tech.length) {
      radar.current?.send({ type: 'disponible', tech });
      setAvailable(true);
    } else {
      setNotice('Choisis au moins une techno.');
    }
  };

  return (
    <main>
      <header>
        <h1>Radar</h1>
        <span className={connected ? 'dot on' : 'dot'} title={connected ? 'Connecté' : 'Déconnecté'} />
        <span className="who">@{user.login}</span>
        <button className="link" onClick={() => void logout(token).finally(() => (setToken(null), setUser(null)))}>
          Se déconnecter
        </button>
      </header>

      <section className="card">
        <h2>Mes technos</h2>
        <div className="chips">
          {KNOWN_TECH.map((t) => (
            <button key={t} className={tech.includes(t) ? 'chip on' : 'chip'} onClick={() => toggleTech(t)}>
              {t}
            </button>
          ))}
        </div>
        <button className={available ? 'big off' : 'big'} onClick={toggleAvailable} disabled={!connected}>
          {available ? 'Me mettre en pause' : 'Me rendre disponible'}
        </button>
        {notice && <p className="error">{notice}</p>}
      </section>

      {taken && (
        <section className="card success">
          <h2>Tu as pris la demande de @{taken.requester.login}</h2>
          <p>Son terminal vient d’être prévenu.</p>
          <button onClick={() => (location.hash = `#/salle/${taken.requestId}`)}>Entrer dans la salle SOS</button>
        </section>
      )}

      <section>
        <h2>Demandes {available && <small>({alerts.length})</small>}</h2>
        {!available && <p className="hint">Rends-toi disponible pour recevoir les demandes.</p>}
        {available && alerts.length === 0 && <p className="hint">Aucune demande pour l’instant. Tu seras alerté en direct.</p>}
        {alerts.map((a) => (
          <article key={a.requestId} className="card alert">
            <div className="row">
              <span className={`stage ${a.stage}`}>{STAGE_LABEL[a.stage]}</span>
              <span className="tech">{a.tech.join(' · ') || 'Techno inconnue'}</span>
              <span className="hint">
                @{a.requester} · {since(a.createdAt, now)}
              </span>
            </div>
            <code className="error-line">{a.errorSummary}</code>
            <div className="row">
              <span className="hint">
                $ {a.command} · {a.files} fichier(s)
              </span>
              <button onClick={() => radar.current?.send({ type: 'accepter', requestId: a.requestId })}>Accepter</button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
