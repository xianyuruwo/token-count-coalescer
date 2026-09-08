# Rust Regex Batch Cache（TauriTavern 扩展）

一个**纯粹、静默**的修复：解决 Rust Regex Backend 的最大痛点——**每次提示词组装都对未变的聊天内容全量重跑正则**。

实测背景（长聊天 + 几十条正则脚本）：上游每次组装 `apply_native_regex_batch` 耗时 30-60 秒，且**重复组装同样慢**（上游只有"编译缓存"，没有"结果缓存"）。本扩展在 invoke broker 层把批处理结果记忆化后：**冷 60s → 重复 ~1s，跨重启持久化**。

## 原理

`apply_native_regex_batch` 的输出是 `(消息文本, 深度过滤后的脚本集)` 的**纯函数**——相同输入必然相同输出。在 `__TAURITAVERN__.invoke.broker.invoke`（所有 `safeInvoke` 的唯一必经点）包装：

- **整批命中** → 本地直接返回，不调用 Rust
- **部分命中** → 只把缺失任务发给 Rust，按原顺序合并（聊天追加新消息后只重算新增/变化消息）
- **未命中** → 正常走 Rust，输出写入缓存供下次使用

缓存值 = 真实 Rust 输出（非估算），**语义零改变**；失败批不缓存。

## 正确性保证（缓存为什么安全）

- 键 = 完整任务 payload 哈希（文本 + 每条脚本的 pattern/flags/replacement/trim）
- **任何能改变输出的事物必然改变键** → 消息编辑、正则脚本编辑、深度移位导致的脚本适用集变化、世界书注入消息文本变化，全部自然失效
- 世界书激活逻辑本身不在缓存范围，实时计算
- 内存 LRU 16MB / localStorage 4MB（按扩展版本分桶，LRU 淘汰）；删除聊天不会主动清对应条目（内容寻址、跨聊天共享），残留会被 LRU 自然挤出，可手动清空（见下）

## 安装

放入扩展目录后重启应用：

```
<TauriTavern 数据目录>/data/default-user/extensions/token-count-coalescer/
├── manifest.json
└── index.js
```

Extensions 面板中名为 **"Rust Regex Batch Cache"**。与旧版（v3.x token-count-coalescer）同目录同仓库，更新后即替换，无需重装。

## 使用

**零交互**：装好后完全静默工作，无弹窗、无按钮。首次冷组装（新内容）付全量成本，之后（含重启后）秒级。

控制台自检（桌面 F12）：

```js
__TT_REGEX_CACHE__.stats   // { hits, partials, misses }
__TT_REGEX_CACHE__.size()  // 内存缓存条目数
__TT_REGEX_CACHE__.clear() // 清空内存 + localStorage（换角色/怀疑陈旧时用）
```

## 与旧版本的关系

v4.0.0 移除了 token 估算器与全部诊断设施。实测证据表明估算器从未在真实使用中介入（各剖析窗口"本地估算 0 次"），计数也非组装瓶颈，故删除零损失。本版只做一件被验证有效的事：**正则批处理结果缓存**。

## 许可

MIT
