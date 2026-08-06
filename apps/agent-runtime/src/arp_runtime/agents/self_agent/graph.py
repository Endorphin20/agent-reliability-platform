"""自研 LangGraph 修复 Agent（T6）。

图结构（对应计划的 diagnose→plan→edit→test 循环）：
    agent --tool_calls--> tools --> agent --FINISH/预算/卡死--> END
diagnose 与 plan 体现在首轮系统提示与模型自然输出；edit/test 是 tools 节点
中 apply_patch / run_command 的执行。

可恢复性设计：
- checkpointer = LangGraph PostgresSaver，thread_id = runId：崩溃后从最近
  已保存的图状态继续（消息历史完整保留）；
- 每次 MODEL_CALL 后累计 token 并发 BUDGET_UPDATE；超限抛 BudgetExceeded；
- 卡死检测（§4.6 AGENT_STUCK）：连续 3 轮完全相同的工具调用集合。
"""

import json
import time
from typing import Annotated, Any, TypedDict

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages

from arp_runtime.agents.llm import usage_tokens
from arp_runtime.events import EventEmitter
from arp_runtime.schemas.run_command import RunCommand
from arp_runtime.tools.toolset import Toolset

MAX_STUCK_REPEATS = 3


class BudgetExceeded(Exception):
    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(f"预算超限 {kind}: {detail}")
        self.kind = kind  # tokens | seconds | turns


class AgentStuck(Exception):
    pass


class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    turn: int
    used_tokens: int  # 跨 attempt 累计（随 LangGraph checkpoint 恢复）
    stuck_signatures: list[str]
    done: bool


SYSTEM_PROMPT = """你是一个自动代码修复 Agent，在隔离沙箱中工作。流程要求：
1. diagnose：先用 search_code 定位相关代码的文件与行号，再用 read_file 的
   start_line/end_line 读取目标区间；
2. plan：简述修复方案（一两句话即可）；
3. edit：用 apply_patch 提交 unified diff（上下文行必须与原文件精确一致）；
4. test：用 run_command 运行任务给出的测试命令验证。
上下文纪律（重要，token 预算有限）：
- 绝不整读大文件：先 search_code 拿到行号，再按 100-200 行的窗口读取；
- read_file 输出带 `行号|` 前缀，仅用于定位——写 diff 时绝不要把行号前缀
  带进补丁内容；
- 较早轮次的工具输出会被折叠，需要时用行范围重新读取。
约束：只修改任务允许的路径；绝不修改测试文件；测试全部通过后输出 FINISH。
节约轮次：不要反复读同一文件或用 run_command 探索目录结构，
诊断信息足够后立即动手修改。
"""

# 消息修剪：仅最近 K 条工具结果保留全文，更早的替换为占位摘要。
# 只影响发给模型的输入，不动 LangGraph checkpoint 里的完整历史
# （failure-analysis RC2：历史零修剪导致每轮固定背 37-48k token）。
PRUNE_KEEP_LAST_TOOL_RESULTS = 8
PRUNE_MIN_CHARS = 1_500


def prune_messages(messages: list[BaseMessage]) -> list[BaseMessage]:
    tool_indexes = [
        i for i, m in enumerate(messages) if isinstance(m, ToolMessage)
    ]
    to_fold = set(tool_indexes[:-PRUNE_KEEP_LAST_TOOL_RESULTS])
    pruned: list[BaseMessage] = []
    for i, message in enumerate(messages):
        content = message.content if isinstance(message.content, str) else ""
        if i in to_fold and len(content) > PRUNE_MIN_CHARS:
            pruned.append(ToolMessage(
                content=(f"[已折叠] 此前的工具结果（{len(content)} 字符）。"
                         f"如需内容请重新调用工具（read_file 可用行范围）。"),
                tool_call_id=message.tool_call_id,  # type: ignore[union-attr]
            ))
        else:
            pruned.append(message)
    return pruned


