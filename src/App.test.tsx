import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  localStorage.clear();
});

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
