import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Bot, Check, ChevronDown, Clipboard, Edit3, LogOut, Menu, MessageSquarePlus,
  MoreHorizontal, PanelLeftClose, RefreshCcw, Send, Shield, Square, Trash2, UserRoundPlus, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api, setCsrf, streamRun, type AdminUser, type Conversation, type Message, type StreamEvent, type User } from "./api";

const suggestions = [
  "Why was ABB2 output below target yesterday?",
  "Compare downtime between the latest two shifts",
  "Summarise this week's reject patterns",
  "Which recorded losses affected OEE the most?",
];

function RobotMark({ size = "normal" }: { size?: "normal" | "large" }) {
  return <div className={`robot-mark ${size}`} aria-label="Sugi assistant"><span>&gt;_&lt;</span></div>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setLoading(true);
    try {
      const result = await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      setCsrf(result.user.csrfToken); onLogin(result.user);
    } catch { setError("The email or password is incorrect."); }
    finally { setLoading(false); }
  }
  return (
    <main className="auth-shell">
      <div className="aurora" />
      <section className="auth-card">
        <div className="auth-brand"><RobotMark size="large" /><span>Secure production intelligence</span></div>
        <h1>Welcome to<br /><em>Sugi Prod Analytic</em></h1>
        <p>Ask trusted questions about production performance, downtime, rejects, and recorded losses.</p>
        <form onSubmit={submit}>
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-button" disabled={loading}>{loading ? "Signing in…" : "Sign in securely"}</button>
        </form>
        <div className="auth-company"><img src="/brand/sugihara-wordmark.png" alt="Sugihara Grand Industries Sdn Bhd" /></div>
        <div className="unit-credit auth-credit">© <strong>Digital Transformation Unit</strong></div>
      </section>
    </main>
  );
}

function ChangePassword({ onDone }: { onDone: (user: User) => void }) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (newPassword !== confirm) return setError("The new passwords do not match.");
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      const result = await api<{ user: User }>("/api/auth/me"); setCsrf(result.user.csrfToken); onDone(result.user);
    } catch { setError("Check your current password and use at least 12 characters."); }
  }
  return (
    <main className="auth-shell"><div className="aurora" /><section className="auth-card compact">
      <div className="auth-brand"><Shield /><span>First sign-in</span></div>
      <h1>Create a private password</h1><p>Your temporary password must be replaced before you can access production analysis.</p>
      <form onSubmit={submit}>
        <label>Temporary password<input type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required /></label>
        <label>New password<input type="password" value={newPassword} onChange={(e) => setNext(e.target.value)} minLength={12} required /></label>
        <label>Confirm password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={12} required /></label>
        {error && <div className="form-error">{error}</div>}<button className="primary-button">Save new password</button>
      </form>
      <div className="unit-credit auth-credit">© <strong>Digital Transformation Unit</strong></div>
    </section></main>
  );
}

type TraceStep = { label: string; state: "running" | "complete" | "error"; durationMs?: number };

function ProgressCard({ status, elapsed, trace }: { status: string; elapsed: number; trace: TraceStep[] }) {
  const [open, setOpen] = useState(false);
  return <div className="progress-card">
    <button className="progress-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="pulse-dot" /><span className="progress-copy"><strong className="status-transition" key={status}>{status}</strong><small>{elapsed}s elapsed · live workflow</small></span>
      <ChevronDown className={open ? "rotated" : ""} size={17} />
    </button>
    {open && <div className="trace-list">{trace.length ? trace.map((step, index) => <div className="trace-row" key={`${step.label}-${index}`}>
      <span className={`trace-state ${step.state}`}>{step.state === "complete" ? <Check size={12} /> : <span />}</span>
      <span>{step.label}</span><small>{step.durationMs !== undefined ? `${(step.durationMs / 1000).toFixed(1)}s` : step.state}</small>
    </div>) : <p>Waiting for Langflow component events…</p>}</div>}
  </div>;
}

