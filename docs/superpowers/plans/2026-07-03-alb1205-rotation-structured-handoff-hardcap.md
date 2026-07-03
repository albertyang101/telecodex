# ALB-1205 · Codex 换页保命三件 — 设计稿

> 基座 = 分支 `alb-1025-auto-rotation-ada`（canonical telecodex + 已 TDD 的自动换线程，526 测试全绿，从未上过生产）。
> 本单不是从零建换线程，是在这版基座上补齐三件，然后 testbot 证通、Albert 签字后铺真两台（Theo=albert-v3 / Ada=albert-codex-e2e）。

## 现状事实（2026-07-03 实测，非转述）

- live 三台 runtime（`telecodex-alb810-runtime-alb997-20260625` ×2、`telecodex-alb997-20260625T085202-runtime`）**没有任何 rotation 代码**（src+dist grep 双证）。ALB-1025 单描述里「已 live 在 runtime 拷贝」已被 6/25 后的 runtime 替换冲掉，现状为裸。
- 基座分支已有：`rotation-policy`（0.45 × live 解析窗口 258400，失效安全）、`thread-rotation`（sticky pending 状态机）、`handoff-buffer`（近窗环形缓冲 + 有界渲染）、`handoff-store`（原子持久化）、bot.ts 接线（rotate 失败留 pending 不丢）、codex-session soft-wedge abort 修复。
- SDK 只在 `turn.completed` 报一次 usage（`event.usage.input_tokens`），**回合中途拿不到 token 数**——强杀兜底不能靠回合内 token 监视，要走回合边界 + 现有超时中断路。
- 未答消息真源：bot.ts `pendingPromptQueues`（per-context QueuedPrompt[]）。
- 旧策所在：`discipline-workspace/AGENTS.md`（Theo）、`albert-codex-e2e-workspace/AGENTS.md`（Ada）各有「不自动 Refresh Session」「默认策略：不自动 refresh」两段。

## Delta 1 · 结构化 HANDOFF（section 集照 CC，parser 换 telecodex 自有状态）

`renderHandoff(entries, opts)` 扩为 `renderHandoff(entries, context, opts)`，纯函数，新增 `HandoffContext`：

- **元信息**：翻页原因（`ratio/threshold` 或 `hard-cap` 或 `timeout-abort`）。
- **恢复指引**（指针不内联，照 CC 思路）：指示新线程先按 workspace AGENTS.md 的恢复纪律拉 Linear 控制面对齐在途单，再接话。
- **未答消息**：调用方从 `pendingPromptQueues` 快照传入（逐条原文，有界截断）。
- **最后断点**：若翻页来自强杀/超时中断，携带被打断那个回合的用户原文（「这条没答完，接着答」）；正常翻页则省略。
- **近窗对话**：现有环形缓冲渲染，保持现有双重有界预算。

总预算沿用 6000 字符，section 有各自上限，最新优先存活。`ChatRotationState` 增 `interruptedTurn?: string` 字段（持久化向后兼容：缺字段=无断点）。

## Delta 2 · hard-cap 强杀兜底

- 配置：`CODEX_ROTATE_HARD_CAP` 默认 **0.60**（照 CC 现行契约）；无效值或 ≤ threshold 时仅停用 hard-cap、不影响 0.45 常规翻页（失效安全同 rotation-policy 风格）。
- **回合边界强制**：turn 完成时 ratio ≥ hardCap → pending 升级为 `mandatory`。下一回合翻页时若 `newThread()` 失败：现行为是「留 pending 继续旧线程」——mandatory 下**禁止**继续超限旧线程：重试一次，再失败则本回合直接报错给用户并保留 pending（宁可这回合不跑，不许在超限线程上再压一回合）。
- **在途中断接管**：现有超时/abort 路（`CODEX_TURN_ABORT_GRACE_MS` + timeout drain）打断一个回合时，若该线程最后已知 ratio ≥ threshold → 直接置 pending + 记 `interruptedTurn`，重派的下一回合在新线程上凭 HANDOFF「最后断点」接着答。复用现有 abort 机制，不新造杀进程路。

## Delta 3 · AGENTS.md 旧策废止

两台（+testbot 台）workspace 的 AGENTS.md：「不自动 Refresh Session」「默认策略：不自动 refresh」两段改写为自动换线程新策（0.45 翻页 / 0.60 强制 / HANDOFF 接棒 / 显式 `/new` 等人工路保留）。改前 diff+留 `.bak-pre-alb1205-<时间戳>`，改后带 `ALB-1205` 哨兵注释，别人的哨兵一个不碰（保洁纪律第三节四步）。

## 验证与铺开

1. 红绿 TDD：新 section 渲染 / mandatory 升级与 newThread 失败分支 / 中断接管 / 配置解析失效安全，全在 test/ 层；全套 `npm test` + `npm run build`。
2. review 一道（sp-requesting-code-review 或等效自审）。
3. testbot 证通（A7 哨兵法）：低阈值 env 逼真翻页 → 换前埋事实、换后问得出 + 未答接续；hard-cap mandatory 路以单测 + testbot 低 hard-cap 演一次。部署 testbot 前先证 superset（live runtime src vs git 基线 diff，6/25 后手补丁逐段有下落）。
4. 报 Albert；生产两台 reload 只在 Albert 点头后（testbot-prove-before-rollout 纪律），铺后逐台核实真生效。

## 回滚

`CODEX_AUTO_ROTATE=false` 一键停用；或 revert 分支。AGENTS.md 有 .bak 可回。
