# 食膚日記：飲食紀錄與臉部保養（網頁 App）

這是一個可以「加入 iPhone 主畫面」的網頁 App（PWA）。不需要 Mac，也不需要 Apple 開發者帳號，傳一個網址就能分享給家人。

- **拍照記錄每一餐**：AI 估算熱量、過敏原（參考台灣標示規定 12 類）和痘痘風險標籤，結果都可以手動修改
- **常吃的食物**：吃過的食物自動建立清單，下次新增餐點直接點選；可以「同前一天的早餐」或把前一天整天的餐點一次複製
- **早晚保養品紀錄**：拍包裝讓 AI 填好名稱、成分並評估痘痘風險；之後每天勾選，有「套用常用組合」和「同前一天」一鍵勾選
- **保健食品**：一樣拍照讓 AI 辨識成分與用量，每天勾選、可「同前一天」；誘因分析會一併比較，並提醒乳清蛋白、B12、碘等成分
- **每日臉部狀況**：嚴重程度、部位、類型、備註
- **臉部自拍**：每天自拍建檔，可以和上一張比較，也可以請 AI 判讀痘痘狀況並套用到當日紀錄；PDF、Excel 和備份都會包含自拍
- **痘痘誘因推算**：比較長痘前與沒長痘時的飲食和保養品，也會提醒新產品和可能致粉刺的成分；另外可以請 AI 綜合解讀
- **依日期區間匯出**：PDF 報告（可附照片）和 Excel（5 個工作表）
- **備份**：匯出備份檔存到 Dropbox／iCloud，或用 Dropbox 一鍵備份

所有紀錄只存在各自手機的瀏覽器裡。你和老婆的資料互相獨立、互相看不到。

---

## 一、放上網路（GitHub Pages，免費）

1. 到 https://github.com 註冊帳號（已經有就直接登入）。
2. 右上角「＋」→ **New repository**
   - Repository name：例如 `foodskin`
   - 選 **Public**（GitHub Pages 免費版需要公開；公開的只有程式碼，你們的紀錄不會上傳到這裡）
   - 按 **Create repository**
3. 在新的 repository 頁面點 **uploading an existing file**，把 `FoodSkinWeb` 資料夾**裡面**的所有檔案和資料夾（`index.html`、`styles.css`、`sw.js`、`manifest.webmanifest`、`js/`、`icons/`、`README.md`）一起拖進去，再按 **Commit changes**。
   > 建議用 Chrome 或 Edge 拖曳，資料夾結構才會保留。
4. 到 **Settings** → 左邊 **Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 `/ (root)` → **Save**。
5. 等 1～2 分鐘，頁面上方會出現網址，例如：
   `https://你的帳號.github.io/foodskin/`

**之後要更新程式**：在 repository 再上傳一次修改過的檔案（同名檔案會被取代）。手機下次打開 App 就會是新版。

## 二、安裝到 iPhone（你和老婆都一樣）

1. 用 **Safari** 打開上面的網址（一定要用 Safari）。
2. 按下方的「分享」按鈕 ⬆️ → **加入主畫面** → 新增。
3. 之後從主畫面的「食膚日記」圖示開啟，就會是全螢幕，看起來和一般 App 一樣。

> ⚠️ 紀錄存在「主畫面上的 App」裡。在 Safari 分頁裡用和從主畫面開啟，是兩份不同的資料，請固定從主畫面開啟。

## 三、AI 金鑰（每個人自己輸入，二選一）

AI 辨識照片可以用 **Google Gemini（有免費額度）** 或 **Claude（付費）**。在 App 右上角 ⚙︎ →「AI 服務」切換。

### Google Gemini（免費）
1. 到 https://aistudio.google.com/apikey 用 Google 帳號登入。
2. 按 **Create API key** → 複製 `AIza...` 開頭的金鑰。
3. App ⚙︎ →「AI 服務」選 **Google Gemini** → 貼上金鑰 → 儲存。

