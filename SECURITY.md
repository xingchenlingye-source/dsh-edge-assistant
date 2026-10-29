# 安全說明

這個專案會讓本機程式（agent / CLI）讀取並操作你的瀏覽器，權限不小。
在安裝或使用前請先看清楚以下幾點。

## 擴充權限

`extension/manifest.json` 要求：

| 權限 | 用途 | 風險 |
| --- | --- | --- |
| `debugger` | CDP 真實點擊/打字、元素截圖、無障礙樹 | 等同 DevTools 等級的瀏覽器控制 |
| `cookies` | 匯出 cookie 給 CLI（含登入憑證） | 可讀取所有網站的登入 cookie |
| `tabs` / `activeTab` / `scripting` | 讀取頁面、開關分頁 | 可讀所有網站內容 |
| `history` / `bookmarks` / `downloads` | 查詢瀏覽器資料 | 可讀瀏覽紀錄與書籤 |
| `sidePanel` / `tabGroups` / `webNavigation` / `contextMenus` | 側邊欄、任務分組、右鍵選單 | 一般 UI 功能 |
| `host_permissions: <all_urls>` | 在任何網站執行上述操作 | 涵蓋所有網站 |

## 本機服務

- `bridge server` 只綁 `127.0.0.1:8765`，`dsh-browser-chat` 插件只綁 `127.0.0.1:8766`。
- **兩者都沒有身份驗證**：本機任何程式都能呼叫 `/cmd`、`/prompt`、`/inbox`。
  請只在信任的機器上跑。
- 預設不開啟控制模式（寫入閘門）；**控制模式存在 `chrome.storage.local`，
  Edge 重啟後仍然開著**，用完請回 popup 取消勾選。

## 憑證與隱私

- 匯出的 cookie 明文存在 `data/cookies/`（含 `SESSDATA`、`auth_token` 等登入憑證）。
- `data/`、`downloads/` 已在 `.gitignore` 內，**不要提交或分享**。
- 收件匣 `/inbox` 會保存右鍵選單送出的文字；不用時可 `bridge.py inbox --clear`。

## 移除

```powershell
# 1) 移除擴充：edge://extensions → 移除
# 2) 移除開機自動啟動（若有裝）
powershell -File server\install-autostart.ps1 -Remove
# 3) 移除 DSH 側邊欄插件（若有裝）
#    plugin_manager → remove_bundle @local/dsh-browser-chat
# 4) 刪除資料
Remove-Item -Recurse data
```

## 回報問題

請開 GitHub issue，附上：發生什麼、預期的行為、`data/bridge.log` 的相關片段
（**先移除 cookie/token 等敏感內容**）。
