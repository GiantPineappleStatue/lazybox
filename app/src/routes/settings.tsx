import { createFileRoute, redirect } from "@tanstack/react-router";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { poll } from "~/lib/server/gmail";

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

  const pollMutation = useMutation({
    mutationFn: async () => {
      const res = await poll({ data: { maxResults: 25 } });
      return res as unknown as { ok: boolean; disabled?: boolean; fetched: number; proposed: number; labelQuery: string; reason?: string };
    },
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.reason || "Poll failed");
        return;
      }
      if (res.disabled) {
        toast.message("Polling disabled", { description: "Enable auto-pull to run in background." });
        return;
      }
      toast.success(`Poll complete: ${res.fetched} new emails, ${res.proposed} proposals`, {
        description: `Query: ${res.labelQuery}`,
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

  if (isLoading) return <div className="p-6">Loading settings…</div>;
  if (isError) return <div className="p-6 text-red-600">Failed to load settings</div>;

  return (
    <div className="max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
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
              <a
                href="/api/gmail/auth"
                className="px-3 py-1.5 bg-blue-600 text-white rounded"
              >
                Connect Gmail
              </a>
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
          <button
            type="submit"
            className="px-4 py-2 bg-black text-white rounded disabled:opacity-50"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
            onClick={() => pollMutation.mutate()}
            disabled={pollMutation.isPending}
          >
            {pollMutation.isPending ? "Polling…" : "Run Poll Now"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint ? <div className="text-xs text-gray-500">{hint}</div> : null}
    </label>
  );
}
