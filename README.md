# 只在這裡吃得到

輸入一個國家或民族，看五道離開當地就很難吃到的代表食物：可旋轉、拆解的 three.js 3D 模型、實拍照片、材料、做法，以及它在當地的地位。

目前收錄 9 國 45 道：台灣、韓國、越南、日本、泰國、印度、土耳其、義大利、西班牙。

## 檔案

- `page.html`：頁面原始檔（claude.ai Artifact 版本用，不含 `<!doctype>`／`<head>`）
- `index.html`：由 `python build.py` 從 `page.html` 產生的完整頁面（GitHub Pages 用）
- `engine.js`：3D 食物零件庫與場景檢視器（three.js r147）
- `app.js`：介面邏輯
- `data/*.js`：各國資料與 3D 場景規格；`data/photos.js` 為照片出處
- `photos/`：實拍照片

修改 `page.html` 後記得執行 `python build.py` 再 commit。

## 照片授權

所有照片來自 Wikimedia Commons，授權為 CC0、公有領域、CC BY 或 CC BY-SA。每張照片的作者、授權與原始頁面連結都標示在網頁的照片下方，也記錄在 `data/photos.js`。

「請 Claude 研究並上菜」（生成清單外國家）只在 claude.ai 的 Artifact 版本可用，GitHub Pages 版本會顯示說明。
