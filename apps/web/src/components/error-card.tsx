"use client";

export function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6">
      <p className="text-sm text-red-700">加载失败：{message}</p>
      <button
        onClick={onRetry}
        className="mt-2 text-sm font-medium text-red-700 underline"
      >
        重试
      </button>
    </div>
  );
}