- 免費方案每天有次數上限，用完會顯示「已達免費額度上限」，隔天就恢復。
- 免費方案送出的照片與文字，Google 可能用來改進產品；介意的話可以在 AI Studio 綁定付費帳戶。
- 「模型」欄位通常留空即可（預設 `gemini-3.8-flash`）。如果哪天 Google 停用這個模型，再到 AI Studio 查新的名稱填進去。

### Claude（付費）
**API 和 Claude.ai 的訂閱是分開計費的**，要另外申請：
1. 到 https://console.anthropic.com 登入（可以用同一個 Anthropic 帳號）。
2. **Billing** → 儲值（最低 US$5）。
3. **API Keys** → **Create Key** → 複製 `sk-ant-...` 開頭的金鑰。
4. App ⚙︎ →「AI 服務」選 **Claude** → 貼上金鑰 → 儲存。

- 費用：每分析一張餐點照片大約 US$0.01～0.04；兩人每天各 3 餐，一個月大約 US$3～6（粗估）。

兩種金鑰都只存在那支手機。沒有金鑰也能使用，只是食物和熱量要手動輸入；本機的誘因分析不需要金鑰。

## 四、備份

### 方法 A：匯出備份檔（不用設定）
⚙︎ →「匯出備份檔」→「分享／儲存到檔案」→ 選 **Dropbox**（手機要有裝 Dropbox App）或 iCloud 雲碟。
還原時：⚙︎ →「從備份檔還原」→ 從「檔案」App 裡的 Dropbox 選擇備份檔。

### 方法 B：Dropbox 一鍵備份（只需要設定一次）

**你（開發者）先做一次：**
1. 到 https://www.dropbox.com/developers/apps → **Create app**
   - Choose an API：**Scoped access**
   - Type of access：**App folder**（App 只能存取自己的資料夾，看不到你其他的 Dropbox 檔案）
   - Name：例如 `FoodSkinBackup`（不能和別人重複，可以加一些數字）
2. 進入 App 頁面 → **Permissions** 分頁，勾選這三項後按 **Submit**：
   - `files.metadata.read`
   - `files.content.write`
   - `files.content.read`
3. 回到 **Settings** 分頁，複製 **App key**。
4. 打開 `js/config.js`，把 App key 填進去（這不是密碼，可以公開）：
   ```js
   export const CONFIG = { dropboxAppKey: '你的App key' };
   ```
   再重新上傳到 GitHub。不想改檔案的話，也可以在 App 的設定頁直接貼上。

**每個使用者（你和老婆各自）：**
1. ⚙︎ →「① 連結 Dropbox」→ 登入自己的 Dropbox → 按「允許」。
2. Dropbox 會顯示一串**授權碼**，複製它，回到 App。
3. 貼到「② 授權碼」欄位 →「③ 完成連結」。
4. 之後只要按「☁️ 立即備份到 Dropbox」就好。備份檔會存在 Dropbox 的「應用程式／FoodSkinBackup」資料夾。

> 用其他 Dropbox 帳號（例如老婆的）連結前，需要在 Dropbox 開發者頁面的 Settings 按 **Enable additional users**（開發中的 App 預設只有你自己能用，最多可開放 500 人）。

App 超過 7 天沒有備份時，「今日」頁面上方會出現提醒。

---

## 在電腦上測試（選用）

用任何靜態網頁伺服器開啟這個資料夾即可。例如安裝 Python 後：
```bash
python -m http.server 8123
```
然後打開 http://localhost:8123 。

## 檔案說明
```
index.html            主頁面
styles.css            樣式（支援深色模式）
manifest.webmanifest  加入主畫面用的設定
sw.js                 離線快取
icons/                App 圖示
js/
  app.js              畫面與操作
  db.js               手機內資料庫（IndexedDB）
  claude.js           Claude API：照片辨識、AI 解讀
  gemini.js           Google Gemini API：照片辨識、AI 解讀
  analyzer.js         痘痘誘因推算
  records.js          依日期整合紀錄
  excel.js / xlsx.js  產生 Excel
  pdf.js              產生 PDF 報告
  backup.js           備份／還原
  dropbox.js          Dropbox 一鍵備份
  config.js           Dropbox App Key 設定
  vocab.js            過敏原、部位等選項
```
