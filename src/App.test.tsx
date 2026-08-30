import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { CONNECTION_REPLACED_CLOSE_CODE } from './multiplayer';

beforeEach(() => {
  localStorage.clear();
  LifecycleWebSocket.instances = [];
});

class LifecycleWebSocket {
  static OPEN = 1;
  static instances: LifecycleWebSocket[] = [];
  readyState = LifecycleWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = jest.fn();
  close = jest.fn();
  constructor(readonly url: string) { LifecycleWebSocket.instances.push(this); }
}

const privateSessionState = () => ({
  protocolVersion: 'v1', sessionId: 'session-id', joinCode: 'ABC234', revision: 0,
  roomMode: 'private', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hostPlayerId: 'player-id',
  players: [{
    playerId: 'player-id', displayName: 'Ada', connected: true,
    lastSeenAt: new Date().toISOString(), revision: 0, tr: 20,
    resources: Object.fromEntries(['MC', 'Steel', 'Titanium', 'Plants', 'Energy', 'Heat'].map(name => [name, { amount: 0, production: 0 }])),
  }],
});

function renderConnectedPrivateSession() {
  render(<App />);
  fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Ada' } });
  fireEvent.click(screen.getByRole('radio', { name: /Private/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create game' }));
  const socket = LifecycleWebSocket.instances[0];
  act(() => socket.onopen?.());
  const createRequest = JSON.parse(socket.send.mock.calls[0][0]);
  act(() => socket.onmessage?.({ data: JSON.stringify({
    type: 'sessionCreated', sessionId: 'session-id', joinCode: 'ABC234', playerId: 'player-id', roomMode: 'private',
    resumeToken: '0123456789abcdef0123456789abcdef', sessionState: privateSessionState(),
  }) }));
  return { socket, createRequest };
}

test('renders the canonical zero-resource initial state', () => {
  render(<App />);
  expect(screen.getByText('MC: 0')).toBeInTheDocument();
  expect(screen.getByText('Steel: 0')).toBeInTheDocument();
  expect(screen.getByText('TR:')).toBeInTheDocument();
  expect(screen.getByText('20')).toBeInTheDocument();
});

test('TR changes participate in undo and redo', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Increase TR' }));
  expect(screen.getByText('21')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
  expect(screen.getByText('20')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Redo/ }));
  expect(screen.getByText('21')).toBeInTheDocument();
});

test('production never makes a resource amount negative', () => {
  localStorage.setItem('gameState', JSON.stringify({
    tr: 0,
    resources: [
      { id: 'mc', name: 'MC', amount: 0, production: -5, isMegaCredit: true },
      { id: 'steel', name: 'Steel', amount: 0, production: 0 },
      { id: 'titanium', name: 'Titanium', amount: 0, production: 0 },
      { id: 'plants', name: 'Plants', amount: 0, production: 0 },
      { id: 'energy', name: 'Energy', amount: 0, production: 0, isEnergy: true },
      { id: 'heat', name: 'Heat', amount: 0, production: 0, isHeat: true },
    ],
  }));

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Production/ }));
  expect(screen.getByText('MC: 0')).toBeInTheDocument();
});

