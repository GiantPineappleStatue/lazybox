import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { poll, orchestrate } from "~/lib/server/gmail";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context }) => {
    if (!context.user) {
      throw redirect({ to: "/login" });
    }
  },
  component: SettingsPage,
});

type SettingsPayload = {
  shopDomain: string;
  gmailLabelQuery: string;
  llmProvider: string;
  llmModel: string;
  llmBaseUrl: string;
  hasLlmApiKey: boolean;
  gmailAutoPullEnabled: boolean;
  gmailPollingIntervalSec: number;
  hasGmailToken: boolean;
  lastPollAt: string | null;
  lastPollFetched: number | null;
  lastPollProposed: number | null;
  lastPollError: string | null;
  gmailLastHistoryId: string | null;
};

function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["settings"],
    queryFn: async (): Promise<SettingsPayload> => {
      const res = await fetch("/api/settings", { method: "GET" });
      if (!res.ok) throw new Error("Failed to load settings");
      return (await res.json()) as SettingsPayload;
    },
  });

  // Orchestrate test form
  const [orch, setOrch] = React.useState({ emailId: "test-email", content: "", execute: false });
  const orchestrateMutation = useMutation({
    mutationFn: async () => {
      const res = await orchestrate({ data: { emailId: orch.emailId, content: orch.content, execute: orch.execute } });
      return res as unknown as {
        ok: boolean;
        data?: { proposed: Array<{ id: string; actionType: string }>; executed: Array<{ id: string; actionType: string; ok: boolean; message?: string; code?: string }>; };
        message?: string;
        code?: string;
      };
    },
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.message || res.code || "Orchestrate failed");
        return;
      }
      const p = res.data?.proposed?.length ?? 0;
      const e = res.data?.executed?.length ?? 0;
      toast.success(`Orchestrate complete: ${p} proposed${orch.execute ? `, ${e} executed` : ""}`);
    },
    onError: (e: any) => {
      toast.error(e?.message ?? "Orchestrate failed");
    },
  });

  const pollMutation = useMutation({
    mutationFn: async () => {
      // Add a short cooldown to prevent rapid clicks
      (window as any).__lastSettingsPollClick = (window as any).__lastSettingsPollClick ?? 0;
      const now = Date.now();
      if (now - (window as any).__lastSettingsPollClick < 5000) {
        return { ok: false, message: "Please wait a few seconds before polling again." } as any;
      }
      (window as any).__lastSettingsPollClick = now;
      const res = await poll({ data: { maxResults: 25 } });
      return res as unknown as {
        ok: boolean;
        data?: { disabled: boolean; fetched: number; proposed: number; labelQuery: string };
        message?: string;
        code?: string;
      };
    },
    onSuccess: (res) => {
      if (!res.ok) return toast.error(res.message || res.code || "Poll failed");
      if (res.data?.disabled) return toast.message("Polling disabled", { description: "Enable auto-pull to run in background." });
      toast.success(`Poll complete: ${res.data?.fetched ?? 0} new emails, ${res.data?.proposed ?? 0} proposals`, {
        description: `Query: ${res.data?.labelQuery ?? ""}`,
      });
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e: any) => {
      toast.error(e?.message ?? "Poll failed");
    },
  });

  const [form, setForm] = React.useState({
    shopDomain: "",
    gmailLabelQuery: "",
    llmProvider: "",
    llmModel: "",
    llmBaseUrl: "",
    llmApiKey: "", // write-only
    gmailAutoPullEnabled: false,
    gmailPollingIntervalSec: 300,
  });

  React.useEffect(() => {
    if (data) {
      setForm((prev) => ({
        ...prev,
        shopDomain: data.shopDomain ?? "",
        gmailLabelQuery: data.gmailLabelQuery ?? "",
        llmProvider: data.llmProvider ?? "",
        llmModel: data.llmModel ?? "",
        llmBaseUrl: data.llmBaseUrl ?? "",
        gmailAutoPullEnabled: data.gmailAutoPullEnabled ?? false,
        gmailPollingIntervalSec: data.gmailPollingIntervalSec ?? 300,
      }));
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: async (body: Partial<typeof form>) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      return (await res.json()) as { ok: boolean };
    },
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
      // Clear API key field after successful save
      setForm((prev) => ({ ...prev, llmApiKey: "" }));
    },
    onError: (e: any) => {
      toast.error(e?.message ?? "Failed to save settings");
    },
  });

  const onSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    mutation.mutate(form);
  };

  if (isLoading)
    return (
      <div className="max-w-2xl p-6 space-y-6" aria-busy="true" aria-live="polite">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <div className="animate-pulse space-y-4">
          <div className="h-6 w-40 bg-gray-200 rounded" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-4 w-56 bg-gray-200 rounded" />
              <div className="h-9 w-full bg-gray-100 rounded" />
            </div>
          ))}
          <div className="h-10 w-64 bg-gray-200 rounded" />
        </div>
        <div className="sr-only">Loading settings…</div>
      </div>
    );
  if (isError) return <div className="p-6 text-red-600">Failed to load settings</div>;

  return (
    <div className="max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="flex justify-end">
        <Button asChild>
          <Link to="/proposals">Open Proposals</Link>
        </Button>
      </div>
      <form className="space-y-5" onSubmit={onSubmit}>
        <Field label="Shopify Shop Domain" hint="e.g. r901.myshopify.com">
          <input
            className="w-full border rounded p-2"
            type="text"
            value={form.shopDomain}
            onChange={(e) => setForm((p) => ({ ...p, shopDomain: e.target.value }))}
            placeholder="r901.myshopify.com"
          />
        </Field>

        <Field label="Gmail Label Query" hint="Used when fetching emails">
          <input
            className="w-full border rounded p-2"
            type="text"
            value={form.gmailLabelQuery}
            onChange={(e) => setForm((p) => ({ ...p, gmailLabelQuery: e.target.value }))}
            placeholder="label:customer-inquiries newer_than:7d"
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Enable Gmail Auto-Pull" hint="Poll Gmail periodically and propose actions automatically">
            <input
              className="h-4 w-4"
              type="checkbox"
              checked={form.gmailAutoPullEnabled}
              onChange={(e) => setForm((p) => ({ ...p, gmailAutoPullEnabled: e.target.checked }))}
            />
          </Field>
          <Field label="Polling Interval (seconds)" hint="How often to poll Gmail when enabled">
            <input
              className="w-full border rounded p-2"
              type="number"
              min={60}
              step={30}
              value={form.gmailPollingIntervalSec}
              onChange={(e) => setForm((p) => ({ ...p, gmailPollingIntervalSec: Number(e.target.value || 300) }))}
            />
          </Field>
        </div>

        <div className="rounded border p-3 space-y-2">
          <div className="font-medium">Gmail Connection</div>
          {data?.hasGmailToken ? (
            <div className="text-green-700 text-sm">Connected</div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-gray-600">Not connected</div>
              <Button asChild>
                <a href="/api/gmail/auth">Connect Gmail</a>
              </Button>
            </div>
          )}
        </div>

        <div className="rounded border p-3 space-y-1">
          <div className="font-medium">Last Poll Status</div>
          <div className="text-sm text-gray-700">
            <div>
              <span className="text-gray-500">Last Run:</span>{" "}
              {data?.lastPollAt ? new Date(data.lastPollAt).toLocaleString() : "—"}
            </div>
            <div>
              <span className="text-gray-500">Fetched:</span> {data?.lastPollFetched ?? "—"}
              {"  "}
              <span className="text-gray-500 ml-4">Proposed:</span> {data?.lastPollProposed ?? "—"}
            </div>
            <div>
              <span className="text-gray-500">Last History ID:</span> {data?.gmailLastHistoryId ?? "—"}
            </div>
            {data?.lastPollError ? (
              <div className="text-red-600">Error: {data.lastPollError}</div>
            ) : null}
          </div>
        </div>

        <Field label="LLM Provider" hint="Select your LLM backend">
          <select
            className="w-full border rounded p-2"
            value={form.llmProvider}
            onChange={(e) => setForm((p) => ({ ...p, llmProvider: e.target.value }))}
          >
            <option value="">(not set)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="openrouter">OpenRouter</option>
            <option value="azure-openai">Azure OpenAI</option>
          </select>
        </Field>

        <Field label="LLM Base URL" hint="Optional override (proxy/self-hosted)">
          <input
            className="w-full border rounded p-2"
            type="text"
            value={form.llmBaseUrl}
            onChange={(e) => setForm((p) => ({ ...p, llmBaseUrl: e.target.value }))}
            placeholder="https://api.openai.com/v1"
          />
        </Field>

        <Field label="LLM Model" hint="e.g. gpt-4o, claude-3.7-sonnet, etc.">
          <input
            className="w-full border rounded p-2"
            type="text"
            value={form.llmModel}
            onChange={(e) => setForm((p) => ({ ...p, llmModel: e.target.value }))}
            placeholder="gpt-4o"
          />
        </Field>

        <Field label="LLM API Key" hint={data?.hasLlmApiKey ? "(stored) updating will replace the saved key" : "not set"}>
          <input
            className="w-full border rounded p-2"
            type="password"
            value={form.llmApiKey}
            onChange={(e) => setForm((p) => ({ ...p, llmApiKey: e.target.value }))}
            placeholder={data?.hasLlmApiKey ? "••••••••••••" : "sk-..."}
          />
        </Field>

        <div className="flex gap-3">
          <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" onClick={() => pollMutation.mutate()} disabled={pollMutation.isPending} aria-busy={pollMutation.isPending}>
            {pollMutation.isPending ? "Polling…" : "Run Poll Now"}
          </Button>
          {!data?.hasGmailToken ? (
            <span className="text-xs text-gray-600 self-center">Connect Gmail first to enable full polling.</span>
          ) : null}
        </div>

        {import.meta.env.DEV && (
          <div className="rounded border p-3 space-y-3">
            <div className="font-medium">Orchestrate Test</div>
            <Field label="Email ID" hint="Identifier to associate proposals with">
              <input
                className="w-full border rounded p-2"
                type="text"
                value={orch.emailId}
                onChange={(e) => setOrch((p) => ({ ...p, emailId: e.target.value }))}
                placeholder="email-123"
              />
            </Field>
            <Field label="Email Content" hint="Paste the email body to extract actions">
              <textarea
                className="w-full border rounded p-2 min-h-40"
                value={orch.content}
                onChange={(e) => setOrch((p) => ({ ...p, content: e.target.value }))}
                placeholder="Customer email content..."
              />
            </Field>
            <div className="flex items-center gap-2">
              <input
                id="orch-execute"
                className="h-4 w-4"
                type="checkbox"
                checked={orch.execute}
                onChange={(e) => setOrch((p) => ({ ...p, execute: e.target.checked }))}
              />
              <label htmlFor="orch-execute" className="text-sm">Execute actions immediately (requires Shopify auth)</label>
            </div>
            <div>
              <Button
                type="button"
                onClick={() => orchestrateMutation.mutate()}
                disabled={orchestrateMutation.isPending || !orch.content.trim()}
                aria-busy={orchestrateMutation.isPending}
              >
                {orchestrateMutation.isPending ? (orch.execute ? "Executing…" : "Proposing…") : (orch.execute ? "Propose + Execute" : "Propose Only")}
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const hintId = React.useId();
  let childWithA11y: React.ReactNode = children;
  if (React.isValidElement(children)) {
    const prevDescribedBy = (children.props as any)["aria-describedby"] as string | undefined;
    const describedBy = [prevDescribedBy, hint ? hintId : undefined].filter(Boolean).join(" ") || undefined;
    childWithA11y = (React as any).cloneElement(children as any, { "aria-describedby": describedBy } as any);
  }
  return (
    <label className="block space-y-1">
      <div className="text-sm font-medium">{label}</div>
      {childWithA11y}
      {hint ? (
        <div className="text-xs text-gray-500" id={hintId}>
          {hint}
        </div>
      ) : null}
    </label>
  );
}
