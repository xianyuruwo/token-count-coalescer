# Frontend Token Estimator (TauriTavern 扩展)

灵感来自 [ST-Frontend-Tokenizer](https://github.com/GoldenglowMeow/ST-Frontend-Tokenizer)（MIT），针对 TauriTavern 的端点契约做了适配与修正。v3.0.0 起内置性能剖析器，用于定位提示词组装慢的真正瓶颈。

## 解决什么问题

Chat Completion 的提示词组装按"每条消息一次请求"计数 token：`Message.createAsync` / `setName` 各自发一次 `POST /api/tokenizers/openai/count-batch`，由宿主通过串行化的 Tauri invoke 执行。300 楼的聊天意味着数百次串行 IPC 往返（约 20 秒）。

本扩展在运行时补丁 `jQuery.ajax`，直接在前端估算并立即返回结果——**零网络往返**，计数瞬间完成。

## 性能剖析器（v3.0.0+）

实测发现"组装慢"未必是 token 计数导致。扩展会持续测量：

- **主线程繁忙**：长任务（PerformanceObserver）+ 计时器漂移（累计 <50ms 的阻塞）
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

### v3.1/v3.2 说明

- v3.1.0 直接补丁 `window.__TAURI__.core.invoke` 可能失效（注入的 core 可能是只读 getter，或被早期绑定的引用绕过）。v3.2.0 改为在**宿主 ABI 的 invoke broker** 边界打点（`__TAURITAVERN__.invoke.broker.invoke`）——这是纯 JS 可写对象，所有 `safeInvoke` 流量（路由、原生正则、聊天保存）都动态经它，是最可靠的单点
- 补丁在每次看门狗 tick 自动重新断言，覆盖 ABI 晚注入/被其他扩展覆盖的情况
- 流式生成（`/generate`）立即返回、真实耗时在上游 → 若报告「全部都很小但慢」，瓶颈在模型/中转代理的首 token 延迟，非本端

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

1. **启动通知**：加载成功时弹 toast「前端 Token 估算已启用（v3.2.0）」
2. **诊断 toast**：首次大量计数后一次性报告拦截状态（拦截生效 / 部分生效 / 拦截未生效）
3. **性能剖析**：慢操作结束后自动弹「TT 性能剖析」，点 Σ 按钮随时重看
4. **运行时统计**（桌面端 F12 控制台）：
   ```js
   __TT_FRONTEND_TOKENIZER__.stats     // { intercepted, passedThrough, reasserted, ... }
   __TT_FRONTEND_TOKENIZER__.profile() // 性能剖析快照
   __TT_FRONTEND_TOKENIZER__.enabled = false  // 临时关闭对比，刷新后生效
   ```

## 权衡

计数从精确值变为估算值。对英文基本精确；对中文偏保守（高估约 40%），效果是上下文预算裁剪更早触发——宁可少塞几楼，不会超限。

## 许可

MIT

