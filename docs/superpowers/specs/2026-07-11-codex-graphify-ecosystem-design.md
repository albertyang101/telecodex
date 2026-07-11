# Codex Developer Bot graphify 生态内建设计

## 目标

把 CC Developer Bot 已有的“碰代码先看 graphify”能力做成 Codex Developer Bot 的默认出厂能力，而不是 Theo 单机特例。每个开发 turn 都收到同一条短纪律；任何源码读取或修改都必须先查当前仓库对应的共享图；修改前还必须查影响面。

## 已有基础

- 共享图按仓库分开保存，并由另一条控制线自动刷新。
- Codex runtime 已有项目级 hook 和 dedicated CODEX_HOME。
- 现有隔离候选已实现显式 repo→graph 映射、共享图只读 Skill、PreToolUse 门闸、成功后 session+turn receipt，并覆盖错图、伪命令、跨仓路径和 affected-before-edit。
- AGENTS.md 已有“碰代码先问图”文字纪律，但它只在 Codex run/session 启动时加载，不能替代每轮提醒。

## 设计

### 1. 三层职责

1. **Agent Skill**：告诉 Codex 什么时候用 graphify、如何选图、query→explain→affected 的标准顺序，以及图缺失/陈旧时如何诚实停下或回源码核对。
2. **UserPromptSubmit hook**：每个 turn 都注入一条短开发纪律，确保长线程和换页后仍看得到“代码任务先查共享图、写前 affected、禁止私图”。
3. **PreToolUse hook**：做机械底线。对已映射代码仓库，成功查询正确共享图前禁止源码读取；成功 affected 前禁止写代码；receipt 必须绑定 session、turn 和 graph，且只能在真实 graphify exit 0 后生成。

文字层负责判断，hook 层只管可稳定判定的底线。Hook 不是安全边界，也不尝试覆盖所有可能的计算机行为；它用于阻止标准 Codex shell/edit/filesystem 路径，并由真实 Codex turn 验证覆盖面。

### 2. 仓库与图选择

使用版本化 repo map，优先按显式绝对路径匹配；Git worktree 用 git common dir 归回 canonical repo。一个目标只能映射一个 graph。已配置仓库的图缺失、map 损坏或错图必须 fail closed；未映射仓库由 Skill 明示“没有 canonical graph”，允许源码核对但不得私建图。

共享图只读。禁止 build、update、watch、install、save-result、repo-local graphify-out、Graphiti、persona_memory、FalkorDB 和任何个人记忆写入。

### 3. 出厂配方

提供一个可在临时目录运行的安装器/manifest，把以下资产装入目标 Codex Developer Bot：

- graphify overlay Skill 和 repo map；
- UserPromptSubmit hook；
- PreToolUse hook；
- hooks 配置片段；
- 安装后自检。

安装器只写目标 Bot 的隔离 CODEX_HOME/workspace，不写共享图、不启动 Bot、不 reload、不部署。Personal Assistant 角色默认不装这一开发门闸；Developer Bot 默认必装。

### 4. 验证

- 单元红绿：每轮 context、正确选图、成功后 receipt、错图/伪命令、跨仓、map/graph 缺失、affected-before-edit、安装器幂等和负向保护。
- 全量：TeleCodex 全套测试与 TypeScript build。
- 真实 Testbot：临时 CODEX_HOME + 临时 workspace + 官方 codex exec。真实代码任务的第一项源码探索在 graphify 成功前被门闸阻止，正确图查询后可读源码，affected 后才可写。
- 独立 review：Critical/Important 清零。
- 部署：只有 Cody gate 通过后，才同步 Theo/Ada，逐台验证且避免双 poller；否则停在可部署候选。

## 回滚

候选全部留在隔离 worktree。未部署前回滚就是丢弃该分支。部署后回滚为撤下 hooks 配置片段和 graphify overlay Skill，并恢复部署前备份；共享图和生产仓库不被改写。
