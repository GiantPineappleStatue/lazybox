import { createFileRoute, redirect } from "@tanstack/react-router";
import * as React from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listProposals,
  reviewProposal,
  executeProposal,
  countProposalsByStatus,
  getProposalAction,
  bulkReviewProposals,
} from "~/lib/server/proposals";
import { poll as pollNow } from "~/lib/server/gmail";
import { Badge } from "~/components/ui/badge";
import { Modal } from "~/components/ui/modal";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/proposals")({
  beforeLoad: async ({ context }) => {
    if (!context.user) {
      throw redirect({ to: "/login" });
    }
  },
  component: ProposalsPage,
});

function ProposalsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = React.useState<string | undefined>(undefined);
  const [actionType, setActionType] = React.useState<string>("");
  const [q, setQ] = React.useState<string>("");
  const [dateFrom, setDateFrom] = React.useState<string>("");
  const [dateTo, setDateTo] = React.useState<string>("");
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const toggleSelect = (id: string, v?: boolean) => setSelected((s) => ({ ...s, [id]: v ?? !s[id] }));
  const pageLimit = 20;
  const lastPollClickRef = React.useRef<number>(0);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkDecision, setBulkDecision] = React.useState<"approved" | "rejected">("approved");
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const tabs = [
    { key: undefined as undefined | string, label: "All" },
    { key: "proposed", label: "Proposed" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
    { key: "executed", label: "Executed" },
    { key: "failed", label: "Failed" },
  ] as const;

  // Read initial filters from URL on mount for shareable links
  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const s = sp.get("status");
    const a = sp.get("actionType") ?? "";
    const qq = sp.get("q") ?? "";
    const df = sp.get("dateFrom") ?? "";
    const dt = sp.get("dateTo") ?? "";
    setStatus((s as any) || undefined);
    setActionType(a);
    setQ(qq);
    setDateFrom(df);
    setDateTo(dt);
  }, []);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async (): Promise<{
      gmailAutoPullEnabled: boolean;
      lastPollAt: string | null;
      lastPollFetched: number | null;
      lastPollProposed: number | null;
      lastPollError: string | null;
      gmailLastHistoryId: string | null;
    }> => {
      const res = await fetch("/api/settings", { method: "GET" });
      if (!res.ok) throw new Error("Failed to load settings");
      return (await res.json()) as any;
    },
  });

  const proposalsQuery = useInfiniteQuery({
    queryKey: [
      "proposals",
      {
        status: status || "all",
        actionType: actionType || undefined,
        q: q || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      },
    ],
    initialPageParam: null as string | null,
    getNextPageParam: (last: any) => (last?.page?.hasMore ? last.page.nextCursor : undefined),
    queryFn: async ({ pageParam }) => {
      const res = await listProposals({
        data: {
          status: status as any,
          actionType: actionType || undefined,
          q: q || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          limit: pageLimit,
          cursor: (pageParam as string | null) || undefined,
        },
      });
      return res as unknown as {
        ok: boolean;
        proposals: Array<{
          id: string;
          emailId: string;
          userId: string;
          actionType: string;
          status: string;
          payloadJson: Record<string, unknown>;
          modelMeta: Record<string, unknown>;
          createdAt: string;
          updatedAt: string;
          snippet?: string | null;
          from?: string | null;
          subject?: string | null;
          receivedAt?: string | null;
          threadId?: string | null;
        }>;
        page: { limit: number; cursor: string | null; nextCursor: string | null; hasMore: boolean; totalCount: number };
      };
    },
  });

  const countsQuery = useQuery({
    queryKey: [
      "proposal-counts",
      { actionType: actionType || undefined, q: q || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
    ],
    queryFn: async () => {
      const res = await countProposalsByStatus({ data: { actionType: actionType || undefined, q: q || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined } });
      return res as unknown as { ok: boolean; counts: Record<"proposed" | "approved" | "rejected" | "executed" | "failed", number> };
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await reviewProposal({ data: { proposalId, decision: "approved" } });
      return res as unknown as { ok: boolean; message?: string; code?: string };
    },
    onSuccess: (res) => {
      if (!res.ok) return toast.error(res.message || res.code || "Approve failed");
      toast.success("Proposal approved");
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (e: any) => toast.error(e?.message || "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await reviewProposal({ data: { proposalId, decision: "rejected" } });
      return res as unknown as { ok: boolean; message?: string; code?: string };
    },
    onSuccess: (res) => {
      if (!res.ok) return toast.error(res.message || res.code || "Reject failed");
      toast.success("Proposal rejected");
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (e: any) => toast.error(e?.message || "Reject failed"),
  });

  const bulkReview = useMutation({
    mutationFn: async (input: { ids: string[]; decision: "approved" | "rejected" }) => {
      const res = await bulkReviewProposals({ data: { proposalIds: input.ids, decision: input.decision } });
      return res as unknown as { ok: boolean; updated?: string[]; message?: string; code?: string };
    },
    onSuccess: (res) => {
      if (!res.ok) return toast.error(res.message || res.code || "Bulk review failed");
      toast.success(`Updated ${res.updated?.length ?? 0} proposal(s)`);
      setSelected({});
      qc.invalidateQueries({ queryKey: ["proposals"] });
      qc.invalidateQueries({ queryKey: ["proposal-counts"] });
    },
    onError: (e: any) => toast.error(e?.message || "Bulk review failed"),
  });

  const executeMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await executeProposal({ data: { proposalId } });
      return res as unknown as { ok: boolean; message?: string; code?: string };
    },
    onSuccess: (res) => {
      if (!res.ok) return toast.error(res.message || res.code || "Execute failed");
      toast.success("Execution complete");
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (e: any) => toast.error(e?.message || "Execute failed"),
  });

  const pollMutation = useMutation({
    mutationFn: async () => {
      const now = Date.now();
      if (now - (lastPollClickRef.current || 0) < 5000) {
        return { ok: false, message: "Please wait a few seconds before polling again." } as any;
      }
      lastPollClickRef.current = now;
      const res = await pollNow({ data: { maxResults: 25 } });
      return res as unknown as {
        ok: boolean;
        data?: { disabled: boolean; fetched: number; proposed: number; labelQuery?: string };
        message?: string;
        code?: string;
      };
    },
    onSuccess: (res) => {
      if (!res.ok) return toast.error(res.message || res.code || "Poll failed");
      if (res.data?.disabled) return toast.message("Polling disabled", { description: "Enable auto-pull to run in background." });
      toast.success(`Poll complete. Fetched ${res.data?.fetched ?? 0}, proposed ${res.data?.proposed ?? 0}`);
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (e: any) => toast.error(e?.message || "Poll failed"),
  });

  return (
    <div className="max-w-4xl p-6 space-y-5">
      <div className="flex items-center justify-between" data-testid="proposals-header">
        <h1 className="text-2xl font-semibold">Proposals</h1>
        <div className="flex items-center gap-2">
          <div
            className="hidden sm:flex items-center gap-1"
            data-testid="status-tabs"
            role="tablist"
            aria-label="Status Tabs"
          >
            {tabs.map((t, idx) => {
              const selected = status === t.key || (!status && t.key === undefined);
              const count = t.key
                ? (countsQuery.data?.counts as any)?.[t.key] ?? 0
                : Object.values(countsQuery.data?.counts || {}).reduce((a: number, b: number) => a + b, 0);
              return (
                <button
                  key={String(t.key ?? "all")}
                  ref={(el) => (tabRefs.current[idx] = el)}
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  className={`px-2 py-1 rounded border text-sm ${selected ? "bg-gray-900 text-white" : "bg-white"}`}
                  onClick={() => setStatus(t.key as any)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                    e.preventDefault();
                    const dir = e.key === "ArrowRight" ? 1 : -1;
                    const current = tabs.findIndex((tt) => (status == null ? tt.key === undefined : tt.key === status));
                    const next = (current + dir + tabs.length) % tabs.length;
                    setStatus(tabs[next].key as any);
                    tabRefs.current[next]?.focus();
                  }}
                >
                  {t.label} {countsQuery.isLoading ? "…" : `(${count})`}
                </button>
              );
            })}
          </div>
          <Button
            variant="outline"
            onClick={() => {
              qc.removeQueries({ queryKey: ["proposals"] });
              qc.removeQueries({ queryKey: ["proposal-counts"] });
              proposalsQuery.refetch();
            }}
            data-testid="refresh"
          >
            Refresh
          </Button>
          <Button
            disabled={pollMutation.isPending}
            onClick={() => pollMutation.mutate()}
            data-testid="poll-now"
            aria-busy={pollMutation.isPending}
          >
            {pollMutation.isPending ? "Polling…" : "Poll Now"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2" data-testid="filters">
        <input aria-label="Filter by action type" data-testid="filter-actionType" value={actionType} onChange={(e) => setActionType(e.target.value)} placeholder="Action type" className="border rounded p-2 text-sm" />
        <input aria-label="Search proposals" data-testid="filter-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text" className="border rounded p-2 text-sm w-56" />
        <label className="text-xs text-gray-600" htmlFor="date-from">From</label>
        <input id="date-from" aria-label="Filter from date" data-testid="filter-dateFrom" type="datetime-local" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="border rounded p-1 text-sm" />
        <label className="text-xs text-gray-600" htmlFor="date-to">To</label>
        <input id="date-to" aria-label="Filter to date" data-testid="filter-dateTo" type="datetime-local" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="border rounded p-1 text-sm" />
        <Button
          variant="outline"
          onClick={() => {
            // Persist filters to URL
            const sp = new URLSearchParams();
            if (status) sp.set("status", status);
            if (actionType) sp.set("actionType", actionType);
            if (q) sp.set("q", q);
            if (dateFrom) sp.set("dateFrom", dateFrom);
            if (dateTo) sp.set("dateTo", dateTo);
            const qs = sp.toString();
            const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
            window.history.replaceState(null, "", url);

            qc.removeQueries({ queryKey: ["proposals"] });
            qc.removeQueries({ queryKey: ["proposal-counts"] });
            proposalsQuery.refetch();
            countsQuery.refetch();
          }}
          data-testid="apply-filters"
        >
          Apply
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setStatus(undefined);
            setActionType("");
            setQ("");
            setDateFrom("");
            setDateTo("");
            window.history.replaceState(null, "", window.location.pathname);
            qc.removeQueries({ queryKey: ["proposals"] });
            qc.removeQueries({ queryKey: ["proposal-counts"] });
            proposalsQuery.refetch();
            countsQuery.refetch();
          }}
          data-testid="reset-filters"
        >
          Reset
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            disabled={bulkReview.isPending || Object.keys(selected).filter((k) => selected[k]).length === 0}
            onClick={() => {
              const ids = Object.keys(selected).filter((k) => selected[k]);
              if (ids.length === 0) return;
              setBulkDecision("approved");
              setBulkOpen(true);
            }}
            data-testid="bulk-approve"
          >
            Bulk Approve
          </Button>
          <Button
            variant="destructive"
            disabled={bulkReview.isPending || Object.keys(selected).filter((k) => selected[k]).length === 0}
            onClick={() => {
              const ids = Object.keys(selected).filter((k) => selected[k]);
              if (ids.length === 0) return;
              setBulkDecision("rejected");
              setBulkOpen(true);
            }}
            data-testid="bulk-reject"
          >
            Bulk Reject
          </Button>
        </div>
      </div>

      <div className="rounded border p-3 text-sm text-gray-700 bg-gray-50">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <div>
            <span className="text-gray-500">Auto-pull:</span>{" "}
            {settingsQuery.data?.gmailAutoPullEnabled ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <span className="h-2 w-2 bg-emerald-600 rounded-full" /> On
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-gray-500">
                <span className="h-2 w-2 bg-gray-400 rounded-full" /> Off
              </span>
            )}
          </div>
          <div>
            <span className="text-gray-500">Last Run:</span>{" "}
            {settingsQuery.data?.lastPollAt ? new Date(settingsQuery.data.lastPollAt).toLocaleString() : "—"}
          </div>
          <div>
            <span className="text-gray-500">Fetched:</span> {settingsQuery.data?.lastPollFetched ?? "—"}
            <span className="text-gray-500 ml-4">Proposed:</span> {settingsQuery.data?.lastPollProposed ?? "—"}
          </div>
          <div>
            <span className="text-gray-500">History ID:</span> {settingsQuery.data?.gmailLastHistoryId ?? "—"}
          </div>
        </div>
        {settingsQuery.data?.lastPollError ? (
          <div className="text-red-600 mt-1">Error: {settingsQuery.data.lastPollError}</div>
        ) : null}
      </div>

      {proposalsQuery.isLoading ? (
        <div className="space-y-3" aria-busy="true" aria-live="polite">
          {[0,1,2].map((i) => (
            <div key={i} className="border rounded p-3 animate-pulse">
              <div className="h-5 w-40 bg-gray-200 rounded" />
              <div className="mt-2 h-3 w-3/4 bg-gray-200 rounded" />
              <div className="mt-2 h-24 w-full bg-gray-100 rounded" />
            </div>
          ))}
        </div>
      ) : proposalsQuery.isError ? (
        <div className="text-red-600">Failed to load proposals</div>
      ) : (
        <div className="space-y-3">
          {(proposalsQuery.data?.pages || []).flatMap((pg) => pg.proposals || []).map((p) => (
            <div key={p.id} className="border rounded p-3" data-testid="proposal-card">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <input data-testid="proposal-checkbox" type="checkbox" checked={!!selected[p.id]} onChange={(e) => toggleSelect(p.id, e.target.checked)} />
                  <div className="font-medium">{p.actionType}</div>
                </div>
                <Badge
                  className="capitalize"
                  data-testid="proposal-status"
                  variant={
                    p.status === "approved"
                      ? "success"
                      : p.status === "executed"
                      ? "success"
                      : p.status === "rejected" || p.status === "failed"
                      ? "destructive"
                      : "muted"
                  }
                >
                  {p.status}
                </Badge>
              </div>
              <div className="text-xs text-gray-600 mt-1">
                <div>
                  <span className="text-gray-500">From:</span> {p.from || "—"}
                </div>
                <div>
                  <span className="text-gray-500">Subject:</span> {p.subject || "—"}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">Received:</span> {p.receivedAt ? new Date(p.receivedAt).toLocaleString() : "—"}
                  {p.threadId ? (
                    <a
                      href={`https://mail.google.com/mail/u/0/#all/${p.threadId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-blue-600 underline"
                      data-testid="gmail-link"
                    >
                      Open in Gmail
                    </a>
                  ) : null}
                </div>
              </div>
              {p?.snippet ? (
                <div className="mt-2 text-sm text-gray-700">
                  <div className="text-gray-500 text-xs">Summary</div>
                  <div className="line-clamp-3 whitespace-pre-wrap break-words">{p.snippet}</div>
                </div>
              ) : null}
              <div className="text-sm text-gray-700 mt-2">
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }))}
                  data-testid="toggle-payload"
                >
                  {expanded[p.id] ? "Hide payload" : "Show payload"}
                </button>
                {expanded[p.id] ? (
                  <pre className="mt-1 whitespace-pre-wrap break-words text-xs bg-gray-50 border rounded p-2 max-h-48 overflow-auto">{JSON.stringify(p.payloadJson, null, 2)}</pre>
                ) : null}
              </div>
              <div className="flex gap-2 mt-3">
                <Button
                  variant="secondary"
                  disabled={approveMutation.isPending || p.status !== "proposed"}
                  onClick={() => approveMutation.mutate(p.id)}
                  aria-busy={approveMutation.isPending}
                >
                  {approveMutation.isPending ? "Approving…" : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  disabled={rejectMutation.isPending || (p.status !== "proposed" && p.status !== "approved")}
                  onClick={() => rejectMutation.mutate(p.id)}
                  aria-busy={rejectMutation.isPending}
                >
                  {rejectMutation.isPending ? "Rejecting…" : "Reject"}
                </Button>
                <Button
                  disabled={executeMutation.isPending || (p.status !== "proposed" && p.status !== "approved")}
                  onClick={() => executeMutation.mutate(p.id)}
                  aria-busy={executeMutation.isPending}
                >
                  {executeMutation.isPending ? "Executing…" : "Execute"}
                </Button>
              </div>
              <ActionDetails proposalId={p.id} visible={p.status === "executed" || p.status === "failed"} />
            </div>
          ))}
          {proposalsQuery.data?.pages?.[0]?.proposals?.length === 0 ? (
            <div className="text-sm text-gray-600">No proposals found.</div>
          ) : null}
          <div className="pt-2">
            <Button
              variant="outline"
              disabled={!proposalsQuery.hasNextPage || proposalsQuery.isFetchingNextPage}
              onClick={() => proposalsQuery.fetchNextPage()}
              data-testid="load-more"
              aria-busy={proposalsQuery.isFetchingNextPage}
            >
              {proposalsQuery.isFetchingNextPage ? "Loading…" : proposalsQuery.hasNextPage ? "Load More" : "No More"}
            </Button>
            {proposalsQuery.data?.pages?.[0]?.page?.totalCount != null ? (
              <span className="ml-3 text-xs text-gray-600">Total: {proposalsQuery.data?.pages?.[0]?.page?.totalCount}</span>
            ) : null}
          </div>
        </div>
      )}
      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title={bulkDecision === "approved" ? "Confirm Bulk Approve" : "Confirm Bulk Reject"}
        >
        <div className="space-y-2">
          <div>
            You are about to {bulkDecision} {Object.keys(selected).filter((k) => selected[k]).length} proposal(s).
          </div>
        </div>
        {/* footer injected via children order to keep Modal simple */}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setBulkOpen(false)} data-testid="cancel-bulk">Cancel</Button>
          <Button
            onClick={() => {
              const ids = Object.keys(selected).filter((k) => selected[k]);
              if (ids.length === 0) return setBulkOpen(false);
              bulkReview.mutate({ ids, decision: bulkDecision });
              setBulkOpen(false);
            }}
            data-testid="confirm-bulk"
          >
            Confirm
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function ActionDetails({ proposalId, visible }: { proposalId: string; visible: boolean }) {
  const [open, setOpen] = React.useState<boolean>(false);
  const shouldEnable = visible && open;
  const { data, isLoading, isError } = useQuery({
    enabled: shouldEnable,
    queryKey: ["proposal-action", proposalId],
    queryFn: async () => {
      const res = await getProposalAction({ data: { proposalId } });
      return res as unknown as {
        ok: boolean;
        action: { id: string; status: string; resultJson: Record<string, unknown>; error: string | null; executedAt: string | null; createdAt: string } | null;
      };
    },
  });
  return (
    <div className="mt-2">
      {visible ? (
        <button className="text-xs underline" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide details" : "Show details"}
        </button>
      ) : null}
      {shouldEnable ? (
        <div className="mt-2 border rounded p-2 bg-gray-50">
          {isLoading ? (
            <div className="text-xs">Loading details…</div>
          ) : isError ? (
            <div className="text-xs text-red-600">Failed to load action details</div>
          ) : data?.action ? (
            <div className="space-y-1 text-xs">
              <div>
                <span className="text-gray-500">Status:</span> {data.action.status}
              </div>
              {data.action.error ? (
                <div className="text-red-700">Error: {data.action.error}</div>
              ) : null}
              <div className="text-gray-500">Result</div>
              <pre className="whitespace-pre-wrap break-words bg-white border rounded p-2 max-h-48 overflow-auto">{JSON.stringify(data.action.resultJson ?? {}, null, 2)}</pre>
            </div>
          ) : (
            <div className="text-xs text-gray-600">No action details available.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