def build_task_prompt(command: RunCommand) -> str:
    spec = command.taskSpec
    if spec.workdir in ("", "."):
        # swebench 套件：真实上游仓库，工作目录就是仓库根（不是 monorepo）
        layout = (
            "仓库布局: 单体仓库，仓库根即工作目录。\n"
            "路径口径: 所有工具（read_file / search_code / apply_patch / run_command）"
            "统一以仓库根为基准。\n"
            "下方给出的测试命令原样执行即可（支持前导 KEY=VALUE 环境变量）。\n"
        )
    else:
        layout = (
            f"仓库布局: monorepo，本任务的包目录是 {spec.workdir}/（含 src/ 与 tests/）。\n"
            f"路径口径（重要，两套工具口径不同）:\n"
            f"- read_file / search_code / apply_patch 的 path 一律相对仓库根，"
            f"例如 {spec.workdir}/src/xxx.py，diff 头也用该口径；\n"
            f"- run_command 固定在 {spec.workdir}/ 下执行，命令里写包内相对路径"
            f"（下方给出的测试命令已按此口径，原样执行即可，不要加 cd 或改路径）。\n"
        )
    return (
        f"任务: {spec.description}\n"
        f"{layout}"
        f"允许修改的路径（相对仓库根）: {spec.allowedPaths}\n"
        f"静态检查: {spec.staticCheck}\n"
        f"定向测试（必须让它通过）: {spec.failToPass}\n"
        f"回归测试: {spec.passToPass}\n"
    )


