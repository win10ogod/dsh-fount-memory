# dsh-fount-memory

參考 Fount 角色的長短期記憶設計，為 DeepSeek Harness 提供持久記憶。已針對 DSH `0.1.7-rc.2`、`0.2.0-rc.2` 與 `0.2.1-alpha.1` 的插件與 format v4 訊息介面開發。

記憶在原本的對話中運作：模型請求前帶入符合條件的命名事實記憶。預設不自動注入過往對話軌跡。插件不建立反思或 dream 輪次，不呼叫 `agent.followup()`、`agent.steer()`，也不在空閒時恢復會話。儲存與檢索都在本機進行，不額外呼叫模型。

長期記憶以名稱管理。再次使用相同名稱會更新現有內容，舊版與來源上下文留在修訂歷史；刪除時連歷史一起刪除。觸發條件支援任一關鍵詞、全部關鍵詞與指定月日。例如：

```json
{
  "name": "使用者生日",
  "content": "使用者生日為 7 月 17 日。",
  "trigger": { "any": ["生日", "birthday"], "onDates": ["07-17"] }
}
```

短期封存保留最近十則非空白文字訊息及其來源、會話 ID、輪次與記錄時間。DSH 的 `completed` 只代表回合結束，並不證明工作完成，因此這些封存是未驗證的歷史資料，不是成功任務示範。空白結尾、未完成待辦、中止與失敗的回合不會新增封存。

`recallCount` 預設為 **0**，封存片段只供 `fount_memory_search` 搭配 `includeEpisodes: true` 明確檢查歷史；一般搜尋預設也只回傳命名事實。套件升級本身不刪除既有資料。命名事實記憶的自動召回不受此值影響。若使用者明確把 `recallCount` 設為正整數，會啟用舊式原始對話召回：按詞彙、時間線索與衰減選取片段，略過同會話 20 分鐘內的片段。原始軌跡可能包含未完成操作，會成為模型模仿的上下文；不能只靠「不是新指令」的前言消除這項影響。一般開發 Agent 應保持為 0。

提供四個模型工具：`fount_memory_remember`、`fount_memory_search`、`fount_memory_context`、`fount_memory_forget`。需要記下經確認的事實時用 remember；更正同一事項時沿用名稱；要查來源與舊版時用 context；使用者要求遺忘主題時先用 search 檢查範圍，再用 forget 的 `kind: all` 同時刪除命名記憶、歷史版本與包含該字串的對話片段。DSH 原始會話日誌仍由 DSH 自行管理。工具不替使用者猜測事實，子代理輪次不自動封存。

## 安裝

在 DSH 主機環境安裝至所需 profile，例如 `web`：

```powershell
dsh plugin --profile web add github:win10ogod/dsh-fount-memory
dsh --profile web --dump-config
```

`dsh plugin` 會安裝套件並把 bundle 加進 profile；`--dump-config` 應顯示 `fount-memory` 條目。重新啟動已在執行的 DSH 後使用。插件預設按工作區分開 SQLite 資料庫，位置為 `$DSH_HOME/storages/fount-memory`；DSH_HOME 未設定時使用使用者家目錄下的 `.dsh/storages/fount-memory`。

配置示例：

```yaml
- id: fount-memory
  name: dsh-fount-memory
  config:
    namespace: default
    scope: workspace
    recallCount: 0
    relevanceThreshold: 5
    sameSessionCooldownMinutes: 20
```

`scope: global` 可讓同一個 namespace 跨工作區共用資料。`dataDir` 可指定資料庫目錄。停用插件不刪除資料庫；要刪除特定記憶，用 `fount_memory_forget`。

此實作參考了 [理華角色包](https://github.com/win10ogod/Rika) 的命名長期記憶、修訂追溯、短期片段與相關性回憶。Fount 的任意 JavaScript 觸發器在此改為結構化條件，以便在 DSH 插件中驗證與管理；這不是 Fount 原角色記憶資料的直接匯入。對話片段目前記錄文字內容，非文字附件仍留在 DSH 原始會話中。

執行 `npm run check` 會檢查語法並測試資料庫重啟、修訂刪除、時間線索、format v4 來源、事實召回，以及失敗軌跡不自動回灌與空白訊息排除。
