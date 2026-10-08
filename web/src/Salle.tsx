import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { ChatMessage, PublicUser, SalleMember, SalleState, ServerMessage } from '@sos/shared';
import { connectRadar } from './api.js';

const REMOTE = 'serveur';

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function language(path: string) {
  if (/\.py$/.test(path)) return [python()];
  if (/\.[cm]?[jt]sx?$/.test(path)) return [javascript({ typescript: /\.[cm]?tsx?$/.test(path), jsx: /x$/.test(path) })];
  return [];
}

/** One CodeMirror editor bound to the Y.Text of a shared file. */
function Editor({ doc, path, line }: { doc: Y.Doc; path: string; line?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const text = doc.getText(path);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [basicSetup, oneDark, ...language(path), yCollab(text, null), EditorView.theme({ '&': { height: '100%' } })],
      }),
    });
    if (line && line <= view.state.doc.lines) {
      const pos = view.state.doc.line(line).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    }
    return () => view.destroy();
  }, [doc, path, line]);
  return <div className="editor" ref={host} />;
}

type Closed = { raison: 'resolue' | 'annulee' | 'expiree'; by?: string };

export function Salle({ token, user, requestId, onLeave }: { token: string; user: PublicUser; requestId: string; onLeave: () => void }) {
  const [salle, setSalle] = useState<SalleState | null>(null);
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [file, setFile] = useState('');
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [terminal, setTerminal] = useState('');
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [members, setMembers] = useState<SalleMember[]>([]);
  const [closed, setClosed] = useState<Closed | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const socket = useRef<ReturnType<typeof connectRadar> | null>(null);
  const terminalEnd = useRef<HTMLPreElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: Y.Doc | null = null;
    const onMessage = (m: ServerMessage) => {
      switch (m.type) {
        case 'bienvenue':
          return socket.current?.send({ type: 'rejoindre', requestId, client: 'web' });
        case 'salle': {
          // A fresh document on every (re)join: the server sends the whole state.
          current?.destroy();
          const next = new Y.Doc();
          Y.applyUpdate(next, fromBase64(m.salle.doc), REMOTE);
          next.on('update', (update: Uint8Array, origin: unknown) => {
            if (origin !== REMOTE) socket.current?.send({ type: 'yjs', requestId, update: toBase64(update) });
          });
          current = next;
          setDoc(next);
          setSalle(m.salle);
          setFile((f) => (m.salle.files.some((x) => x.path === f) ? f : (m.salle.files[0]?.path ?? '')));
          setChat(m.salle.chat);
          setTerminal(m.salle.terminal);
          setRunning(m.salle.running);
          setExitCode(m.salle.lastExitCode);
          setMembers(m.salle.members);
          setError('');
          return;
        }
        case 'yjs':
          if (current) Y.applyUpdate(current, fromBase64(m.update), REMOTE);
          return;
        case 'message':
          return setChat((list) => [...list, m.message]);
        case 'terminal':
          return setTerminal((t) => t + m.data);
        case 'execution':
          setRunning(m.state === 'en-cours');
          if (m.state === 'en-cours') setTerminal('');
          else setExitCode(m.exitCode);
          return;
        case 'presence':
          return setMembers(m.members);
        case 'salle-fermee':
          current?.destroy();
          current = null;
          setDoc(null);
          return setClosed({ raison: m.raison, by: m.by });
        case 'erreur':
          return setError(m.message);
      }
    };
    socket.current = connectRadar(token, onMessage, () => setError((e) => e || 'Connexion perdue. Recharge la page pour revenir dans la salle.'));
    return () => {
      socket.current?.close();
      current?.destroy();
    };
  }, [token, requestId]);

  useEffect(() => terminalEnd.current?.scrollTo(0, terminalEnd.current.scrollHeight), [terminal]);
  useEffect(() => chatEnd.current?.scrollTo(0, chatEnd.current.scrollHeight), [chat]);

  if (closed) {
    const text = {
      resolue: `Problème résolu${closed.by ? ` (par @${closed.by})` : ''}. Le code a été effacé du serveur.`,
      annulee: 'Le demandeur a annulé sa demande. Le code a été effacé.',
      expiree: 'La salle a expiré. Le code a été effacé du serveur.',
    }[closed.raison];
    return (
      <main className="card narrow">
        <h1>Salle fermée</h1>
        <p>{text}</p>
        <button onClick={onLeave}>Retour au Radar</button>
      </main>
    );
  }

  if (!salle || !doc) {
    return (
      <main className="card narrow">
        <h1>Salle SOS</h1>
        <p className={error ? 'error' : 'hint'}>{error || 'Connexion à la salle…'}</p>
        <button className="link" onClick={onLeave}>
          Retour au Radar
        </button>
      </main>
    );
  }

  const isHelper = salle.role === 'aidant';
  const other = isHelper ? salle.requester : salle.helper;
  const terminalOnline = members.some((m) => m.client === 'terminal');
  const otherOnline = members.some((m) => m.login === other.login);
  const current = salle.files.find((f) => f.path === file);
  const send = (type: 'proposer' | 'relance') => {
    setError('');
    socket.current?.send({ type, requestId });
  };

  return (
    <div className="salle">
      <header>
        <h1>Salle SOS</h1>
        <span className="hint">
          {isHelper ? 'Tu aides' : 'Tu es aidé par'} @{other.login}
        </span>
        <span className={otherOnline ? 'dot on' : 'dot'} title={otherOnline ? 'En ligne' : 'Absent'} />
        <span className="who">@{user.login}</span>
        <button
          className="resolve"
          onClick={() => {
            if (confirm('Le problème est résolu ? La salle sera fermée et le code effacé du serveur.')) socket.current?.send({ type: 'resolu', requestId });
          }}
        >
          Problème résolu
        </button>
      </header>

      <section className="card summary">
        <code className="error-line">{salle.errorSummary}</code>
        <span className="hint">
          $ {salle.command} · {salle.tech.join(' · ') || 'Techno inconnue'}
        </span>
      </section>

      {error && <p className="error">{error}</p>}

      <div className="salle-grid">
        <section className="card code">
          <div className="tabs">
            {salle.files.map((f) => (
              <button key={f.path} className={f.path === file ? 'tab on' : 'tab'} onClick={() => setFile(f.path)}>
                {f.path}
              </button>
            ))}
          </div>
          {current ? <Editor key={current.path} doc={doc} path={current.path} line={current.line} /> : <p className="hint">Aucun fichier partagé.</p>}
          {isHelper && (
            <div className="actions">
              <button onClick={() => send('proposer')} disabled={!terminalOnline} title="Le demandeur verra le diff dans son terminal et répondra o/n.">
                Envoyer mes corrections
              </button>
              <button onClick={() => send('relance')} disabled={!terminalOnline || running} title="Le demandeur appuie sur Entrée pour relancer.">
                Demander une relance
              </button>
              {!terminalOnline && <span className="hint">Le terminal du demandeur n’est pas relié.</span>}
            </div>
          )}
        </section>

        <section className="card side">
          <h2>
            Terminal de @{salle.requester.login} <small className="hint">lecture seule</small>
            <span className={`run ${running ? 'on' : ''}`}>{running ? 'en cours…' : exitCode === null ? '' : `code ${exitCode}`}</span>
          </h2>
          <pre className="terminal" ref={terminalEnd}>
            {terminal || 'Aucune sortie pour l’instant.'}
          </pre>

          <h2>Chat</h2>
          <div className="chat" ref={chatEnd}>
            {chat.length === 0 && <p className="hint">Dis bonjour !</p>}
            {chat.map((m) => (
              <p key={m.id} className={`msg ${m.role}`}>
                {m.role !== 'systeme' && <b>@{m.from} </b>}
                {m.text}
              </p>
            ))}
          </div>
          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              socket.current?.send({ type: 'message', requestId, text: draft });
              setDraft('');
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Écrire un message…" maxLength={4000} />
            <button type="submit">Envoyer</button>
          </form>
        </section>
      </div>
    </div>
  );
}