const MessageView = memo(function MessageView({ message, onRetry }: { message: Message; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  if (message.role === "user") return <article className="message user-message"><div>{message.content}</div></article>;
  return <article className={`message assistant-message ${message.status}`}>
    <div className="assistant-avatar"><RobotMark /></div>
    <div className="message-body">
      <div className="message-author">Sugi Prod Analytic <span>AI</span></div>
      {message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : <span className="stream-caret" />}
      {message.status !== "streaming" && <div className="message-actions">
        <button onClick={copy} aria-label="Copy response">{copied ? <Check size={14} /> : <Clipboard size={14} />} {copied ? "Copied" : "Copy"}</button>
        {onRetry && <button onClick={onRetry}><RefreshCcw size={14} /> Retry</button>}
      </div>}
    </div>
  </article>;
});

function AdminPanel({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [resetId, setResetId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<{ users: AdminUser[] }>("/api/admin/users").then((r) => setUsers(r.users)), []);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const data = new FormData(event.currentTarget);
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ email: data.get("email"), displayName: data.get("displayName"), temporaryPassword: data.get("password"), role: data.get("role") }) });
      event.currentTarget.reset(); setFormOpen(false); await load();
    } catch { setError("Could not create this user. Check that the email is unique and the password has 12+ characters."); }
  }
  async function toggle(user: AdminUser) { await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ active: !user.active }) }); await load(); }
  async function resetPassword(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); setError(""); const password = String(new FormData(event.currentTarget).get("password") ?? "");
    try { await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ temporaryPassword: password }) }); setResetId(null); }
    catch { setError("The temporary password must contain at least 12 characters."); }
  }
  return <div className="admin-overlay"><section className="admin-panel">
    <header><div><span className="eyebrow">Administration</span><h2>User access</h2><p>Create and deactivate named accounts. Public registration stays disabled.</p></div><button className="icon-button" onClick={onClose}><X /></button></header>
    <button className="secondary-button" onClick={() => setFormOpen(!formOpen)}><UserRoundPlus size={16} /> Add user</button>
    {formOpen && <form className="admin-form" onSubmit={create}>
      <input name="displayName" placeholder="Display name" required minLength={2} /><input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Temporary password (12+ characters)" required minLength={12} />
      <select name="role" defaultValue="user"><option value="user">User</option><option value="admin">Administrator</option></select>
      {error && <div className="form-error">{error}</div>}<button className="primary-button">Create account</button>
    </form>}
    <div className="user-list">{users.map((u) => <div className="user-card" key={u.id}><div className="user-row"><div className="user-avatar">{u.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{u.displayName}</strong><small>{u.email} · {u.role}</small></div><span className={`status-pill ${u.active ? "active" : "inactive"}`}>{u.active ? "Active" : "Inactive"}</span><div className="user-actions"><button onClick={() => setResetId(resetId === u.id ? null : u.id)}>Reset password</button><button onClick={() => void toggle(u)}>{u.active ? "Deactivate" : "Reactivate"}</button></div></div>{resetId === u.id && <form className="reset-form" onSubmit={(event) => void resetPassword(event, u.id)}><input name="password" type="password" minLength={12} placeholder="New temporary password" required /><button className="secondary-button">Save reset</button></form>}</div>)}</div>
  </section></div>;
}

function ChatApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [status, setStatus] = useState("Understanding your question");
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<number | null>(null);
  const lastMessageLength = messages[messages.length - 1]?.content.length ?? 0;

  const loadConversations = useCallback(async () => {
    const result = await api<{ conversations: Conversation[] }>("/api/conversations"); setConversations(result.conversations);
  }, []);
  useEffect(() => { void loadConversations(); }, [loadConversations]);
  useEffect(() => {
    if (scrollTimer.current !== null) return;
    scrollTimer.current = window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
      scrollTimer.current = null;
    }, runningId ? 80 : 0);
  }, [lastMessageLength, messages.length, runningId]);
  useEffect(() => () => {
    if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
  }, []);
  useEffect(() => {
    if (!runningId) { setElapsed(0); return; }
    const started = Date.now(); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [runningId]);

  const followRun = useCallback(async (runId: string, assistantMessageId: string) => {
    streamController.current?.abort(); const controller = new AbortController(); streamController.current = controller;
    setRunningId(runId); setTrace([]); setStatus("Understanding your question");
    let terminal = false; let lastId: string | undefined; let tokenBuffer = ""; let tokenTimer: number | undefined;
    const takeBufferedTokens = () => {
      if (tokenTimer !== undefined) window.clearTimeout(tokenTimer);
      tokenTimer = undefined; const buffered = tokenBuffer; tokenBuffer = ""; return buffered;
    };
    const flushTokens = () => {
      const buffered = takeBufferedTokens();
      if (buffered) setMessages((current) => current.map((m) => m.id === assistantMessageId ? { ...m, content: m.content + buffered } : m));
    };
    const handle = (event: StreamEvent, id?: string) => {
      lastId = id ?? lastId;
      if (event.type === "status") setStatus(event.label);
      if (event.type === "token") {
        tokenBuffer += event.delta;
        if (tokenTimer === undefined) tokenTimer = window.setTimeout(flushTokens, 50);
      }
      if (event.type === "trace") setTrace((current) => {
        if (event.state === "running") return [...current, event];
        const copy = [...current]; const index = copy.map((s) => s.label).lastIndexOf(event.label);
        if (index >= 0) copy[index] = event; else copy.push(event); return copy;
      });
      if (event.type === "complete") { terminal = true; takeBufferedTokens(); setMessages((current) => current.map((m) => m.id === assistantMessageId ? { ...m, content: event.content, status: "complete" } : m)); setRunningId(null); void loadConversations(); }
      if (event.type === "cancelled") { terminal = true; const buffered = takeBufferedTokens(); setMessages((current) => current.map((m) => m.id === assistantMessageId ? { ...m, content: m.content + buffered, status: "cancelled" } : m)); setRunningId(null); }
      if (event.type === "error") { terminal = true; const buffered = takeBufferedTokens(); setMessages((current) => current.map((m) => m.id === assistantMessageId ? { ...m, content: m.content + buffered || event.message, status: "error" } : m)); setRunningId(null); }
    };
    try {
      for (let attempt = 0; attempt < 3 && !terminal && !controller.signal.aborted; attempt += 1) {
        try { lastId = await streamRun(runId, handle, controller.signal, lastId); }
        catch (error) { if (controller.signal.aborted) return; if (attempt === 2) throw error; await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1))); }
      }
    } catch { if (!controller.signal.aborted) { const buffered = takeBufferedTokens(); setRunningId(null); setMessages((current) => current.map((m) => m.id === assistantMessageId ? { ...m, content: m.content + buffered || "The response stream was interrupted. Please retry.", status: "error" } : m)); } }
    finally { if (tokenTimer !== undefined) window.clearTimeout(tokenTimer); }
  }, [loadConversations]);

  const selectConversation = useCallback(async (id: string) => {
    streamController.current?.abort(); setMobileSidebar(false); setRunningId(null); setTrace([]);
    const result = await api<{ messages: Message[] }>(`/api/conversations/${id}/messages`); setSelectedId(id); setMessages(result.messages);
    const active = result.messages.find((m) => m.status === "streaming" && m.runId);
    if (active?.runId) void followRun(active.runId, active.id);
  }, [followRun]);

  async function submit(content = draft) {
    const text = content.trim(); if (!text || runningId) return;
    let conversationId = selectedId;
    if (!conversationId) {
      const result = await api<{ conversation: Conversation }>("/api/conversations", { method: "POST", body: JSON.stringify({}) });
      conversationId = result.conversation.id; setSelectedId(conversationId); setConversations((c) => [result.conversation, ...c]);
    }
    setDraft(""); const tempUser = `temp-u-${Date.now()}`; const tempAssistant = `temp-a-${Date.now()}`;
    setMessages((current) => [...current, { id: tempUser, role: "user", content: text, status: "complete", createdAt: new Date().toISOString() }, { id: tempAssistant, role: "assistant", content: "", status: "streaming", createdAt: new Date().toISOString() }]);
    try {
      const run = await api<{ runId: string; userMessageId: string; assistantMessageId: string }>(`/api/conversations/${conversationId}/runs`, { method: "POST", body: JSON.stringify({ content: text }) });
      setMessages((current) => current.map((m) => m.id === tempUser ? { ...m, id: run.userMessageId } : m.id === tempAssistant ? { ...m, id: run.assistantMessageId, runId: run.runId } : m));
      await followRun(run.runId, run.assistantMessageId);
    } catch { setMessages((current) => current.map((m) => m.id === tempAssistant ? { ...m, content: "The workflow could not be started. Please try again.", status: "error" } : m)); }
  }

  async function stop() { if (!runningId) return; await api(`/api/runs/${runningId}/cancel`, { method: "POST", body: JSON.stringify({}) }); streamController.current?.abort(); setRunningId(null); setMessages((current) => current.map((m) => m.status === "streaming" ? { ...m, status: "cancelled" } : m)); }
  async function removeConversation(id: string) { if (!window.confirm("Delete this conversation permanently?")) return; await api(`/api/conversations/${id}`, { method: "DELETE" }); if (selectedId === id) { setSelectedId(null); setMessages([]); } await loadConversations(); }
  async function renameConversation(id: string, title: string) { if (!title.trim()) return; await api(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }); setEditingId(null); await loadConversations(); }
  async function logout() { await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }); onLogout(); }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }
  const lastUserText = useMemo(() => [...messages].reverse().find((m) => m.role === "user")?.content, [messages]);

  return <div className={`app-shell ${sidebar ? "sidebar-open" : "sidebar-closed"}`}>
    <div className="app-aurora" />
    {mobileSidebar && <button className="mobile-scrim" onClick={() => setMobileSidebar(false)} aria-label="Close menu" />}
    <aside className={`sidebar ${mobileSidebar ? "mobile-open" : ""}`}>
      <div className="sidebar-brand">
        <img src="/brand/sugihara-wordmark.png" alt="Sugihara Grand Industries" />
        <button className="sidebar-collapse" onClick={() => { setSidebar(false); setMobileSidebar(false); }} aria-label="Collapse conversation history" title="Collapse history"><PanelLeftClose size={18} /></button>
      </div>
      <button className="new-chat" onClick={() => { setSelectedId(null); setMessages([]); setMobileSidebar(false); }}><MessageSquarePlus size={17} /> New analysis</button>
      <div className="history-label">Recent conversations</div>
      <nav className="history-list">{conversations.map((item) => <div className={`history-item ${selectedId === item.id ? "selected" : ""}`} key={item.id}>
        {editingId === item.id ? <input autoFocus defaultValue={item.title} onBlur={(e) => void renameConversation(item.id, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void renameConversation(item.id, e.currentTarget.value); }} /> : <button className="history-title" onClick={() => void selectConversation(item.id)}>{item.title}</button>}
        <div className="history-actions"><button onClick={() => setEditingId(item.id)} aria-label="Rename"><Edit3 size={13} /></button><button onClick={() => void removeConversation(item.id)} aria-label="Delete"><Trash2 size={13} /></button></div>
      </div>)}</nav>
      <div className="sidebar-footer">
        <div className="account"><div className="account-avatar">{user.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{user.displayName}</strong><small>{user.role === "admin" ? "Administrator" : "Approved user"}</small></div></div>
        {user.role === "admin" && <button onClick={() => setAdmin(true)}><Shield size={15} /> Manage users</button>}
        <button onClick={() => void logout()}><LogOut size={15} /> Sign out</button>
        <div className="unit-credit">© <strong>Digital Transformation Unit</strong></div>
      </div>
    </aside>
    <main className="chat-main">
      <header className="topbar">
        <div><button className="icon-button mobile-menu" onClick={() => setMobileSidebar(true)} aria-label="Open conversation history"><Menu /></button>{!sidebar && <button className="icon-button sidebar-reopen" onClick={() => setSidebar(true)} aria-label="Open conversation history" title="Open history"><Menu /></button>}<RobotMark /><div className="topbar-title"><strong>Sugi Prod Analytic</strong><span><i /> Secure connection</span></div></div>
        <button className="icon-button" aria-label="More options"><MoreHorizontal /></button>
      </header>
      <section className={`chat-scroll ${messages.length ? "has-messages" : ""}`}>
        <div className="conversation-stage" key={selectedId ?? "new-conversation"}>
          {!messages.length ? <div className="empty-state"><RobotMark size="large" /><span className="eyebrow">Production intelligence</span><h1>Good decisions start with<br /><em>trusted production data.</em></h1><p>Ask about output, downtime, rejects, OEE, shifts, and the recorded reasons behind production losses.</p><div className="suggestion-grid">{suggestions.map((s) => <button key={s} onClick={() => void submit(s)}>{s}<Send size={14} /></button>)}</div><small className="trust-note"><Shield size={13} /> Answers are produced through approved read-only tools</small></div>
          : <div className="message-list">{messages.map((message, index) => <div className="message-entry" key={message.id}>
            <MessageView message={message} onRetry={message.role === "assistant" && message.status === "error" && lastUserText ? () => void submit(lastUserText) : undefined} />
            {message.role === "assistant" && message.status === "streaming" && index === messages.length - 1 && <ProgressCard status={status} elapsed={elapsed} trace={trace} />}
          </div>)}<div ref={bottomRef} /></div>}
        </div>
      </section>
      <div className="composer-wrap"><div className={`composer ${runningId ? "running" : ""}`}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={keyDown} placeholder="Ask about production performance…" rows={1} disabled={Boolean(runningId)} aria-label="Message" />
        {runningId ? <button className="send-button stop" onClick={() => void stop()} aria-label="Stop response"><Square size={15} fill="currentColor" /></button> : <button className="send-button" onClick={() => void submit()} disabled={!draft.trim()} aria-label="Send message"><Send size={17} /></button>}
      </div><small>Enter to send · Shift + Enter for a new line · AI responses should be verified against approved records</small></div>
    </main>
    {admin && <AdminPanel onClose={() => setAdmin(false)} />}
  </div>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api<{ user: User }>("/api/auth/me").then((r) => { setCsrf(r.user.csrfToken); setUser(r.user); }).catch(() => undefined).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="loading-screen"><RobotMark size="large" /><span>Loading Sugi Prod Analytic…</span></div>;
  if (!user) return <Login onLogin={setUser} />;
  if (user.mustChangePassword) return <ChangePassword onDone={setUser} />;
  return <ChatApp user={user} onLogout={() => { setCsrf(""); setUser(null); }} />;
}
