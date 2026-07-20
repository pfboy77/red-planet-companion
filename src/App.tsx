import { v4 as uuidv4 } from "uuid";
import ResourceCard from "./components/ResourceCard";
import { Resource, GameState } from "./types";
import React, { useState, useEffect } from "react";
import { id, resourceIds, SessionState } from "./multiplayer";

const initialResources: Resource[] = [
  { id: uuidv4(), name: "MC", amount: 0, production: 0, isMegaCredit: true },
  { id: uuidv4(), name: "Steel", amount: 0, production: 0 },
  { id: uuidv4(), name: "Titanium", amount: 0, production: 0 },
  { id: uuidv4(), name: "Plants", amount: 0, production: 0 },
  { id: uuidv4(), name: "Energy", amount: 0, production: 0, isEnergy: true },
  { id: uuidv4(), name: "Heat", amount: 0, production: 0, isHeat: true }
];

const buttonStyle = {
  width: "32px",
  height: "32px",
  fontSize: "16px",
  lineHeight: "1",
  textAlign: "center" as const,
};

function App() {
  const savedData = localStorage.getItem("gameState");
  let parsed: Partial<GameState> | null = null;
  if (savedData) {
    try {
      parsed = JSON.parse(savedData);
    } catch {
      localStorage.removeItem("gameState");
    }
  }

  const [resources, setResources] = useState<Resource[]>(
    parsed?.resources || initialResources
  );
  const [tr, setTr] = useState<number>(
    parsed?.tr ?? 20
  );

  const [deltaValues, setDeltaValues] = useState<Record<string, number>>({});
  const [undoStack, setUndoStack] = useState<GameState[]>([]);
  const [redoStack, setRedoStack] = useState<GameState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState("ws://localhost:8080/ws");
  const [displayName, setDisplayName] = useState("");
  const [joinSessionId, setJoinSessionId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [clientId] = useState(() => localStorage.getItem("multiplayerClientId") || id());

  useEffect(() => { localStorage.setItem("multiplayerClientId", clientId); }, [clientId]);
  useEffect(() => () => socket?.close(), [socket]);

  const send = (message: Record<string, unknown>) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ protocolVersion: "v1", requestId: id(), ...message }));
  const connect = (afterOpen: (connection: WebSocket) => void) => {
    if (!displayName.trim()) { setError("Enter your player name first."); return; }
    socket?.close();
    const next = new WebSocket(serverUrl);
    next.onopen = () => { setError(null); afterOpen(next); };
    next.onerror = () => setError("Could not connect to the local server.");
    next.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "sessionCreated") {
        setJoinSessionId(message.sessionId); setJoinCode(message.joinCode);
        next.send(JSON.stringify({ type: "joinSession", protocolVersion: "v1", requestId: id(), sessionId: message.sessionId, joinCode: message.joinCode, clientId, displayName }));
      }
      if (message.sessionState) { setSession(message.sessionState); setError(null); }
      if (message.type === "stateSnapshot") setSession(message.sessionState);
      if (message.type === "error") setError(message.errors?.[0]?.message || "Server rejected the request.");
    };
    setSocket(next);
  };
  const sharedPlayer = session?.players.find(player => player.clientId === clientId);
  const sharedResources = sharedPlayer ? resources.map(resource => ({ ...resource, amount: sharedPlayer.resources[resource.name as keyof typeof sharedPlayer.resources].amount, production: sharedPlayer.resources[resource.name as keyof typeof sharedPlayer.resources].production })) : resources;
  const multiplayerAction = (type: string, values: Record<string, unknown>) => session && send({ type, sessionId: session.sessionId, clientId, actionId: id(), expectedRevision: session.revision, ...values });
  const leaveGame = () => {
    if (session) send({ type: "leaveSession", sessionId: session.sessionId, clientId });
    socket?.close(); setSocket(null); setSession(null); setError(null);
  };

  useEffect(() => {
    const data = JSON.stringify({ resources, tr });
    localStorage.setItem("gameState", data);
  }, [resources, tr]);

  const currentSnapshot = (): GameState => ({
    resources: resources.map(resource => ({ ...resource })),
    tr
  });

  const saveState = () => {
    setUndoStack(previous => [...previous.slice(-19), currentSnapshot()]);
    setRedoStack([]);
  };

  const handleAdd = (id: string) => {
    const delta = deltaValues[id] || 0;
    if (delta <= 0) return;
    const resource = sharedResources.find(item => item.id === id);
    if (session && resource) { multiplayerAction("updateResource", { resourceId: resource.name, amount: delta, operation: "add" }); setDeltaValues({ ...deltaValues, [id]: 0 }); return; }
    saveState();
    setResources(prev =>
      prev.map(r => r.id === id ? { ...r, amount: r.amount + delta } : r)
    );
    setDeltaValues({ ...deltaValues, [id]: 0 });
  };

  const handleSubtract = (id: string) => {
    const resource = sharedResources.find(r => r.id === id);
    const delta = deltaValues[id] || 0;
    if (delta <= 0) return;
    if (resource && delta > resource.amount) {
      setError(`Cannot subtract more than ${resource.amount} ${resource.name}.`);
      setTimeout(() => setError(null), 2000);
      return;
    }
    if (session) { multiplayerAction("updateResource", { resourceId: resource!.name, amount: resource!.amount - delta, operation: "set" }); setDeltaValues({ ...deltaValues, [id]: 0 }); return; }
    saveState();
    setResources(prev =>
      prev.map(r => r.id === id ? { ...r, amount: r.amount - delta } : r)
    );
    setDeltaValues({ ...deltaValues, [id]: 0 });
  };

  const handleProduction = () => {
    if (session) { multiplayerAction("runProduction", {}); return; }
    saveState();
    let newResources = resources.map(resource => ({ ...resource }));
    const energy = newResources.find(r => r.isEnergy);
    const heat = newResources.find(r => r.isHeat);
    if (energy && heat) {
      heat.amount += energy.amount;
      energy.amount = 0;
    }
    newResources = newResources.map(r => ({
      ...r,
      amount: r.amount + r.production + (r.isMegaCredit ? tr : 0)
    }));
    setResources(newResources);
  };

  const handleReset = () => {
    if (session) { multiplayerAction("resetPlayer", {}); return; }
    saveState();
    setResources(resources.map(r => ({ ...r, amount: 0, production: 0 })));
    setTr(20);
  };

  const handleUndo = () => {
    const last = undoStack[undoStack.length - 1];
    if (last) {
      setUndoStack(undoStack.slice(0, -1));
      setRedoStack(previous => [...previous.slice(-19), currentSnapshot()]);
      setResources(last.resources.map(resource => ({ ...resource })));
      setTr(last.tr);
    }
  };

  const handleRedo = () => {
    const next = redoStack[redoStack.length - 1];
    if (next) {
      setRedoStack(redoStack.slice(0, -1));
      setUndoStack(previous => [...previous.slice(-19), currentSnapshot()]);
      setResources(next.resources.map(resource => ({ ...resource })));
      setTr(next.tr);
    }
  };

  const handleTRChange = (delta: number) => {
    const currentTR = sharedPlayer?.tr ?? tr;
    const nextTR = Math.max(0, Math.min(currentTR + delta, 100));
    if (nextTR === currentTR) return;
    if (session) { multiplayerAction("updateTR", { tr: nextTR }); return; }
    saveState();
    setTr(nextTR);
  };

  const handleProductionChange = (id: string, value: number) => {
    const resource = sharedResources.find(item => item.id === id);
    if (!resource || resource.production === value) return;
    if (session) { multiplayerAction("updateProduction", { resourceId: resource.name, production: value }); return; }
    saveState();
    setResources(previous =>
      previous.map(item => item.id === id ? { ...item, production: value } : item)
    );
  };

  return (
    <div style={{ padding: 16, maxWidth: 600, margin: "0 auto" }}>
      <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <strong>Local multiplayer</strong>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          <input aria-label="Server URL" value={serverUrl} onChange={e => setServerUrl(e.target.value)} placeholder="ws://192.168.x.x:8080/ws" />
          <input aria-label="Player name" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name" maxLength={20} />
          {!session && <><button onClick={() => connect(connection => connection.send(JSON.stringify({ type: "createSession", protocolVersion: "v1", requestId: id() })))}>Create game</button><input aria-label="Session ID" value={joinSessionId} onChange={e => setJoinSessionId(e.target.value)} placeholder="Session ID" /><input aria-label="Join code" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="Join code" maxLength={6} /><button onClick={() => connect(connection => connection.send(JSON.stringify({ type: "joinSession", protocolVersion: "v1", requestId: id(), sessionId: joinSessionId, joinCode, clientId, displayName })))}>Join game</button></>}
          {session && <div>Connected — session ID: <strong>{session.sessionId}</strong> · code: <strong>{session.joinCode}</strong> · revision {session.revision} <button onClick={leaveGame}>Leave game</button></div>}
        </div>
      </section>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <button onClick={handleUndo} disabled={undoStack.length === 0}>↩︎ Undo</button>
        <button onClick={handleRedo} disabled={redoStack.length === 0}>↪︎ Redo</button>

        <div style={{ display: "inline-flex", alignItems: "center", marginLeft: 8 }}>
          <span>TR:</span>
          <button
            onClick={() => handleTRChange(-1)}
            aria-label="Decrease TR"
            style={{ ...buttonStyle, marginRight: 4 }}
          >
            −
          </button>
          <span>{sharedPlayer?.tr ?? tr}</span>
          <button
            onClick={() => handleTRChange(1)}
            aria-label="Increase TR"
            style={{ ...buttonStyle, marginLeft: 4 }}
          >
            ＋
          </button>
        </div>

        <button onClick={handleProduction} style={{ backgroundColor: "#007bff", color: "white", padding: "4px 8px", borderRadius: 4 }}>
          ▶︎ Production
        </button>
        <button onClick={handleReset} style={{ backgroundColor: "red", color: "white", padding: "4px 8px", borderRadius: 4 }}>
          Reset
        </button>
      </div>

      {error && <div style={{ color: "red", marginBottom: 8 }}>{error}</div>}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 8,
          marginTop: 16,
        }}
      >
        {sharedResources.map(resource => (
          <ResourceCard
            key={resource.id}
            resource={resource}
            delta={deltaValues[resource.id] || 0}
            setDelta={val => setDeltaValues({ ...deltaValues, [resource.id]: val })}
            addAmount={() => handleAdd(resource.id)}
            subtractAmount={() => handleSubtract(resource.id)}
            updateProduction={val => handleProductionChange(resource.id, val)}
          />
        ))}
      </div>
      {session && <section style={{ marginTop: 20 }}><h3>Other players’ resources</h3>{session.players.filter(player => player.clientId !== clientId).map(player => <div key={player.playerId} style={{ borderTop: "1px solid #ddd", padding: "8px 0" }}><strong>{player.displayName}</strong> {player.connected ? "● online" : "○ offline"} · TR {player.tr}<div>{resourceIds.map(name => `${name}: ${player.resources[name].amount} (${player.resources[name].production >= 0 ? "+" : ""}${player.resources[name].production})`).join(" · ")}</div></div>)}</section>}
    </div>
  );
}

export default App;
