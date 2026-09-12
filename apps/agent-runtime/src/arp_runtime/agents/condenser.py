"""LLM 摘要 condenser（CONTEXT_MODE=condense，实验八）。

fold 模式把旧工具结果替换为固定占位符——零成本但信息全丢，模型需要时只能
重新调工具取回（多花轮次）。condense 模式改为用一次无工具、小输出的模型调用
把内容压成事实摘要（保留路径/行号/报错/测试结论），花小钱保信息。

成本纪律：
- 每条工具结果只摘要一次（按 tool_call_id 缓存），之后每轮复用缓存；
- 摘要调用的 token 计入 attempt 预算并发 MODEL_CALL 事件（诚实口径，
  实验八的对比才有意义）；
- 摘要失败降级为 fold 占位符——condenser 是优化项，绝不能让 attempt 挂掉。
"""

import logging
import time

from langchain_core.messages import HumanMessage, SystemMessage

from arp_runtime.agents.llm import usage_tokens
from arp_runtime.events import EventEmitter

logger = logging.getLogger("arp.condenser")

# 摘要输入上限：超长工具输出只取头尾（报错通常在尾部，签名/路径在头部）
CONDENSE_INPUT_HEAD = 12_000
CONDENSE_INPUT_TAIL = 4_000

CONDENSE_SYSTEM = (
    "你是代码修复 Agent 的上下文压缩器。把给定的工具输出压成不超过 10 行的"
    "事实摘要，只保留后续修代码可能用到的信息：文件路径、行号、函数/类名、"
    "报错类型与关键消息、测试通过/失败结论、diff 是否应用成功。"
    "不要评论、不要建议，直接输出摘要。"
)


def fold_placeholder(n_chars: int) -> str:
    return (f"[已折叠] 此前的工具结果（{n_chars} 字符）。"
            f"如需内容请重新调用工具（read_file 可用行范围）。")


class Condenser:
    """按 tool_call_id 缓存的摘要器。__call__(key, content) -> 摘要文本。"""

    def __init__(self, model: object, emitter: EventEmitter | None = None) -> None:
        self.model = model
        self.emitter = emitter
        self.turn = 0  # 由 agent 节点在每轮前更新，仅用于事件标注
        self.cache: dict[str, str] = {}
        self.used_tokens = 0
        self._new_tokens = 0

    def take_new_tokens(self) -> int:
        """自上次结算以来新增的摘要 token（计入 attempt 预算）。"""
        n = self._new_tokens
        self._new_tokens = 0
        return n

    def _clip(self, content: str) -> str:
        if len(content) <= CONDENSE_INPUT_HEAD + CONDENSE_INPUT_TAIL:
            return content
        return (content[:CONDENSE_INPUT_HEAD] + "\n...[中间截断]...\n"
                + content[-CONDENSE_INPUT_TAIL:])

    def __call__(self, key: str, content: str) -> str:
        if key in self.cache:
            return self.cache[key]
        start = time.monotonic()
        try:
            response = self.model.invoke([
                SystemMessage(content=CONDENSE_SYSTEM),
                HumanMessage(content=self._clip(content)),
            ])
            prompt_tokens, completion_tokens = usage_tokens(response)
            summary = (f"[已压缩摘要，原文 {len(content)} 字符；需要原文请重新调用工具]\n"
                       + str(response.content).strip())
            self.used_tokens += prompt_tokens + completion_tokens
            self._new_tokens += prompt_tokens + completion_tokens
            if self.emitter:
                self.emitter.emit("MODEL_CALL", {
                    "model": f"{getattr(self.model, 'model', 'condenser')}(condenser)",
                    "promptTokens": prompt_tokens,
                    "completionTokens": completion_tokens,
                    "latencyMs": int((time.monotonic() - start) * 1000),
                    "turn": self.turn,
                })
        except Exception:  # noqa: BLE001 摘要失败降级为占位符，不中断 attempt
            logger.exception("condense 调用失败，降级为 fold 占位符")
            summary = fold_placeholder(len(content))
        self.cache[key] = summary
        return summary
