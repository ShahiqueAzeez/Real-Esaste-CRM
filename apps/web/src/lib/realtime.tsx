'use client';
import { RealtimeEvent } from '@crm/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { io, type Socket } from 'socket.io-client';

type Handler = (payload: unknown) => void;

interface RealtimeContextValue {
  connected: boolean;
  subscribe: (event: string, handler: Handler) => () => void;
  emit: (event: string, payload?: unknown) => void;
}

const RealtimeContext = React.createContext<RealtimeContextValue>({ connected: false, subscribe: () => () => undefined, emit: () => undefined });

/**
 * Socket.IO connection authenticated by the session cookie. Realtime only accelerates the UI:
 * queries are invalidated on events and still refetch on their own schedule.
 */
export function RealtimeProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [connected, setConnected] = React.useState(false);
  const socketRef = React.useRef<Socket | null>(null);
  const handlers = React.useRef(new Map<string, Set<Handler>>());
  const qc = useQueryClient();

  React.useEffect(() => {
    if (!enabled) return;
    const url = process.env.NEXT_PUBLIC_SOCKET_URL || undefined;
    const socket = io(url ?? '', { path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.onAny((event: string, payload: unknown) => {
      handlers.current.get(event)?.forEach((h) => h(payload));
      if (event === RealtimeEvent.IMPORT_PROGRESS) void qc.invalidateQueries({ queryKey: ['imports'] });
      if (event === RealtimeEvent.NOTIFICATION) void qc.invalidateQueries({ queryKey: ['notifications'] });
      if (event === RealtimeEvent.CALL_UPDATED || event === RealtimeEvent.AGENT_STATE) void qc.invalidateQueries({ queryKey: ['supervisor', 'board'] });
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled, qc]);

  const value = React.useMemo<RealtimeContextValue>(
    () => ({
      connected,
      subscribe: (event, handler) => {
        if (!handlers.current.has(event)) handlers.current.set(event, new Set());
        handlers.current.get(event)!.add(handler);
        return () => handlers.current.get(event)?.delete(handler);
      },
      emit: (event, payload) => socketRef.current?.emit(event, payload),
    }),
    [connected],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  return React.useContext(RealtimeContext);
}

export function useRealtimeEvent<T>(event: string, handler: (payload: T) => void) {
  const { subscribe } = useRealtime();
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => subscribe(event, (p) => ref.current(p as T)), [event, subscribe]);
}