test('session creation authenticates the host and stores only its resume token locally', () => {
  const originalWebSocket = global.WebSocket;
  class MockWebSocket {
    static OPEN = 1;
    static instances: MockWebSocket[] = [];
    readyState = MockWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(readonly url: string) { MockWebSocket.instances.push(this); }
  }
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  try {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('radio', { name: /Private/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create game' }));
    const connection = MockWebSocket.instances[0];
    act(() => connection.onopen?.());

    const request = JSON.parse(connection.send.mock.calls[0][0]);
    expect(request).toMatchObject({ type: 'createSession', protocolVersion: 'v1', displayName: 'Ada', roomMode: 'private' });
    expect(request.clientId).toEqual(expect.any(String));

    const sessionState = {
      protocolVersion: 'v1', sessionId: 'session-id', joinCode: 'ABC234', revision: 0,
      roomMode: 'private', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hostPlayerId: 'player-id',
      players: [{
        playerId: 'player-id', displayName: 'Ada', connected: true,
        lastSeenAt: new Date().toISOString(), revision: 0, tr: 20,
        resources: Object.fromEntries(['MC', 'Steel', 'Titanium', 'Plants', 'Energy', 'Heat'].map(name => [name, { amount: 0, production: 0 }])),
      }],
    };
    act(() => connection.onmessage?.({ data: JSON.stringify({
      type: 'sessionCreated', sessionId: 'session-id', joinCode: 'ABC234', playerId: 'player-id', roomMode: 'private', resumeToken: '0123456789abcdef0123456789abcdef', sessionState,
    }) }));

    expect(connection.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('multiplayerResumeCredentials')!)).toEqual({
      serverUrl: 'ws://localhost:8080/ws', sessionId: 'session-id', clientId: request.clientId, playerId: 'player-id', roomMode: 'private',
      resumeToken: '0123456789abcdef0123456789abcdef',
    });
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test('a joined player reconnects with its private resume token', () => {
  const originalWebSocket = global.WebSocket;
  jest.useFakeTimers();
  class MockWebSocket {
    static OPEN = 1;
    static instances: MockWebSocket[] = [];
    readyState = MockWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(readonly url: string) { MockWebSocket.instances.push(this); }
  }
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  try {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Ben' } });
    fireEvent.change(screen.getByLabelText('Session ID'), { target: { value: 'session-id' } });
    fireEvent.change(screen.getByLabelText('Join code'), { target: { value: 'abc234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join game' }));
    const firstConnection = MockWebSocket.instances[0];
    act(() => firstConnection.onopen?.());
    const joinRequest = JSON.parse(firstConnection.send.mock.calls[0][0]);
    expect(joinRequest).toMatchObject({ type: 'joinSession', sessionId: 'session-id', joinCode: 'ABC234', displayName: 'Ben' });

    act(() => firstConnection.onmessage?.({ data: JSON.stringify({
      type: 'sessionJoined', sessionId: 'session-id', playerId: 'player-id', playerIndex: 1,
      roomMode: 'private',
      resumeToken: 'fedcba9876543210fedcba9876543210',
    }) }));
    act(() => firstConnection.onclose?.());
    act(() => jest.advanceTimersByTime(1000));

    const resumedConnection = MockWebSocket.instances[1];
    act(() => resumedConnection.onopen?.());
    expect(JSON.parse(resumedConnection.send.mock.calls[0][0])).toMatchObject({
      type: 'resumeSession', sessionId: 'session-id', playerId: 'player-id',
      resumeToken: 'fedcba9876543210fedcba9876543210',
    });
    expect(JSON.parse(resumedConnection.send.mock.calls[0][0])).not.toHaveProperty('clientId');
  } finally {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  }
});

test('a page reload resumes the stored player instead of joining with a public clientId', () => {
  const originalWebSocket = global.WebSocket;
  class MockWebSocket {
    static OPEN = 1;
    static instances: MockWebSocket[] = [];
    readyState = MockWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(readonly url: string) { MockWebSocket.instances.push(this); }
  }
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  localStorage.setItem('multiplayerClientId', 'd4e5f6a7-b8c9-0123-defa-234567890123');
  localStorage.setItem('multiplayerResumeCredentials', JSON.stringify({
    serverUrl: 'ws://192.168.1.20:8080/ws', sessionId: 'session-id',
    clientId: 'd4e5f6a7-b8c9-0123-defa-234567890123', playerId: 'e1f2a3b4-c5d6-7890-efab-012345678901', roomMode: 'private',
    resumeToken: '0123456789abcdef0123456789abcdef',
  }));

  try {
    render(<App />);
    const connection = MockWebSocket.instances[0];
    act(() => connection.onopen?.());
    expect(JSON.parse(connection.send.mock.calls[0][0])).toMatchObject({
      type: 'resumeSession', sessionId: 'session-id', playerId: 'e1f2a3b4-c5d6-7890-efab-012345678901',
      resumeToken: '0123456789abcdef0123456789abcdef',
    });
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test('friends mode needs no token and mutations use the bound player revision', () => {
  const originalWebSocket = global.WebSocket;
  class MockWebSocket {
    static OPEN = 1;
    static instances: MockWebSocket[] = [];
    readyState = MockWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(readonly url: string) { MockWebSocket.instances.push(this); }
  }
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  try {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create game' }));
    const connection = MockWebSocket.instances[0];
    act(() => connection.onopen?.());
    const create = JSON.parse(connection.send.mock.calls[0][0]);
    expect(create.roomMode).toBe('friends');

    const resources = Object.fromEntries(['MC', 'Steel', 'Titanium', 'Plants', 'Energy', 'Heat'].map(name => [name, { amount: 0, production: 0 }]));
    act(() => connection.onmessage?.({ data: JSON.stringify({
      type: 'sessionCreated', sessionId: 'session-id', joinCode: 'ABC234', playerId: 'player-id', roomMode: 'friends',
      sessionState: {
        protocolVersion: 'v1', sessionId: 'session-id', joinCode: 'ABC234', roomMode: 'friends', revision: 8,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hostPlayerId: 'player-id',
        players: [{ playerId: 'player-id', displayName: 'Ada', connected: true, lastSeenAt: new Date().toISOString(), revision: 4, tr: 20, resources }],
      },
    }) }));

    expect(screen.getByRole('button', { name: /Undo/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Increase TR' }));
    const mutation = JSON.parse(connection.send.mock.calls[1][0]);
    expect(mutation).toMatchObject({ type: 'updateTR', sessionId: 'session-id', expectedRevision: 4, tr: 21 });
    expect(mutation).not.toHaveProperty('clientId');
    expect(JSON.parse(localStorage.getItem('multiplayerResumeCredentials')!)).toEqual(expect.objectContaining({
      playerId: 'player-id', roomMode: 'friends', clientId: create.clientId,
    }));
    expect(JSON.parse(localStorage.getItem('multiplayerResumeCredentials')!)).not.toHaveProperty('resumeToken');
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test.each(['', 'abc', 'http://example.com', 'ws://[invalid'])('invalid Server URL %p never constructs a WebSocket', value => {
  const originalWebSocket = global.WebSocket;
  const constructor = jest.fn();
  global.WebSocket = constructor as unknown as typeof WebSocket;

  try {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Create game' }));

    expect(constructor).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Connection status')).toHaveTextContent('Disconnected');
    expect(screen.getByText(/valid WebSocket URL/)).toBeInTheDocument();
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test.each(['ws://localhost:8080/ws', 'wss://example.com/ws'])('valid Server URL %p constructs a WebSocket', value => {
  const originalWebSocket = global.WebSocket;
  const constructor = jest.fn();
  class MockWebSocket {
    close = jest.fn();
    constructor(readonly url: string) { constructor(url); }
  }
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  try {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Create game' }));

    expect(constructor).toHaveBeenCalledWith(value);
    expect(screen.getByLabelText('Connection status')).toHaveTextContent('Connecting');
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test('a synchronous WebSocket constructor failure returns to disconnected', () => {
  const originalWebSocket = global.WebSocket;
  const constructor = jest.fn(() => { throw new Error('unsupported URL'); });
  global.WebSocket = constructor as unknown as typeof WebSocket;

  try {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create game' }));

    expect(constructor).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Connection status')).toHaveTextContent('Disconnected');
    expect(screen.getByText(/Could not connect/)).toBeInTheDocument();
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test('replacement close stops automatic reconnect and preserves credentials', () => {
  const originalWebSocket = global.WebSocket;
  jest.useFakeTimers();
  global.WebSocket = LifecycleWebSocket as unknown as typeof WebSocket;

  try {
    const { socket } = renderConnectedPrivateSession();
    const credentials = localStorage.getItem('multiplayerResumeCredentials');

    act(() => socket.onclose?.({ code: CONNECTION_REPLACED_CLOSE_CODE }));
    act(() => jest.advanceTimersByTime(5000));

    expect(LifecycleWebSocket.instances).toHaveLength(1);
    expect(screen.getByText(/connected in another tab or device/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect here' })).toBeInTheDocument();
    expect(localStorage.getItem('multiplayerResumeCredentials')).toBe(credentials);
  } finally {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  }
});

test('normal disconnect still automatically resumes after one second', () => {
  const originalWebSocket = global.WebSocket;
  jest.useFakeTimers();
  global.WebSocket = LifecycleWebSocket as unknown as typeof WebSocket;

  try {
    const { socket } = renderConnectedPrivateSession();
    act(() => socket.onclose?.({ code: 1006 }));
    act(() => jest.advanceTimersByTime(1000));

    expect(LifecycleWebSocket.instances).toHaveLength(2);
    const resumed = LifecycleWebSocket.instances[1];
    act(() => resumed.onopen?.());
    expect(JSON.parse(resumed.send.mock.calls[0][0])).toMatchObject({
      type: 'resumeSession', sessionId: 'session-id', playerId: 'player-id',
      resumeToken: '0123456789abcdef0123456789abcdef',
    });
  } finally {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  }
});

test('replacement allows one deliberate manual takeover', () => {
  const originalWebSocket = global.WebSocket;
  jest.useFakeTimers();
  global.WebSocket = LifecycleWebSocket as unknown as typeof WebSocket;

  try {
    const { socket } = renderConnectedPrivateSession();
    act(() => socket.onclose?.({ code: CONNECTION_REPLACED_CLOSE_CODE }));
    act(() => jest.advanceTimersByTime(5000));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect here' }));

    expect(LifecycleWebSocket.instances).toHaveLength(2);
    const takeover = LifecycleWebSocket.instances[1];
    act(() => takeover.onopen?.());
    expect(takeover.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(takeover.send.mock.calls[0][0])).toMatchObject({ type: 'resumeSession', playerId: 'player-id' });
  } finally {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  }
});

test('connected Leave keeps credentials and socket until sessionLeft acknowledgement', () => {
  const originalWebSocket = global.WebSocket;
  global.WebSocket = LifecycleWebSocket as unknown as typeof WebSocket;

  try {
    const { socket } = renderConnectedPrivateSession();
    fireEvent.click(screen.getByRole('button', { name: 'Leave game' }));

    expect(JSON.parse(socket.send.mock.calls[1][0])).toMatchObject({ type: 'leaveSession', sessionId: 'session-id' });
    expect(localStorage.getItem('multiplayerResumeCredentials')).not.toBeNull();
    expect(socket.close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Leaving…' })).toBeDisabled();

    act(() => socket.onmessage?.({ data: JSON.stringify({
      type: 'sessionLeft', sessionId: 'session-id', playerId: 'player-id', sessionDeleted: true,
    }) }));

    expect(localStorage.getItem('multiplayerResumeCredentials')).toBeNull();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Connection status')).toHaveTextContent('Disconnected');
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test('offline Leave resumes, sends leave after snapshot, and waits for acknowledgement', () => {
  const originalWebSocket = global.WebSocket;
  jest.useFakeTimers();
  global.WebSocket = LifecycleWebSocket as unknown as typeof WebSocket;

  try {
    const { socket } = renderConnectedPrivateSession();
    act(() => socket.onclose?.({ code: 1006 }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave game' }));

    expect(localStorage.getItem('multiplayerResumeCredentials')).not.toBeNull();
    expect(LifecycleWebSocket.instances).toHaveLength(2);
    const resumed = LifecycleWebSocket.instances[1];
    act(() => resumed.onopen?.());
    expect(JSON.parse(resumed.send.mock.calls[0][0])).toMatchObject({ type: 'resumeSession', playerId: 'player-id' });

    act(() => resumed.onmessage?.({ data: JSON.stringify({ type: 'stateSnapshot', sessionState: privateSessionState() }) }));
    expect(JSON.parse(resumed.send.mock.calls[1][0])).toMatchObject({ type: 'leaveSession', sessionId: 'session-id' });
    expect(localStorage.getItem('multiplayerResumeCredentials')).not.toBeNull();

    act(() => resumed.onmessage?.({ data: JSON.stringify({
      type: 'sessionLeft', sessionId: 'session-id', playerId: 'player-id', sessionDeleted: false,
    }) }));
    expect(localStorage.getItem('multiplayerResumeCredentials')).toBeNull();
    expect(resumed.close).toHaveBeenCalledTimes(1);
  } finally {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  }
});

test('Leave acknowledgement timeout preserves credentials for retry', () => {
  const originalWebSocket = global.WebSocket;
  jest.useFakeTimers();
  global.WebSocket = LifecycleWebSocket as unknown as typeof WebSocket;

  try {
    const { socket } = renderConnectedPrivateSession();
    fireEvent.click(screen.getByRole('button', { name: 'Leave game' }));
    act(() => jest.advanceTimersByTime(4000));

    expect(localStorage.getItem('multiplayerResumeCredentials')).not.toBeNull();
    expect(socket.close).not.toHaveBeenCalled();
    expect(screen.getByText(/Could not confirm leaving/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave game' })).toBeEnabled();
  } finally {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  }
});

test('SESSION_NOT_FOUND while finishing offline Leave safely clears local credentials', () => {
  const originalWebSocket = global.WebSocket;
  jest.useFakeTimers();
  global.WebSocket = LifecycleWebSocket as unknown as typeof WebSocket;

  try {
    const { socket } = renderConnectedPrivateSession();
    act(() => socket.onclose?.({ code: 1006 }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave game' }));
    const resumed = LifecycleWebSocket.instances[1];
    act(() => resumed.onopen?.());
    act(() => resumed.onmessage?.({ data: JSON.stringify({
      type: 'error', errors: [{ code: 'SESSION_NOT_FOUND', message: 'Session does not exist' }],
    }) }));

    expect(localStorage.getItem('multiplayerResumeCredentials')).toBeNull();
    expect(resumed.close).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Connection status')).toHaveTextContent('Disconnected');
  } finally {
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  }
});