class SelfAgent:
    def __init__(
        self,
        command: RunCommand,
        toolset: Toolset,
        emitter: EventEmitter,
        model: Any,
        checkpointer: Any = None,
        on_checkpoint: Any = None,  # callable(used_tokens, used_seconds) -> None
    ) -> None:
        self.command = command
        self.toolset = toolset
        self.emitter = emitter
        self.model = model
        self.on_checkpoint = on_checkpoint
        # 本 attempt 的墙钟起点（不进 checkpoint：恢复后重新计时，用 remainingSeconds 约束）
        self._attempt_started = time.time()
        self.graph = self._build().compile(checkpointer=checkpointer)

    # ---- 节点 ----

    def _agent_node(self, state: AgentState) -> dict[str, Any]:
        budget = self.command.budget
        if state["turn"] >= budget.turns:
            raise BudgetExceeded("turns", f"{state['turn']}/{budget.turns}")
        elapsed = int(time.time() - self._attempt_started)
        if elapsed > budget.remainingSeconds:
            raise BudgetExceeded("seconds", f"{elapsed}s/{budget.remainingSeconds}s")

        start = time.monotonic()
        response = self.model.invoke(prune_messages(state["messages"]))
        prompt_tokens, completion_tokens = usage_tokens(response)
        used_tokens = state["used_tokens"] + prompt_tokens + completion_tokens
        turn = state["turn"] + 1

        self.emitter.emit("MODEL_CALL", {
            "model": getattr(self.model, "model", "configured"),
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "latencyMs": int((time.monotonic() - start) * 1000),
            "turn": turn,
        })
        self.emitter.emit("BUDGET_UPDATE", {
            "usedTokens": used_tokens,
            "usedSeconds": elapsed,
            "usedTurns": turn,
        })
        if used_tokens > budget.tokens:
            raise BudgetExceeded("tokens", f"{used_tokens}/{budget.tokens}")

        # 卡死检测：连续 N 轮工具调用签名相同
        signature = json.dumps(
            [(tc["name"], tc["args"]) for tc in (response.tool_calls or [])],
            sort_keys=True, ensure_ascii=False,
        )
        signatures = [*state["stuck_signatures"], signature][-MAX_STUCK_REPEATS:]
        if (
            len(signatures) == MAX_STUCK_REPEATS
            and len(set(signatures)) == 1
            and signature != "[]"
        ):
            raise AgentStuck(f"连续 {MAX_STUCK_REPEATS} 轮重复工具调用: {signature[:200]}")

        done = not response.tool_calls
        return {
            "messages": [response],
            "turn": turn,
            "used_tokens": used_tokens,
            "stuck_signatures": signatures,
            "done": done,
        }

    def _tools_node(self, state: AgentState) -> dict[str, Any]:
        last = state["messages"][-1]
        assert isinstance(last, AIMessage)
        outputs: list[ToolMessage] = []
        for tool_call in last.tool_calls:
            result = self._dispatch_tool(tool_call["name"], tool_call["args"], tool_call["id"])
            outputs.append(ToolMessage(content=result, tool_call_id=tool_call["id"]))
            # 每个工具调用后立即落平台 Checkpoint：崩溃发生在节点中途时，
            # 已完成调用也进 completedToolCalls，恢复重放才能命中幂等缓存（§4.5）
            if self.on_checkpoint:
                elapsed = int(time.time() - self._attempt_started)
                self.on_checkpoint(state["used_tokens"], elapsed)
        return {"messages": outputs}

    def _dispatch_tool(self, name: str, args: dict[str, Any], tool_call_id: str) -> str:
        from arp_runtime.sandbox.provider import SandboxCrashed

        try:
            if name == "read_file":
                return self.toolset.read_file(
                    args["path"], args.get("start_line"), args.get("end_line")
                )
            if name == "search_code":
                return self.toolset.search_code(args["pattern"], args.get("glob", "**/*"))
            if name == "apply_patch":
                return self.toolset.apply_patch(args["patch"], tool_call_id=tool_call_id)
            if name == "run_command":
                return self.toolset.run_command(args["command"])
            return f"[error] 未知工具: {name}"
        except SandboxCrashed:
            # 沙箱死亡必须快速失败走平台恢复（SANDBOX_CRASHED -> RESUME），
            # 反馈给模型只会让它对着死沙箱空转烧预算
            raise
        except Exception as exc:  # noqa: BLE001 普通工具失败反馈给模型继续，而非中断 attempt
            return f"[error] {type(exc).__name__}: {exc}"

    # ---- 图 ----

    def _build(self) -> StateGraph:
        graph = StateGraph(AgentState)
        graph.add_node("agent", self._agent_node)
        graph.add_node("tools", self._tools_node)
        graph.set_entry_point("agent")
        graph.add_conditional_edges(
            "agent", lambda s: END if s["done"] else "tools", {END: END, "tools": "tools"}
        )
        graph.add_edge("tools", "agent")
        return graph

    def initial_state(self) -> AgentState:
        return {
            "messages": [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(content=build_task_prompt(self.command)),
            ],
            "turn": 0,
            "used_tokens": 0,
            "stuck_signatures": [],
            "done": False,
        }

    def run(self, thread_id: str, resume: bool = False, feedback: str | None = None) -> AgentState:
        self._attempt_started = time.time()
        config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 200}
        if resume:
            state = self.graph.get_state(config)
            if state and state.values.get("messages"):
                messages: list[BaseMessage] = state.values["messages"]
                inject: list[BaseMessage] = []
                # 崩溃可能发生在 tools 节点执行中途：末尾 AIMessage 的 tool_calls
                # 没有对应 ToolMessage（OpenAI 协议要求逐一应答，否则恢复后的
                # 首次模型调用会被 400 拒绝）。做缓存感知重放：中断前已完成并
                # checkpoint 的调用命中 completedToolCalls，跳过执行并打
                # cached=true（§4.5 副作用幂等）；未完成的在新沙箱真实重放。
                last = messages[-1]
                if isinstance(last, AIMessage) and last.tool_calls:
                    inject.extend(
                        ToolMessage(
                            content=self._dispatch_tool(
                                tool_call["name"], tool_call["args"], tool_call["id"]
                            ),
                            tool_call_id=tool_call["id"],
                        )
                        for tool_call in last.tool_calls
                    )
                if feedback:
                    # 图已跑到 END（如验证失败回炉）：以 tools 节点身份注入反馈，
                    # 下一步回到 agent 节点继续修
                    inject.append(HumanMessage(content=feedback))
                if inject:
                    self.graph.update_state(
                        config, {"messages": inject, "done": False}, as_node="tools"
                    )
                return self.graph.invoke(None, config)
            # 没有可恢复的图状态（如 checkpoint 表被清）→ 退化为全新执行
        return self.graph.invoke(self.initial_state(), config)
