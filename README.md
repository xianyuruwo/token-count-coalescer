# Frontend Token Estimator (TauriTavern 扩展)

灵感来自 [ST-Frontend-Tokenizer](https://github.com/GoldenglowMeow/ST-Frontend-Tokenizer)（MIT），针对 TauriTavern 的端点契约做了适配与修正。

## 解决什么问题

Chat Completion 的提示词组装按"每条消息一次请求"计数 token：`Message.createAsync` / `setName` 各自发一次 `POST /api/tokenizers/openai/count-batch`，由宿主通过串行化的 Tauri invoke 执行。300 楼的聊天意味着数百次串行 IPC 往返（约 20 秒）。

本扩展在运行时补丁 `jQuery.ajax`，直接在前端估算并立即返回结果——**零网络往返**，计数瞬间完成。

## 工作方式

- 拦截 `/api/tokenizers/openai/count-batch` 与 `/api/tokenizers/openai/count`，用字符级启发式估算后返回与后端相同形状的响应：
  - 每条消息 3 token 包装 + 每请求 3 token 回复引导 + 各字段文本 + name 字段 1 token（精确镜像 Rust 侧 `count_openai_messages` 的非 legacy 路径）
  - 估算公式与宿主自身回退启发式（`token-count-broker.js`）一致：CJK 字符 1 token/字，其他字符 1/4 token/字
- **有意放行**（真实请求直达后端）：
  - `count-prefix-batch`：World Info 路径，已是单请求批量，且预算裁剪依赖其精度
  - `encode` / `decode`：logit bias 等功能需要真实 token id
  - 空数组（预热）、非 POST、无法解析的请求体
- 兼容废弃的 `async: false` 同步调用路径（同步触发 success 回调）

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

1. **启动通知**：加载成功时弹 toast「前端 Token 估算已启用（v2.2.0）」
2. **看门狗**：宿主启动时会把自家 ajax 补丁重新套在最外层（见 `initialize-tauri-integration.js`），可能盖住本扩展的拦截。v2.2.0 内置看门狗：补丁被覆盖时自动恢复并弹 toast「检测到 jQuery.ajax 补丁被覆盖，已自动恢复拦截」
3. **诊断 toast**（关键判据）：首次大量计数发生后弹一次性 toast，三种结果：
   - 「拦截生效：已本地估算 N 次，后端计数 0 次」→ 正常工作
   - 「部分生效：本地估算 N 次，后端仍在计数 M 次」→ 部分绕过
   - 「拦截未生效：后端已计数 M 次，本地估算 0 次」→ 完全绕过
4. **速度**：切换到另一个模型再切回（使 token 缓存失效）后在长聊天中生成
5. **运行时统计**（桌面端 F12 控制台）：
   ```js
   __TT_FRONTEND_TOKENIZER__.stats   // { intercepted, passedThrough, reasserted, ... }
   __TT_FRONTEND_TOKENIZER__.enabled = false  // 临时关闭对比，刷新后生效
   ```

## 权衡

计数从精确值变为估算值。对英文基本精确；对中文偏保守（高估约 40%），效果是上下文预算裁剪更早触发——宁可少塞几楼，不会超限。

## 许可

MIT
