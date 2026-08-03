const STATUS_STYLES: Record<string, string> = {
  // Task
  CREATED: "bg-zinc-100 text-zinc-600",
  QUEUED: "bg-amber-50 text-amber-700",
  AWAITING_APPROVAL: "bg-violet-50 text-violet-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  PR_CREATED: "bg-emerald-100 text-emerald-800",
  PR_FAILED: "bg-red-50 text-red-700",
  RESOLVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-50 text-red-700",
  CANCELLED: "bg-zinc-100 text-zinc-500",
  // Run / Attempt
  PENDING: "bg-zinc-100 text-zinc-600",
  DISPATCHED: "bg-amber-50 text-amber-700",
  RUNNING: "bg-sky-50 text-sky-700",
  VERIFYING: "bg-indigo-50 text-indigo-700",
  INTERRUPTED: "bg-orange-50 text-orange-700",
  RECOVERING: "bg-orange-100 text-orange-800",
  SUCCEEDED: "bg-emerald-50 text-emerald-700",
  FAILED: "bg-red-50 text-red-700",
  CLAIMED: "bg-amber-50 text-amber-700",
  CRASHED: "bg-red-50 text-red-700",
  TIMED_OUT: "bg-red-50 text-red-700",
  LEASE_EXPIRED: "bg-orange-50 text-orange-700",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-zinc-100 text-zinc-600";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {status}
    </span>
  );
}

export function AgentBadge({ kind }: { kind: string }) {
  const isSelf = kind === "SELF_LANGGRAPH";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ${
        isSelf ? "bg-blue-50 text-blue-700" : "bg-fuchsia-50 text-fuchsia-700"
      }`}
    >
      {isSelf ? "自研 LangGraph" : "mini-SWE"}
    </span>
  );
}
