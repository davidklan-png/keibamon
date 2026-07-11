// useShareTicket — Friend Interactions Phase 2 share orchestrator.
//
// Owns the FriendPicker modal lifecycle for a "share this ticket" action:
//   requestShare(ticket) → lazily load friends → render <FriendPicker> → on
//   confirm, POST /api/social/shares (saves-if-needed + publishes + notifies)
//   → surface a toast with the audience result (notified_count).
//
// Used by every Save/Share split surface (App's classic builder, MyTickets
// commit) so the share flow is identical everywhere. The caller renders
// `shareNode` in its modal stack and shows `shareToast`.
import { useCallback, useState, type ReactNode } from "react";
import type { CommittedTicket } from "../lib/types";
import { FriendPicker } from "../components/FriendPicker";
import {
  listFriends,
  postShare,
  type AudienceMode,
  type FriendSummary,
} from "./socialClient";

export type ShareToast = { kind: "shared"; n: number } | { kind: "failed" };

export function useShareTicket(getToken: () => Promise<string | null>): {
  requestShare: (ticket: CommittedTicket) => void;
  shareNode: ReactNode;
  shareToast: ShareToast | null;
  clearShareToast: () => void;
} {
  const [ticket, setTicket] = useState<CommittedTicket | null>(null);
  const [friends, setFriends] = useState<FriendSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ShareToast | null>(null);

  const requestShare = useCallback(
    async (tk: CommittedTicket) => {
      setTicket(tk);
      setFriends([]);
      setLoading(true);
      const token = await getToken();
      if (!token) {
        // No token: leave the picker open with an empty friend list — the empty
        // state explains the situation. (Surfaces sign-in via the caller.)
        setLoading(false);
        return;
      }
      const r = await listFriends(token);
      setFriends(r.ok ? r.data.friends : []);
      setLoading(false);
    },
    [getToken],
  );

  const onConfirm = useCallback(
    async (mode: AudienceMode, selected: string[]) => {
      const tk = ticket;
      if (!tk) return;
      setLoading(true);
      const token = await getToken();
      if (!token) {
        setTicket(null);
        setLoading(false);
        setToast({ kind: "failed" });
        return;
      }
      const r = await postShare(token, { ticket: tk, mode, selected });
      setTicket(null);
      setLoading(false);
      setToast(r.ok ? { kind: "shared", n: r.data.notified_count } : { kind: "failed" });
    },
    [ticket, getToken],
  );

  const onCancel = useCallback(() => {
    setTicket(null);
    setLoading(false);
  }, []);

  const node = ticket ? (
    <FriendPicker
      friends={friends}
      loading={loading}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  ) : null;

  return {
    requestShare,
    shareNode: node,
    shareToast: toast,
    clearShareToast: () => setToast(null),
  };
}
