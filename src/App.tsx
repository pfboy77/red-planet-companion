import ResourceCard from "./components/ResourceCard";
import { Resource, GameState } from "./types";
import React, { useState, useEffect, useRef } from "react";
import { clearResumeCredentials, CONNECTION_REPLACED_CLOSE_CODE, ConnectionState, id, normalizeWebSocketUrl, readResumeCredentialsForServer, readServerRegistry, resourceIds, ResumeCredentials, RoomMode, ServerProfile, SessionState, validateWebSocketUrl, writeResumeCredentials, writeServerRegistry } from "./multiplayer";
import { createInitialResources } from "./game/model";
import { changeResource, resetGame, runProduction } from "./game/reducer";

const initialResources = createInitialResources();
const leaveAcknowledgementTimeoutMs = 4000;

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
  const [serverRegistry, setServerRegistry] = useState(() => readServerRegistry());
  const selectedServerProfile = serverRegistry.profiles.find(profile => profile.id === serverRegistry.selectedServerId) ?? null;
  const [serverUrl, setServerUrl] = useState(() => selectedServerProfile?.webSocketURL ?? "");
  const [managingServers, setManagingServers] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [serverNameDraft, setServerNameDraft] = useState("");
  const [serverUrlDraft, setServerUrlDraft] = useState("");
  const [serverFormError, setServerFormError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [joinSessionId, setJoinSessionId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [roomMode, setRoomMode] = useState<RoomMode>("friends");
  const [session, setSession] = useState<SessionState | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [activePlayerId, setActivePlayerId] = useState<string | null>(() => selectedServerProfile ? readResumeCredentialsForServer(selectedServerProfile)?.playerId ?? null : null);
  const [actionPending, setActionPending] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [connectionReplaced, setConnectionReplaced] = useState(false);
  const [clientId] = useState(() => localStorage.getItem("multiplayerClientId") || id());
  const socketRef = useRef<WebSocket | null>(null);
  const resumeCredentialsRef = useRef<ResumeCredentials | null>(selectedServerProfile ? readResumeCredentialsForServer(selectedServerProfile) : null);
  const intentionallyClosedRef = useRef(new WeakSet<WebSocket>());
  const reconnectTimerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const pendingLeaveRef = useRef(false);
  const leaveRequestSentRef = useRef(false);
  const initialResumeAttemptedRef = useRef(false);
  const pendingActionIdRef = useRef<string | null>(null);
  const openConnectionRef = useRef<(url: string, afterOpen?: (connection: WebSocket) => void, resumeCredentials?: ResumeCredentials) => void>(() => {});

  useEffect(() => { localStorage.setItem("multiplayerClientId", clientId); }, [clientId]);
  useEffect(() => () => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
    const current = socketRef.current;
    if (current) { intentionallyClosedRef.current.add(current); current.close(); }
  }, []);

  const send = (message: Record<string, unknown>) => {
    const current = socketRef.current;
    if (!current || current.readyState !== WebSocket.OPEN) return false;
    current.send(JSON.stringify({ protocolVersion: "v1", requestId: id(), ...message }));
    return true;
  };
  const rememberResumeCredentials = (serverUrl: string, sessionId: string, playerId: string, nextRoomMode: RoomMode, resumeToken?: string) => {
    const matchingProfile = serverRegistry.profiles.find(profile => normalizeWebSocketUrl(profile.webSocketURL) === normalizeWebSocketUrl(serverUrl));
    const serverProfileId = resumeCredentialsRef.current?.serverProfileId ?? matchingProfile?.id ?? selectedServerProfile?.id;
    const credentials = {
      serverUrl,
      ...(serverProfileId ? { serverProfileId } : {}),
      sessionId,
      clientId,
      playerId,
      roomMode: nextRoomMode,
      ...(resumeToken ? { resumeToken } : {}),
    };
    resumeCredentialsRef.current = credentials;
    writeResumeCredentials(credentials);
    setActivePlayerId(playerId);
  };
  const closeCurrentSocket = () => {
    const current = socketRef.current;
    if (!current) return;
    intentionallyClosedRef.current.add(current);
    current.close();
    socketRef.current = null;
  };
  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  };
  const clearLeaveTimer = () => {
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = null;
  };
  const cancelLeaveAttempt = (message: string) => {
    clearLeaveTimer();
    pendingLeaveRef.current = false;
    leaveRequestSentRef.current = false;
    setIsLeaving(false);
    setError(message);
  };
  const completeLeave = () => {
    clearLeaveTimer();
    clearReconnectTimer();
    pendingLeaveRef.current = false;
    leaveRequestSentRef.current = false;
    closeCurrentSocket();
    const serverProfileId = resumeCredentialsRef.current?.serverProfileId;
    resumeCredentialsRef.current = null;
    clearResumeCredentials(serverProfileId);
    pendingActionIdRef.current = null;
    setActionPending(false);
    setIsLeaving(false);
    setConnectionReplaced(false);
    setActivePlayerId(null);
    setConnectionState("disconnected");
    setSession(null);
    setError(null);
  };
  const startLeaveTimer = () => {
    clearLeaveTimer();
    leaveTimerRef.current = window.setTimeout(() => {
      cancelLeaveAttempt("Could not confirm leaving the session. Your reconnect credentials were kept; reconnect and try again.");
    }, leaveAcknowledgementTimeoutMs);
  };
  const sendPendingLeave = (sessionId: string) => {
    if (!pendingLeaveRef.current || leaveRequestSentRef.current) return false;
    if (!send({ type: "leaveSession", sessionId })) return false;
    leaveRequestSentRef.current = true;
    startLeaveTimer();
    return true;
  };
  const openConnection = (url: string, afterOpen?: (connection: WebSocket) => void, resumeCredentials?: ResumeCredentials) => {
    if (!validateWebSocketUrl(url)) {
      setConnectionState("disconnected");
      setError("Enter a valid WebSocket URL beginning with ws:// or wss://.");
      return;
    }
    closeCurrentSocket();
    setConnectionReplaced(false);
    setConnectionState(resumeCredentials ? "reconnecting" : "connecting");
    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch {
      setConnectionState("disconnected");
      setError("Could not connect to the local server. Check the Server URL.");
      return;
    }
    socketRef.current = next;
    next.onopen = () => {
      if (socketRef.current !== next) return;
      setConnectionState("joining");
      if (resumeCredentials) {
        const identity = resumeCredentials.roomMode === "private"
          ? { playerId: resumeCredentials.playerId, resumeToken: resumeCredentials.resumeToken }
          : { clientId: resumeCredentials.clientId };
        next.send(JSON.stringify({ type: "resumeSession", protocolVersion: "v1", requestId: id(), sessionId: resumeCredentials.sessionId, ...identity }));
      } else {
        afterOpen?.(next);
      }
    };
    next.onerror = () => {
      if (socketRef.current === next) setError("Could not connect to the local server.");
    };
    next.onmessage = (event) => {
      if (socketRef.current !== next) return;
      let message: any;
      try { message = JSON.parse(event.data); }
      catch { setError("The local server sent an invalid response."); return; }
      if (!message || message.protocolVersion !== "v1") {
        setError("The local server is using an unsupported protocol version.");
        return;
      }
      if (message.type === "sessionCreated") {
        setJoinSessionId(message.sessionId); setJoinCode(message.joinCode);
        setRoomMode(message.roomMode);
        rememberResumeCredentials(url, message.sessionId, message.playerId, message.roomMode, message.resumeToken);
        setSession(message.sessionState);
        setConnectionState("connected");
        setError(null);
        return;
      }
      if (message.type === "sessionJoined") {
        setRoomMode(message.roomMode);
        rememberResumeCredentials(url, message.sessionId, message.playerId, message.roomMode, message.resumeToken);
        return;
      }
      if (message.type === "stateSnapshot") {
        setSession(message.sessionState);
        setConnectionState("connected");
        if (pendingLeaveRef.current && !sendPendingLeave(message.sessionState.sessionId)) {
          cancelLeaveAttempt("Could not send the leave request. Your reconnect credentials were kept.");
        }
        return;
      }
      if (message.type === "sessionLeft") {
        const credentials = resumeCredentialsRef.current;
        if (credentials
          && message.sessionId === credentials.sessionId
          && message.playerId === credentials.playerId) completeLeave();
        return;
      }
      if (message.type === "actionAccepted") {
        setSession(message.sessionState);
        if (message.actionId === pendingActionIdRef.current) {
          pendingActionIdRef.current = null;
          setActionPending(false);
          setError(null);
        }
        return;
      }
      if (message.type === "actionRejected") {
        const code = message.errors?.[0]?.code;
        setError(code === "STALE_REVISION"
          ? "Another update won the race. This action was not applied; the latest state is now shown."
          : message.errors?.[0]?.message || "Server rejected the action.");
        if (message.actionId === pendingActionIdRef.current) {
          pendingActionIdRef.current = null;
          setActionPending(false);
        }
        return;
      }
      if (message.type === "error") {
        const code = message.errors?.[0]?.code;
        const errorMessage = message.errors?.[0]?.message || "Server rejected the request.";
        if (pendingLeaveRef.current && ["SESSION_NOT_FOUND", "PLAYER_NOT_FOUND"].includes(code)) {
          completeLeave();
          return;
        }
        if (pendingLeaveRef.current) {
          cancelLeaveAttempt(`${errorMessage} Your reconnect credentials were kept.`);
          setConnectionState("disconnected");
          setSession(null);
          return;
        }
        setError(errorMessage);
        setConnectionState("disconnected");
        if (["AUTHENTICATION_FAILED", "PLAYER_NOT_FOUND", "SESSION_NOT_FOUND"].includes(code)) {
          const serverProfileId = resumeCredentialsRef.current?.serverProfileId;
          resumeCredentialsRef.current = null;
          clearResumeCredentials(serverProfileId);
          setSession(null);
          setActivePlayerId(null);
        }
      }
    };
    next.onclose = (event) => {
      if (socketRef.current === next) socketRef.current = null;
      if (intentionallyClosedRef.current.has(next)) return;
      pendingActionIdRef.current = null;
      setActionPending(false);
      clearLeaveTimer();
      leaveRequestSentRef.current = false;
      setSession(null);
      if (event?.code === CONNECTION_REPLACED_CLOSE_CODE) {
        pendingLeaveRef.current = false;
        setIsLeaving(false);
        setConnectionReplaced(true);
        setConnectionState("disconnected");
        setError("This player is connected in another tab or device. Automatic reconnect was stopped.");
        return;
      }
      setConnectionReplaced(false);
      if (pendingLeaveRef.current) startLeaveTimer();
      setError(pendingLeaveRef.current ? "Connection lost while leaving. Reconnecting to finish…" : "Connection lost. Reconnecting…");
      const credentials = resumeCredentialsRef.current;
      if (!credentials || reconnectTimerRef.current !== null) { setConnectionState("disconnected"); setSession(null); return; }
      setConnectionState("reconnecting");
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        const latest = resumeCredentialsRef.current;
        if (latest) openConnection(latest.serverUrl, undefined, latest);
      }, 1000);
    };
  };
  openConnectionRef.current = openConnection;
  useEffect(() => {
    if (initialResumeAttemptedRef.current) return;
    initialResumeAttemptedRef.current = true;
    const credentials = resumeCredentialsRef.current;
    if (!credentials) return;
    if (credentials.clientId !== clientId) {
      resumeCredentialsRef.current = null;
      clearResumeCredentials(credentials.serverProfileId);
      return;
    }
    setServerUrl(credentials.serverUrl);
    setJoinSessionId(credentials.sessionId);
    openConnectionRef.current(credentials.serverUrl, undefined, credentials);
  }, [clientId]);
  const connect = (afterOpen: (connection: WebSocket) => void) => {
    if (!displayName.trim()) { setError("Enter your player name first."); return; }
    resumeCredentialsRef.current = null;
    clearResumeCredentials(selectedServerProfile?.id);
    setActivePlayerId(null);
    setSession(null);
    setConnectionReplaced(false);
    openConnection(serverUrl, afterOpen);
  };
  const sharedPlayer = session?.players.find(player => player.playerId === activePlayerId);
  const sharedResources = sharedPlayer ? resources.map(resource => ({ ...resource, amount: sharedPlayer.resources[resource.name as keyof typeof sharedPlayer.resources].amount, production: sharedPlayer.resources[resource.name as keyof typeof sharedPlayer.resources].production })) : resources;
  const multiplayerAction = (type: string, values: Record<string, unknown>) => {
    if (!session || !sharedPlayer || connectionState !== "connected") { setError("Reconnect to the local server before making changes."); return false; }
    if (actionPending) return false;
    const actionId = id();
    pendingActionIdRef.current = actionId;
    setActionPending(true);
    if (send({ type, sessionId: session.sessionId, actionId, expectedRevision: sharedPlayer.revision, ...values })) return true;
    pendingActionIdRef.current = null;
    setActionPending(false);
    setError("The action could not be sent. Reconnect and try again.");
    return false;
  };
  const leaveGame = () => {
    if (isLeaving) return;
    const credentials = resumeCredentialsRef.current;
    if (!credentials) { setError("No reconnect credentials are available to confirm leaving this session."); return; }
    pendingLeaveRef.current = true;
    leaveRequestSentRef.current = false;
    pendingActionIdRef.current = null;
    setActionPending(false);
    setIsLeaving(true);
    setConnectionReplaced(false);
    setError(null);
    startLeaveTimer();
    if (session && connectionState === "connected") {
      if (!sendPendingLeave(session.sessionId)) cancelLeaveAttempt("Could not send the leave request. Your reconnect credentials were kept.");
      return;
    }
    clearReconnectTimer();
    openConnection(credentials.serverUrl, undefined, credentials);
  };
  const reconnectHere = () => {
    const credentials = resumeCredentialsRef.current;
    if (!credentials) { setError("No reconnect credentials are available."); return; }
    setConnectionReplaced(false);
    setError(null);
    openConnection(credentials.serverUrl, undefined, credentials);
  };
  const multiplayerActive = activePlayerId !== null || connectionState !== "disconnected";
  const multiplayerControlsDisabled = multiplayerActive && (connectionState !== "connected" || actionPending || isLeaving);
  const serverManagementLocked = isLeaving
    || connectionState === "connected"
    || connectionState === "connecting"
    || connectionState === "joining";

  const persistServerRegistry = (profiles: ServerProfile[], selectedServerId: string | null) => {
    const next = { profiles, selectedServerId };
    writeServerRegistry(next);
    setServerRegistry(next);
  };
  const resetConnectionForServerChange = () => {
    clearReconnectTimer();
    closeCurrentSocket();
    pendingActionIdRef.current = null;
    setActionPending(false);
    setConnectionReplaced(false);
    setConnectionState("disconnected");
    setSession(null);
    setError(null);
  };
  const activateServerProfile = (profile: ServerProfile, profiles = serverRegistry.profiles) => {
    if (serverManagementLocked) return;
    resetConnectionForServerChange();
    persistServerRegistry(profiles, profile.id);
    setServerUrl(profile.webSocketURL);
    setJoinCode("");

    const credentials = readResumeCredentialsForServer(profile);
    if (!credentials || credentials.clientId !== clientId) {
      resumeCredentialsRef.current = null;
      setActivePlayerId(null);
      setJoinSessionId("");
      setRoomMode("friends");
      if (credentials) clearResumeCredentials(profile.id);
      return;
    }

    resumeCredentialsRef.current = credentials;
    setActivePlayerId(credentials.playerId);
    setJoinSessionId(credentials.sessionId);
    setRoomMode(credentials.roomMode);
    openConnection(profile.webSocketURL, undefined, credentials);
  };
  const clearSelectedServer = (profiles: ServerProfile[]) => {
    resetConnectionForServerChange();
    resumeCredentialsRef.current = null;
    setActivePlayerId(null);
    setServerUrl("");
    setJoinSessionId("");
    setJoinCode("");
    setRoomMode("friends");
    persistServerRegistry(profiles, null);
  };
  const beginAddingServer = () => {
    if (serverManagementLocked) return;
    setEditingServerId("new");
    setServerNameDraft("");
    setServerUrlDraft("");
    setServerFormError(null);
  };
  const beginEditingServer = (profile: ServerProfile) => {
    if (serverManagementLocked) return;
    setEditingServerId(profile.id);
    setServerNameDraft(profile.name);
    setServerUrlDraft(profile.webSocketURL);
    setServerFormError(null);
  };
  const cancelEditingServer = () => {
    setEditingServerId(null);
    setServerFormError(null);
  };
  const saveServerProfile = () => {
    if (serverManagementLocked) return;
    const name = serverNameDraft.trim();
    const normalizedUrl = normalizeWebSocketUrl(serverUrlDraft);
    if (!name || name.length > 50) {
      setServerFormError("Server name must contain 1 to 50 characters.");
      return;
    }
    if (!normalizedUrl) {
      setServerFormError("Enter a valid WebSocket URL beginning with ws:// or wss://.");
      return;
    }
    const timestamp = new Date().toISOString();
    if (editingServerId === "new") {
      const created: ServerProfile = { id: id(), name, webSocketURL: normalizedUrl, createdAt: timestamp, updatedAt: timestamp };
      const selectedId = serverRegistry.selectedServerId ?? created.id;
      const profiles = [...serverRegistry.profiles, created];
      if (selectedId === created.id) activateServerProfile(created, profiles);
      else persistServerRegistry(profiles, selectedId);
    } else {
      const previous = serverRegistry.profiles.find(profile => profile.id === editingServerId);
      if (!previous) return;
      const urlChanged = normalizeWebSocketUrl(previous.webSocketURL) !== normalizedUrl;
      if (urlChanged) clearResumeCredentials(previous.id);
      const updated = { ...previous, name, webSocketURL: normalizedUrl, updatedAt: timestamp };
      const profiles = serverRegistry.profiles.map(profile => profile.id === updated.id ? updated : profile);
      if (serverRegistry.selectedServerId === updated.id && urlChanged) activateServerProfile(updated, profiles);
      else {
        persistServerRegistry(profiles, serverRegistry.selectedServerId);
        if (serverRegistry.selectedServerId === updated.id) setServerUrl(updated.webSocketURL);
      }
    }
    setEditingServerId(null);
    setServerFormError(null);
  };
  const selectServerProfile = (profileId: string) => {
    const profile = serverRegistry.profiles.find(candidate => candidate.id === profileId);
    if (!profile) return;
    activateServerProfile(profile);
  };
  const deleteServerProfile = (profile: ServerProfile) => {
    if (serverManagementLocked) return;
    if (!window.confirm(`Delete ${profile.name}?`)) return;
    clearResumeCredentials(profile.id);
    const profiles = serverRegistry.profiles.filter(candidate => candidate.id !== profile.id);
    if (serverRegistry.selectedServerId === profile.id) {
      const fallback = profiles[0];
      if (fallback) activateServerProfile(fallback, profiles);
      else clearSelectedServer(profiles);
    } else {
      persistServerRegistry(profiles, serverRegistry.selectedServerId);
    }
    if (editingServerId === profile.id) cancelEditingServer();
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
    if (multiplayerActive && resource) { if (multiplayerAction("updateResource", { resourceId: resource.name, amount: delta, operation: "add" })) setDeltaValues({ ...deltaValues, [id]: 0 }); return; }
    const next = changeResource({ resources, tr }, id, delta);
    if (!next) return;
    saveState();
    setResources(next.resources);
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
    if (multiplayerActive) { if (multiplayerAction("updateResource", { resourceId: resource!.name, amount: resource!.amount - delta, operation: "set" })) setDeltaValues({ ...deltaValues, [id]: 0 }); return; }
    const next = changeResource({ resources, tr }, id, -delta);
    if (!next) return;
    saveState();
    setResources(next.resources);
    setDeltaValues({ ...deltaValues, [id]: 0 });
  };

  const handleProduction = () => {
    if (multiplayerActive) { multiplayerAction("runProduction", {}); return; }
    saveState();
    const next = runProduction({ resources, tr });
    setResources(next.resources);
  };

  const handleReset = () => {
    if (multiplayerActive) { multiplayerAction("resetPlayer", {}); return; }
    saveState();
    const next = resetGame({ resources, tr });
    setResources(next.resources);
    setTr(next.tr);
  };

  const handleUndo = () => {
    if (multiplayerActive) return;
    const last = undoStack[undoStack.length - 1];
    if (last) {
      setUndoStack(undoStack.slice(0, -1));
      setRedoStack(previous => [...previous.slice(-19), currentSnapshot()]);
      setResources(last.resources.map(resource => ({ ...resource })));
      setTr(last.tr);
    }
  };

  const handleRedo = () => {
    if (multiplayerActive) return;
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
    if (multiplayerActive) { multiplayerAction("updateTR", { tr: nextTR }); return; }
    saveState();
    setTr(nextTR);
  };

  const handleProductionChange = (id: string, value: number) => {
    const resource = sharedResources.find(item => item.id === id);
    if (!resource || resource.production === value) return;
    if (multiplayerActive) { multiplayerAction("updateProduction", { resourceId: resource.name, production: value }); return; }
    saveState();
    setResources(previous =>
      previous.map(item => item.id === id ? { ...item, production: value } : item)
    );
  };
  const connectionLabel: Record<ConnectionState, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting…",
    joining: "Joining…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
  };

  return (
    <div style={{ padding: 16, maxWidth: 600, margin: "0 auto" }}>
      <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <strong>Multiplayer</strong>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          <label htmlFor="server-profile">Server</label>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <select
              id="server-profile"
              aria-label="Server"
              value={serverRegistry.selectedServerId ?? ""}
              onChange={event => selectServerProfile(event.target.value)}
              disabled={serverManagementLocked || serverRegistry.profiles.length === 0}
              style={{ flex: 1, minHeight: 44 }}
            >
              {serverRegistry.profiles.length === 0 && <option value="">Add a server first</option>}
              {serverRegistry.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <button type="button" onClick={() => setManagingServers(value => !value)} style={{ minHeight: 44 }}>
              {managingServers ? "Close server manager" : "Manage servers"}
            </button>
          </div>
          {selectedServerProfile && <small>{selectedServerProfile.webSocketURL}</small>}
          {managingServers && <div aria-label="Registered servers" style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, display: "grid", gap: 12 }}>
            <strong>Registered servers</strong>
            {serverRegistry.profiles.length === 0
              ? <p>No servers registered. Add one to use multiplayer.</p>
              : <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
                {serverRegistry.profiles.map(profile => <li key={profile.id} style={{ borderBottom: "1px solid #ddd", paddingBottom: 10 }}>
                  <div><strong>{profile.name}</strong>{profile.id === serverRegistry.selectedServerId ? " · Selected" : ""}</div>
                  <div style={{ overflowWrap: "anywhere" }}>{profile.webSocketURL}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                    {profile.id !== serverRegistry.selectedServerId && <button type="button" onClick={() => selectServerProfile(profile.id)} disabled={serverManagementLocked} style={{ minHeight: 44 }}>Select {profile.name}</button>}
                    <button type="button" onClick={() => beginEditingServer(profile)} disabled={serverManagementLocked} style={{ minHeight: 44 }}>Edit {profile.name}</button>
                    <button type="button" onClick={() => deleteServerProfile(profile)} disabled={serverManagementLocked} style={{ minHeight: 44, color: "#b42318" }}>Delete {profile.name}</button>
                  </div>
                </li>)}
              </ul>}
            <button type="button" onClick={beginAddingServer} disabled={serverManagementLocked} style={{ minHeight: 44 }}>Add server</button>
            {editingServerId && <fieldset style={{ display: "grid", gap: 8 }}>
              <legend>{editingServerId === "new" ? "Add server" : "Edit server"}</legend>
              <label htmlFor="server-name">Server name</label>
              <input id="server-name" aria-label="Server name" value={serverNameDraft} onChange={event => setServerNameDraft(event.target.value)} maxLength={50} />
              <label htmlFor="server-websocket-url">WebSocket URL</label>
              <input id="server-websocket-url" aria-label="WebSocket URL" value={serverUrlDraft} onChange={event => setServerUrlDraft(event.target.value)} placeholder="wss://mars.example.com/ws" />
              {serverFormError && <div role="alert" style={{ color: "#b42318" }}>{serverFormError}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={saveServerProfile} style={{ minHeight: 44 }}>Save server</button>
                <button type="button" onClick={cancelEditingServer} style={{ minHeight: 44 }}>Cancel</button>
              </div>
            </fieldset>}
          </div>}
          <input aria-label="Player name" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name" maxLength={20} />
          <div aria-label="Connection status">{connectionLabel[connectionState]}</div>
          {!multiplayerActive && <>
            <fieldset>
              <legend>Room mode</legend>
              <label><input type="radio" name="roomMode" value="friends" checked={roomMode === "friends"} onChange={() => setRoomMode("friends")} /> Friends — easy joining on a trusted LAN</label>
              <label style={{ display: "block" }}><input type="radio" name="roomMode" value="private" checked={roomMode === "private"} onChange={() => setRoomMode("private")} /> Private — stronger automatic reconnect identity</label>
            </fieldset>
            <button onClick={() => connect(connection => connection.send(JSON.stringify({ type: "createSession", protocolVersion: "v1", requestId: id(), clientId, displayName: displayName.trim(), roomMode })))}>Create game</button>
            <input aria-label="Session ID" value={joinSessionId} onChange={e => setJoinSessionId(e.target.value)} placeholder="Session ID" />
            <input aria-label="Join code" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="Join code" maxLength={6} />
            <button onClick={() => connect(connection => connection.send(JSON.stringify({ type: "joinSession", protocolVersion: "v1", requestId: id(), sessionId: joinSessionId, joinCode, clientId, displayName: displayName.trim() })))}>Join game</button>
          </>}
          {multiplayerActive && <div>{session && <>session ID: <strong>{session.sessionId}</strong> · code: <strong>{session.joinCode}</strong> · {session.roomMode} · revision {session.revision} </>}<button onClick={leaveGame} disabled={isLeaving}>{isLeaving ? "Leaving…" : "Leave game"}</button>{connectionReplaced && <button onClick={reconnectHere}>Reconnect here</button>}</div>}
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
        <button onClick={handleUndo} disabled={multiplayerActive || undoStack.length === 0}>↩︎ Undo</button>
        <button onClick={handleRedo} disabled={multiplayerActive || redoStack.length === 0}>↪︎ Redo</button>

        <div style={{ display: "inline-flex", alignItems: "center", marginLeft: 8 }}>
          <span>TR:</span>
          <button
            onClick={() => handleTRChange(-1)}
            disabled={multiplayerControlsDisabled}
            aria-label="Decrease TR"
            style={{ ...buttonStyle, marginRight: 4 }}
          >
            −
          </button>
          <span>{sharedPlayer?.tr ?? tr}</span>
          <button
            onClick={() => handleTRChange(1)}
            disabled={multiplayerControlsDisabled}
            aria-label="Increase TR"
            style={{ ...buttonStyle, marginLeft: 4 }}
          >
            ＋
          </button>
        </div>

        <button onClick={handleProduction} disabled={multiplayerControlsDisabled} style={{ backgroundColor: "#007bff", color: "white", padding: "4px 8px", borderRadius: 4 }}>
          ▶︎ Production
        </button>
        <button onClick={handleReset} disabled={multiplayerControlsDisabled} style={{ backgroundColor: "red", color: "white", padding: "4px 8px", borderRadius: 4 }}>
          Reset
        </button>
      </div>

      {error && <div role="alert" style={{ color: "red", marginBottom: 8 }}>{error}</div>}

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
            disabled={multiplayerControlsDisabled}
          />
        ))}
      </div>
      {session && <section style={{ marginTop: 20 }}><h3>Other players’ resources</h3>{session.players.filter(player => player.playerId !== activePlayerId).map(player => <div key={player.playerId} style={{ borderTop: "1px solid #ddd", padding: "8px 0" }}><strong>{player.displayName}</strong> {player.connected ? "● online" : "○ offline"} · TR {player.tr}<div>{resourceIds.map(name => `${name}: ${player.resources[name].amount} (${player.resources[name].production >= 0 ? "+" : ""}${player.resources[name].production})`).join(" · ")}</div></div>)}</section>}
    </div>
  );
}

export default App;
