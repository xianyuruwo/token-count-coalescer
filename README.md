# Frontend Token Estimator (TauriTavern 扩展)

灵感来自 [ST-Frontend-Tokenizer](https://github.com/GoldenglowMeow/ST-Frontend-Tokenizer)（MIT），针对 TauriTavern 的端点契约做了适配与修正。v3.0.0 起内置性能剖析器，用于定位提示词组装慢的真正瓶颈。

## 解决什么问题

Chat Completion 的提示词组装按"每条消息一次请求"计数 token：`Message.createAsync` / `setName` 各自发一次 `POST /api/tokenizers/openai/count-batch`，由宿主通过串行化的 Tauri invoke 执行。300 楼的聊天意味着数百次串行 IPC 往返（约 20 秒）。

本扩展在运行时补丁 `jQuery.ajax`，直接在前端估算并立即返回结果——**零网络往返**，计数瞬间完成。

## 性能剖析器（v3.0.0+）

实测发现"组装慢"未必是 token 计数导致。扩展会持续测量：- **主线程繁忙**：长任务（PerformanceObserver）+ 计时器漂移（累计 <50ms 的阻塞）
- **HTTP 请求**：所有经 ajax/fetch 通往宿主的请求次数与耗时（含最耗时端点排行）
- **Tauri 调用**（v3.1.0+）：按命令名计时
- **IndexedDB**（v3.1.0）：localforage token 缓存等读写计时
- **定时器等待 / rAF 延迟**（v3.2.0）：纯等待时间，其他仪表看不到

一次繁忙期结束（安静 3 秒）后自动弹 toast「TT 性能剖析」。右侧浮动 **Σ** 按钮可随时手动查看（双击隐藏）。判读方法：

- 主线程繁忙占大头 → 瓶颈是 JS 计算（渲染、正则、世界信息扫描、其他扩展的逐楼处理）
- HTTP 请求耗时占大头 → 瓶颈在路由请求（看最耗时端点名定位）
- **Tauri 调用耗时占大头** → 瓶颈是某个后端命令（看命令名，如 `apply_native_regex_batch` = 原生正则、`save_chat` = 保存聊天）
- IndexedDB 占大头 → localforage 缓存读写
- **定时器等待占大头** → 代码里有大段 `await delay(...)`/轮询（看延迟档位：500ms/1000ms…）
- **全部都很小但就是慢** → 等待 Tauri 事件或上游流式首字（见下）

## 原生正则批处理缓存（v3.3.0+）

剖析发现组装慢的主因是 `apply_native_regex_batch`（每次组装对全部消息跑正则脚本，Rust `regress` 回溯引擎对复杂脚本集可能 15-30 秒/批）。该调用的输出是 `(消息文本, 已按深度过滤的脚本集)` 的纯函数——**相同输入必然相同输出**。扩展在 invoke broker 层对批处理结果做 LRU 记忆化：

- 内容未变的聊天再次组装（重试、提示词查看器重复打开、重新生成、滑动）→ **整批缓存命中，跳过 Rust 调用**
- v3.4.0：**局部命中**——聊天追加新消息后，只有新增/变化的消息重新跑正则，其余直接从缓存合并（日常每轮发送只付增量成本）
- v3.5.0：**跨会话持久化**——缓存写入 localStorage（按扩展版本分桶、4MB 预算、LRU 淘汰），重启应用后首次组装也直接命中，不再付 60s 冷启动成本；消息文本或正则脚本变更会自然失效（键含全部输入）
- v3.6.0：**默认静默**——移除剖析弹窗与悬浮按钮（诊断功能按需开启），零打扰
- 缓存的是真实的 Rust 输出，非估算——语义零改变；失败批不缓存
- 报告 toast 会显示「正则批处理缓存命中 N 次」

配合建议（实测对比）：
- 关闭「Rust Regex Backend」（TauriTavern 设置 → Rust Regex Backend）改用 V8 正则，对部分复杂模式可能快很多
- 减少"组装时运行"的脚本数（正则扩展面板）
- 关闭聊天自动备份（Chat Backups → Automatic）降低每次保存 ~1s 的开销



## 工作方式

- 拦截 `/api/tokenizers/openai/count-batch` 与 `/api/tokenizers/openai/count`，用字符级启发式估算后返回与后端相同形状的响应：
  - 每条消息 3 token 包装 + 每请求 3 token 回复引导 + 各字段文本 + name 字段 1 token（精确镜像 Rust 侧 `count_openai_messages` 的非 legacy 路径）
  - 估算公式与宿主自身回退启发式（`token-count-broker.js`）一致：CJK 字符 1 token/字，其他字符 1/4 token/字
- **有意放行**（真实请求直达后端）：
  - `count-prefix-batch`：World Info 路径，已是单请求批量，且预算裁剪依赖其精度
  - `encode` / `decode`：logit bias 等功能需要真实 token id
  - 空数组（预热）、非 POST、无法解析的请求体
- 兼容废弃的 `async: false` 同步调用路径（同步触发 success 回调）
- **看门狗**：宿主启动或其他扩展（如酒馆助手）可能替换 jQuery.ajax 埋掉拦截层；看门狗每 300ms 检查，被覆盖时自动恢复（覆盖者身份记录在控制台）

相比参考项目，本扩展修正了两个问题：`count-batch` 直接返回 `token_counts` 数组（参考项目靠 legacy 回退绕行）；不拦截 encode/decode（参考项目返回空 `ids`，会破坏 logit bias）。

## 安装

放入扩展目录后重启应用：

```
<TauriTavern 数据目录>/data/default-user/extensions/token-count-coalescer/
├── manifest.json
└── index.js
```

控制台出现 `[Frontend Tokenizer] Patched jQuery.ajax` 即生效。可在 Extensions 面板开关。

## 验证是否生效

**v3.6.0 起默认静默运行**：不再弹任何 toast，悬浮 Σ 按钮与性能剖析器默认关闭（剖析打点本身有少量开销，测试完毕已移除）。

按需开启诊断（桌面 F12 控制台）：
- 性能剖析 + Σ 按钮：`localStorage.setItem('tt:fte:profile', '1'); location.reload();`
- toast 通知（安装/补丁恢复/剖析报告）：`__TT_FRONTEND_TOKENIZER__.notify = true`
- 关闭剖析：`localStorage.removeItem('tt:fte:profile'); location.reload();`

核心功能（token 估算 + 正则批处理缓存）始终静默工作，无需任何提示。

## 缓存与数据删除

正则批处理缓存**按内容寻址**（键 = 消息文本 + 脚本集哈希），跨聊天共享，**不按会话建立索引**——删除某个聊天时不会（也无法按会话）删除对应缓存条目。安全性由以下保证：
- 缓存仅含"相同输入必产生相同输出"的正则结果，键覆盖全部输入，跨聊天复用语义零风险
- 内存上限 16MB / 持久化 4MB，LRU 淘汰；删除聊天后的残留条目会随新内容自然挤出
- 在意残留可手动清空：`__TT_FRONTEND_TOKENIZER__.clearRegexCache()`

token 估算缓存则复用应用的本地 token 缓存（按 chatId 分桶），删除聊天时由应用自行清理。

## 运行时统计（诊断开启时）

   ```js
   __TT_FRONTEND_TOKENIZER__.stats     // { intercepted, passedThrough, reasserted, ... }
   __TT_FRONTEND_TOKENIZER__.profile() // 性能剖析快照（需开启 profile）
   __TT_FRONTEND_TOKENIZER__.clearRegexCache()  // 清空正则缓存（内存+本地存储）
   __TT_FRONTEND_TOKENIZER__.enabled = false  // 临时关闭估算，刷新后生效
   ```

## 权衡

计数从精确值变为估算值。对英文基本精确；对中文偏保守（高估约 40%），效果是上下文预算裁剪更早触发——宁可少塞几楼，不会超限。

## 许可

MIT

