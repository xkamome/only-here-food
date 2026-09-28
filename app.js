(function () {
  'use strict';
  const atlas = window.FOOD_ATLAS || [];
  const $ = (id) => document.getElementById(id);
  const LS_GEN = 'onlyhere.generated.v1';
  const LS_LAST = 'onlyhere.last.v1';

  /* ---------- 儲存（僅本機便利） ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕或封鎖時忽略 */ } },
  };
  let generated = store.get(LS_GEN, {});

  /* ---------- 名稱比對 ---------- */
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/臺/g, '台').replace(/[\s·・.'’\-_,，、()（）]/g, '');
  const strip = (s) => s.replace(/(民主共和國|共和國|王國|聯邦|國|族|人|料理|菜|的食物|美食)$/, '');
  function allCountries() { return [...atlas, ...Object.values(generated)]; }
  function findCountry(q) {
    const n = norm(q), s = strip(n);
    if (!n) return null;
    const list = allCountries();
    for (const c of list) {
      const names = [c.name, c.id, c.endonym, ...(c.aliases || [])].map(norm);
      if (names.includes(n) || names.includes(s)) return c;
    }
    for (const c of list) {
      const names = [c.name, ...(c.aliases || [])].map(norm).filter((x) => x.length >= 2);
      if (names.some((a) => (s.length >= 2 && (s.includes(a) || a.includes(s))))) return c;
    }
    return null;
  }

  /* ---------- 3D 檢視器 ---------- */
  let viewer = null;
  const stage = $('stage'), tip = $('tip'), stageMsg = $('stageMsg');
  function stageColor() { return getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#d9d8cf'; }
  function ensureViewer() {
    if (viewer) return viewer;
    try {
      viewer = new DishEngine.DishViewer(stage, {
        onHover(info, ev) {
          if (!info || !info.label) { tip.hidden = true; return; }
          showTip(info, ev);
        },
        onSelect(info, ev) {
          markPartChip(info ? info.label : null);
          markIngredient(info ? info.label : null);
          if (info && info.label) { showTip(info, ev); clearTimeout(showTip.t); showTip.t = setTimeout(() => { tip.hidden = true; }, 2600); }
          else tip.hidden = true;
        },
      });
      viewer.onAutoRotate = (on) => $('bRotate').setAttribute('aria-pressed', String(on));
      viewer.setBackground(stageColor());
      stage.appendChild(tip); stage.appendChild(stageMsg); stage.appendChild($('hint'));
    } catch (e) {
      console.error(e);
      stageMsg.hidden = false;
      stageMsg.textContent = '這個瀏覽器無法開啟 WebGL，所以 3D 模型沒辦法顯示。文字內容仍可閱讀。';
      viewer = null;
    }
    return viewer;
  }
  function showTip(info, ev) {
    const r = stage.getBoundingClientRect();
    tip.textContent = info.note ? `${info.label}｜${info.note}` : info.label;
    tip.style.left = Math.max(60, Math.min(r.width - 60, ev.clientX - r.left)) + 'px';
    tip.style.top = Math.max(40, ev.clientY - r.top) + 'px';
    tip.hidden = false;
  }
  const themeObs = () => { if (viewer) viewer.setBackground(stageColor()); };
  new MutationObserver(themeObs).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeObs);

  $('bRotate').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    if (viewer) viewer.setAutoRotate(on);
  });
  $('bExplode').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    if (viewer) viewer.setExplode(on);
  });
  $('bReset').addEventListener('click', () => { if (viewer && viewer.dish) viewer.frame(); });

  /* ---------- 文字比對（食材清單 ↔ 3D 零件） ---------- */
  const keyNames = (s) => {
    const raw = String(s || '');
    const alts = [raw.replace(/[（(].*?[）)]/g, '')];
    const inParen = raw.match(/[（(](.*?)[）)]/);
    if (inParen) alts.push(...inParen[1].split(/[、,，\/]/));
    raw.split(/[、,，\/＋+]/).forEach((x) => alts.push(x.replace(/[（(].*?[）)]/g, '')));
    return alts.map(norm).filter((x) => x.length >= 1);
  };
  function labelMatches(label, ingName) {
    const a = keyNames(label), b = keyNames(ingName);
    return a.some((x) => b.some((y) => (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y)) || x === y));
  }

  /* ---------- 版面渲染 ---------- */
  let current = { country: null, idx: 0 };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function renderAtlas() {
    const nav = $('atlas');
    nav.textContent = '';
    const dl = $('qList'); dl.textContent = '';
    allCountries().forEach((c) => {
      const b = el('button', 'chip' + (c.generated ? ' gen' : ''), c.name);
      b.type = 'button';
      if (c.generated) b.title = '由 Claude 生成';
      b.setAttribute('aria-current', String(current.country === c));
      b.addEventListener('click', () => showCountry(c, 0));
      nav.appendChild(b);
      const o = document.createElement('option'); o.value = c.name; dl.appendChild(o);
    });
  }

  function showCountry(c, idx = 0) {
    current = { country: c, idx: Math.max(0, Math.min((c.foods || []).length - 1, idx)) };
    $('genView').hidden = true;
    $('countryView').hidden = false;
    $('cName').textContent = c.name;
    if (c.generated) $('cName').appendChild(el('span', 'badge', 'Claude 生成'));
    $('cEndonym').textContent = c.endonym || '';
    $('cIntro').textContent = c.intro || '';
    const menu = $('menu');
    menu.textContent = '';
    (c.foods || []).forEach((f, i) => {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === current.idx));
      b.append(el('span', 'k', (f.type || '').toUpperCase() || '　'), el('span', 'n', f.name), el('span', 'l', f.local || ''));
      b.addEventListener('click', () => selectFood(i));
      menu.appendChild(b);
    });
    renderAtlas();
    store.set(LS_LAST, c.id);
    selectFood(current.idx);
  }

  function selectFood(i) {
    const c = current.country; if (!c) return;
    current.idx = i;
    [...$('menu').children].forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
    const f = c.foods[i];
    try { if (c.id && /^[A-Za-z0-9_~-]+$/.test(c.id)) history.replaceState(null, '', '#' + c.id + (i ? '.' + i : '')); } catch (e) { /* 忽略 */ }
    renderInfo(f, c);
    render3D(f);
  }

  function render3D(f) {
    const v = ensureViewer();
    const parts = $('parts'); parts.textContent = '';
    $('bExplode').setAttribute('aria-pressed', 'false');
    tip.hidden = true;
    if (!f.scene) {
      stageMsg.hidden = false;
      stageMsg.textContent = f.scenePending ? '3D 模型生成中…' : '這道菜還沒有 3D 模型。';
      if (v && v.dish) { v.scene.remove(v.dish.root); v.dish = null; }
      return;
    }
    stageMsg.hidden = true;
    if (!v) return;
    const c = current.country;
    const scene = Object.assign({}, f.scene);
    if (!scene.table && c.table) scene.table = c.table;
    try {
      v.setDish(scene, (c.id || '') + ':' + (f.id || f.name));
      if ($('bRotate').getAttribute('aria-pressed') === 'true') v.setAutoRotate(true);
    } catch (e) {
      console.error(e);
      stageMsg.hidden = false;
      stageMsg.textContent = '3D 模型組裝失敗。';
      return;
    }
    const seen = new Map();
    (v.dish ? v.dish.parts : []).forEach((g) => {
      const lb = g.userData.label; if (!lb) return;
      if (!seen.has(lb)) seen.set(lb, []);
      seen.get(lb).push(g.userData.partIndex);
    });
    seen.forEach((idxs, lb) => {
      const b = el('button', 'chip', lb);
      b.type = 'button';
      b.dataset.label = lb;
      b.addEventListener('mouseenter', () => { v.highlightByLabel((x) => x === lb); markIngredient(lb); });
      b.addEventListener('mouseleave', () => { v.highlightByLabel(null); markIngredient(null); });
      b.addEventListener('click', () => {
        const on = !b.classList.contains('on');
        markPartChip(on ? lb : null);
        v.selectPart(on ? idxs[0] : -1);
        v.highlightByLabel(on ? (x) => x === lb : null);
        markIngredient(on ? lb : null);
      });
      parts.appendChild(b);
    });
  }
  function markPartChip(label) {
    [...$('parts').children].forEach((b) => b.classList.toggle('on', !!label && b.dataset.label === label));
  }
  function markIngredient(label) {
    document.querySelectorAll('.ing li').forEach((li) => li.classList.toggle('on', !!label && labelMatches(label, li.dataset.name)));
  }

  function renderInfo(f, c) {
    const info = $('info');
    info.textContent = '';
    const head = el('div', 'dish-head');
    head.append(el('div', 'region', [f.region, f.type].filter(Boolean).join(' · ')), el('h3', null, f.name), el('div', 'local', f.local || ''));
    if (f.tagline) head.append(el('p', 'tagline', f.tagline));
    info.append(head);
    const ph = (window.FOOD_PHOTOS || {})[c.id + '/' + f.id];
    if (ph) {
      const fig = el('figure', 'photo');
      const img = document.createElement('img');
      img.src = ph.src; img.alt = f.name + ' 實拍照片'; img.loading = 'lazy'; img.decoding = 'async';
      img.width = ph.w; img.height = ph.h;
      const cap = el('figcaption');
      cap.append('實拍照片：' + ph.author + '・');
      const lic = document.createElement('a'); lic.href = ph.licenseUrl || ph.page; lic.target = '_blank'; lic.rel = 'noopener'; lic.textContent = ph.license;
      const src = document.createElement('a'); src.href = ph.page; src.target = '_blank'; src.rel = 'noopener'; src.textContent = 'Wikimedia Commons';
      cap.append(lic, '・', src);
      fig.append(img, cap);
      info.append(fig);
    }
    if (Array.isArray(f.facts) && f.facts.length) {
      const dl = el('dl', 'facts');
      f.facts.forEach((x) => { const d = el('div'); d.append(el('dt', null, x.k), el('dd', null, x.v)); dl.append(d); });
      info.append(dl);
    }
    const sec = (title, ...kids) => { const s = el('section', 'sec'); s.append(el('h4', null, title), ...kids); info.append(s); return s; };
    if (f.status) sec('地位與故事', ...paras(f.status));
    if (f.unique) { const w = el('div', 'why'); w.append(el('strong', null, '為什麼離開當地就很難吃到'), ...paras(f.unique)); sec('只在這裡', w); }
    if (Array.isArray(f.ingredients) && f.ingredients.length) {
      const ul = el('ul', 'ing');
      f.ingredients.forEach((it) => {
        const li = el('li');
        li.dataset.name = it.n;
        li.append(el('span', 'nm', it.n), el('span', 'am', it.a || ''));
        if (it.note) li.append(el('span', 'nt', it.note));
        li.addEventListener('mouseenter', () => { if (viewer) viewer.highlightByLabel((lb) => labelMatches(lb, it.n)); });
        li.addEventListener('mouseleave', () => { if (viewer) viewer.highlightByLabel(null); });
        ul.append(li);
      });
      const s = sec('材料', ul);
      if (f.serves) s.querySelector('h4').prepend(document.createTextNode(''));
      if (f.serves) s.insertBefore(el('p', 'note', f.serves), ul);
    }
    if (Array.isArray(f.steps) && f.steps.length) {
      const ol = el('ol', 'steps');
      f.steps.forEach((t) => ol.append(el('li', null, t)));
      sec('製作方式', ol);
    }
    if (f.tips) sec('在地人這樣吃', ...paras(f.tips));
    if (f.where) sec('去哪裡吃', ...paras(f.where));
  }
  const paras = (t) => String(t).split(/\n+/).filter(Boolean).map((x) => el('p', null, x));

  /* ---------- 搜尋 ---------- */
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('q').value.trim();
    if (!q) return;
    const c = findCountry(q);
    if (c) { showCountry(c, 0); $('q').value = ''; return; }
    showGenerate(q);
  });

  /* ---------- Claude 生成（任意國家／民族） ---------- */
  let samplePromise = (window.claude && typeof window.claude.use === 'function') ? window.claude.use('sample').catch(() => null) : Promise.resolve(null);
  let genCtl = null;

  function showGenerate(q) {
    const gv = $('genView');
    gv.hidden = false;
    $('countryView').hidden = true;
    gv.textContent = '';
    const panel = el('div', 'gen-panel');
    panel.append(el('h2', null, `「${q}」還沒有收錄`));
    const msg = el('p', null, '可以請 Claude 現場研究這個國家或民族，挑出五道離開當地就很難吃到的代表食物，並組出 3D 模型。大約需要一到兩分鐘，會使用你自己的 Claude 額度。');
    const row = el('div', 'gen-row');
    const go = el('button', 'btn primary', '請 Claude 研究並上菜'); go.type = 'button';
    const stop = el('button', 'btn', '停止'); stop.type = 'button'; stop.hidden = true;
    const back = el('button', 'btn', '回到收錄清單'); back.type = 'button';
    back.addEventListener('click', () => { gv.hidden = true; $('countryView').hidden = false; });
    const prog = el('div', 'progress');
    row.append(go, stop, back);
    panel.append(msg, row, prog);
    gv.append(panel);
    go.disabled = true;
    samplePromise.then((sample) => {
      if (!sample) {
        msg.textContent = '這個檢視環境沒有連上 Claude，所以無法現場生成。請在 claude.ai 開啟這個頁面，或先從上方的收錄清單挑一個。';
        go.hidden = true;
        return;
      }
      go.disabled = false;
      go.addEventListener('click', () => runGenerate(sample, q, { go, stop, prog, msg }));
      stop.addEventListener('click', () => { if (genCtl) genCtl.abort(); });
    });
  }

  const CONTENT_PROMPT = (q) => `你是熟悉世界飲食文化的研究者兼廚師。使用者輸入了：「${q}」（一個國家、地區或民族）。
請挑出 5 道「在這個國家／民族很流行或很有特色，但離開當地就很難吃到」的代表食物。
規則：
- 避免已經全球化、在世界各地都吃得到的菜；若一定要選，必須是當地獨有的正宗版本，並說明和海外版本的差別。
- 盡量涵蓋不同類型（主食、小吃、湯品、甜點、飲品）與不同地區。
- 內容必須正確、具體，不確定的就不要寫；不要編造店名。
- 全部使用臺灣繁體中文與臺灣用語（例如：馬鈴薯、番茄、鮮奶油、烤箱）。
- 如果輸入不是國家、地區或民族，把 "error" 設為一句說明，foods 給空陣列。
只回傳一個 JSON 物件，格式如下：
{"error":null,"name":"中文名稱","endonym":"當地語言名稱（原文或羅馬拼音）","intro":"80–120 字，這裡的飲食特色","aliases":["英文名","其他常見稱呼"],
"table":{"kind":"wood|stone|marble|cloth|tile","color":"#六位色碼"},
"foods":[{"id":"英文小寫短代號","name":"中文菜名","local":"原文名 · 羅馬拼音","region":"主要產地或城市","type":"小吃|主食|湯品|甜點|飲品|配菜",
"tagline":"一句話介紹","status":"120–180 字：在當地的地位、歷史、什麼時候吃","unique":"60–120 字：為什麼在其他地方吃不到",
"facts":[{"k":"當地價格","v":"含幣別的大約價格"},{"k":"最佳時節","v":"…"},{"k":"常見場合","v":"…"}],
"ingredients":[{"n":"食材名","a":"份量","note":"選填：產地、替代品等說明"}],
"steps":["步驟一","步驟二"],
"tips":"50–90 字：在地人怎麼吃、搭配什麼","where":"40–80 字：在當地去哪種地方吃（地區、店型）"}]}
ingredients 6–12 項，steps 5–8 步，份量寫具體數字（家庭份量）。`;

  const SCENE_DOC = `3D 場景規格（JSON）。座標：器皿中心在原點，x 向右、z 向前，單位約等於「碗半徑 1」。y 高度會自動堆疊（後面的零件會疊在前面零件的表面上），通常不必指定 y。
scene = {"vessel":{...},"parts":[...],"steam":true|false}
vessel.type 可選：bowl（湯碗，內半徑約0.9）、dish（深盤，半徑1.1）、plate（平盤，可放區域半徑約1.0）、steel（不鏽鋼大圓盤）、stonebowl（韓式石鍋）、claypot（砂鍋）、tagine（塔吉鍋，蓋子放旁邊）、paella（西班牙大平底鍋，半徑1.35）、skillet（鑄鐵鍋）、steamer（竹蒸籠）、board（木砧板）、tray（金屬方盤）、paper（紙盒）、leaf（香蕉葉墊在盤上）、basket（竹籃）、glass（高玻璃杯，半徑0.45、高1.45）、cup（有杯碟的咖啡杯）、claycup（陶杯）、none（直接放桌上）。
vessel 其他參數：color、rimColor（#hex）、pattern（rim|doubleRim|stripes|wave|dots）、size（倍率）。
注意：r 一律代表「排列／散布範圍半徑」，物件本身大小用 size、s 或 rad。
每個 part 共通參數：type、label（中文食材名，必填，要和材料清單的名稱一致）、note（選填短說明）、color（#hex）、count（數量）、arrange（at|ring|scatter|row|grid|stack|pile）、pos（[x,z] 中心）、r（排列半徑）、rot（度）、size（倍率，預設1）、tilt（沿 z 軸傾斜度數）、y（額外抬高）。
表面型零件（自動貼合下方食物表面，用 pos+r+count 決定散布範圍）：
- broth：湯或濃醬填滿容器。fill（0–1 填滿比例）、opacity、thick（true=咖哩般濃稠不透明）、oil（true 或數量，浮油）、oilColor、swirl（#hex，奶油線）。
- rice：飯堆。style（mound|layer|ball）、r、h、colors（多色炒飯用）、weights。
- noodles：麵。style（nest|pile|straight|swirl）、r、h、count（條數 20–70）、thick（粗細 0.01–0.03）、flat（>0 表寬扁麵，寬度=thick×flat，如 5）、color。
- sauce：style（pool 一灘|glaze 覆蓋表面|drizzle 淋線）、r、t（厚度）、count＋spread（多灘散布）、pattern（zigzag|spiral|lines，drizzle 用）、thick（線粗）。
- sprinkle：細粒。shape（seed 芝麻|crumb 碎粒|nut 花生碎|powder 粉|flake 片|kernel 玉米粒）、colors、count、grain（粒徑）。
- herbs：香菜等小葉。count、leaf（葉大小 0.03–0.06）。
- scallion：蔥花圈。count、ring（半徑）。
- greens：葉菜。style（leaf|lettuce|basil|mint|bokchoy）、count、color、color2。
- slivers：洋蔥絲、薑絲、辣椒絲。count、len、w、color、color2、round（true=圓條）。
- chili：style（slices|whole|dried|flakes）、count、rad（整根辣椒粗細）。
物件型零件（依 arrange 放置多個）：
- dumpling：style（crescent 餃子|round 小籠包|khinkali 提把餃|wonton 餛飩|tortellini 義式小餛飩）、fried（true=底部煎焦）、glossy、size。
- bun：style（round 饅頭|bread 烤麵包|pleated 包子|split 夾餡長麵包|guabao 刈包）、filling（#hex 陣列）、topColor、seeds（#hex）、len、width。
- flatbread：r（餅半徑）、t、color、spotColor、bubbles（0–0.1）、fold（true 對折）、oval、edgeColor、edgeFrom（0–1）、cup（邊緣上翹高度）、center（中央隆起）、gloss、spots。
- pancake：同 flatbread，但更不規則。
- slices：一組扇形排列的肉片或魚片。count＝這一扇裡的片數；要多組就用 groups（組數）配合 arrange。其他：w、l、t、color、fatColor、edgeColor、stripes（true）、stripeColor、marble（true）、gloss、spread、tilt。
- chunk：塊狀（滷肉、豆腐、馬鈴薯、蔬菜丁）。s（大小 0.08–0.3）、shape（cube|round|wedge|stick|halfmoon 半月片，可加 skinColor）、aspect（[x,y,z]）、color、color2、char（0–1 焦痕）、glaze（true 亮面）、crispy、fatLayer（#hex 五花層）、topColor。
- fried：炸物塊。s、color、color2、aspect。
- tofu：豆腐塊。s、color、crispy。
- balls：球。rad（半徑）、cone（0–1 變錐形）、cut（true 切半露出剖面）、color、color2、glossy、dust（#hex 撒粉）、topColor、translucent、squash。
- skewer：串燒。len、items（#hex 陣列，每塊顏色）、shape、char、glaze。
- sausage：len、rad（半徑）、bend、color、color2、grill、scored。
- shrimp：蝦。size、color。
- egg：style（half 切半水煮蛋|fried 荷包蛋|whole|quail 鵪鶉蛋|tea 茶葉蛋|rolled 玉子燒|yolk 生蛋黃）、marinated（true 滷蛋）、jammy、yolkColor。
- fish：style（whole 整條|fillet 魚片）、color、bellyColor、fried、scored、charred、size。
- roll：style（spring 炸春捲|fresh 生春捲|sushi 壽司切塊|burrito）、len、rad（半徑）、h、filling（#hex 陣列）、color。
- cake：style（wedge 蛋糕片|block 方塊|round 整顆）、layers（[{color,h}]）、dust（#hex 表面撒粉）、r、w、d。
- shavedIce：刨冰山。r、h、color、syrup（#hex）。
- oyster：蚵仔、牡蠣肉。size、color、edgeColor。
- mushroom：style（shiitake|button|enoki）、color。
- rounds：切片。rad（半徑）、t、pattern（cucumber|tomato|citrus|egg|rings|speckle|plain）、color、rimColor。
- wedge：檸檬角、萊姆角。rad、color、flesh。
- taco：塔可夾餅。filling（#hex 陣列）、color、open。
- parcel：葉包。style（box|pyramid 粽子|cylinder）、color、tieColor。
- pastry：style（tart 蛋塔|croissant|samosa|empanada|puff 圓泡）、color、fillColor、burnt、hole（#hex 開口）。
- drumstick：帶骨雞腿。color、crispy。
- shank：帶骨腱肉橫切片（燉牛膝）。color、color2、marrow。
- leek：整根長蔥／韭蔥／烤大蔥。len、rad、color（蔥白）、color2（蔥綠）、char（0–1 焦黑）。
- crab：螃蟹。style（shell 掀開的蟹殼裝蟹膏|body 切塊蟹身帶腳|whole 整隻）、color、edgeColor、roeColor、legColor。
- stick：竹籤或牙籤。len、thick，可用 absY 指定高度。
- corn：style（cob|round）。
- sideBowl：小碗配料、白飯或沾醬。vessel（bowl|dish|steel|clay）、color、color2、fill、mound、bowlColor、rice（true＝裝白飯）、bits（碗內小料 [{shape:cube|round|patty|slice|blob, color, s, n}]）。
- blob：不規則通用團塊。dims（[x,y,z]）、color、color2、glossy、noise。
- sidePlate：放在主器皿旁的小盤，size、oval、color；之後同位置的零件會放在盤上（檸檬角、油條等不要直接放桌上）。
- chopsticks、spoon（style chinese|metal）、fork、bowlStack（疊起的空碗，n 個數）：放在器皿外，pos 例如 [1.6,0.4]。
表面型零件也可用 rx、rz 做橢圓形散布。
- riceSausage：剖開的糯米腸（可放香腸在溝裡）。len、rad、color、grillColor、riceColor。
原則：先放底層（飯、麵、湯、餅），再放主料，最後放表面配料。顏色要寫實。每道菜 6–14 個 part。器皿外可放 1–2 個配角（沾醬小碗、餐具）。`;

  const SCENE_EXAMPLE = `範例（台灣蚵仔煎）：{"vessel":{"type":"plate","color":"#f4f2ec","rimColor":"#3a5da8","pattern":"rim"},"parts":[{"type":"pancake","label":"地瓜粉漿","color":"#e9dcc2","spotColor":"#c98b3c","r":0.72,"t":0.045,"gloss":true},{"type":"oyster","label":"蚵仔","count":10,"arrange":"scatter","r":0.5},{"type":"flatbread","label":"雞蛋","color":"#f3c64f","spotColor":"#c98b2f","r":0.45,"t":0.02,"wobble":0.4},{"type":"greens","label":"小白菜","style":"bokchoy","count":5,"r":0.4},{"type":"sauce","label":"甜辣醬","color":"#c2462a","style":"glaze","r":0.55,"t":0.012}],"steam":true}`;

  async function runGenerate(sample, q, ui) {
    ui.go.disabled = true; ui.stop.hidden = false; ui.msg.classList.remove('err');
    genCtl = new AbortController();
    const started = Date.now();
    const tick = setInterval(() => { ui.prog.textContent = `${ui.phase || '研究中'}… ${Math.round((Date.now() - started) / 1000)} 秒${ui.chars ? `（已寫 ${ui.chars} 字）` : ''}`; }, 500);
    try {
      ui.phase = '研究五道代表食物';
      const data = await sample.json(CONTENT_PROMPT(q), { signal: genCtl.signal, modelTier: 'default', cache: { gcTime: 86400000 }, onText: ({ text }) => { ui.chars = text.length; } });
      if (!data || data.error || !Array.isArray(data.foods) || !data.foods.length) throw { code: 'bad_input', message: (data && data.error) || '沒有得到可用的結果。' };
      const country = sanitizeCountry(data, q);
      // 先顯示文字，再生成 3D
      country.foods.forEach((f) => { f.scenePending = true; });
      saveGenerated(q, country);
      showCountry(country, 0);
      ui.phase = '組裝 3D 模型'; ui.chars = 0;
      const list = country.foods.map((f, i) => `${i + 1}. ${f.name}（${f.local}）｜材料：${f.ingredients.map((x) => x.n).join('、')}｜${f.tagline}`).join('\n');
      const genNote = $('genNote');
      genNote.textContent = '　正在組裝 3D 模型…';
      const scenesRes = await sample.json(`${SCENE_DOC}\n\n${SCENE_EXAMPLE}\n\n請為下列 5 道菜各寫一個 scene，依序放進陣列。label 請使用各菜材料清單裡的名稱。只回傳 JSON：{"scenes":[scene1,scene2,scene3,scene4,scene5]}\n\n${list}`, { signal: genCtl.signal, modelTier: 'default', cache: { gcTime: 86400000 }, onText: ({ text }) => { ui.chars = text.length; } });
      const scenes = (scenesRes && Array.isArray(scenesRes.scenes)) ? scenesRes.scenes : Array.isArray(scenesRes) ? scenesRes : [];
      country.foods.forEach((f, i) => { f.scene = sanitizeScene(scenes[i]); delete f.scenePending; });
      saveGenerated(q, country);
      genNote.textContent = '';
      if (current.country === country) selectFood(current.idx);
    } catch (e) {
      const code = e && e.code;
      const text = {
        cancelled: '已停止。',
        not_granted: '沒有取得使用 Claude 的許可，所以無法生成。',
        sampling_disabled: '這個帳號目前無法使用 Claude 生成。',
        rate_limited: '使用太頻繁或已達額度上限，請稍後再試。',
        invalid_json: 'Claude 的回覆格式不完整，請再按一次試試。',
        refused: 'Claude 沒有回答這個輸入，換個說法試試。',
        bad_input: (e && e.message) || '這個輸入看起來不是國家或民族。',
      }[code] || '生成失敗，可能是連線問題，請再試一次。';
      $('genNote').textContent = '';
      if (!$('genView').hidden) { ui.msg.textContent = text; ui.msg.classList.add('err'); }
      else if (current.country && current.country.generated) {
        current.country.foods.forEach((f) => { delete f.scenePending; });
        stageMsg.hidden = false; stageMsg.textContent = '3D 模型生成失敗：' + text;
      }
    } finally {
      clearInterval(tick);
      ui.go.disabled = false; ui.stop.hidden = true; ui.prog.textContent = '';
      genCtl = null;
    }
  }

  const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
  function sanitizeCountry(d, q) {
    const id = 'gen-' + (str(d.name, 40) || q).split('').map((ch) => ch.charCodeAt(0).toString(36)).join('').slice(0, 40);
    return {
      id, generated: true,
      name: str(d.name, 40) || q,
      endonym: str(d.endonym, 80),
      intro: str(d.intro, 600),
      aliases: [q, ...(Array.isArray(d.aliases) ? d.aliases.map((x) => str(x, 40)) : [])],
      table: d.table && typeof d.table === 'object' ? { kind: str(d.table.kind, 12) || 'wood', color: /^#[0-9a-f]{6}$/i.test(d.table.color) ? d.table.color : '#8a5a36' } : { kind: 'wood', color: '#8a5a36' },
      foods: d.foods.slice(0, 5).map((f, i) => ({
        id: str(f.id, 30) || 'f' + i,
        name: str(f.name, 40), local: str(f.local, 80), region: str(f.region, 60), type: str(f.type, 10),
        tagline: str(f.tagline, 200), status: str(f.status, 900), unique: str(f.unique, 700),
        facts: Array.isArray(f.facts) ? f.facts.slice(0, 4).map((x) => ({ k: str(x.k, 20), v: str(x.v, 80) })) : [],
        ingredients: Array.isArray(f.ingredients) ? f.ingredients.slice(0, 16).map((x) => ({ n: str(x.n, 40), a: str(x.a, 40), note: str(x.note, 120) })) : [],
        steps: Array.isArray(f.steps) ? f.steps.slice(0, 10).map((x) => str(x, 300)) : [],
        tips: str(f.tips, 500), where: str(f.where, 400),
      })),
    };
  }
  function sanitizeScene(s) {
    if (!s || typeof s !== 'object') return { vessel: { type: 'plate' }, parts: [{ type: 'blob', label: '（模型缺漏）' }] };
    const vessel = s.vessel && typeof s.vessel === 'object' ? s.vessel : { type: 'plate' };
    const parts = Array.isArray(s.parts) ? s.parts.filter((p) => p && typeof p === 'object').slice(0, 24).map((p) => {
      const o = Object.assign({}, p);
      if (o.count != null) o.count = Math.max(1, Math.min(o.type === 'sprinkle' || o.type === 'herbs' || o.type === 'scallion' ? 500 : 40, +o.count || 1));
      if (o.size != null) o.size = Math.max(0.2, Math.min(3, +o.size || 1));
      if (o.r != null) o.r = Math.max(0, Math.min(1.6, +o.r || 0));
      if (Array.isArray(o.pos)) o.pos = [Math.max(-2.2, Math.min(2.2, +o.pos[0] || 0)), Math.max(-2.2, Math.min(2.2, +o.pos[1] || 0))];
      else delete o.pos;
      o.label = str(o.label, 30);
      o.note = str(o.note, 60);
      return o;
    }) : [];
    return { vessel, parts, steam: !!s.steam };
  }
  function saveGenerated(q, country) {
    generated[norm(country.name)] = country;
    store.set(LS_GEN, generated);
    renderAtlas();
  }

  /* ---------- 啟動 ---------- */
  function boot() {
    renderAtlas();
    const [hashId, hashIdx] = (location.hash || '').slice(1).split('.');
    const last = store.get(LS_LAST, null);
    const byId = (id) => allCountries().find((c) => c.id === id);
    const start = byId(hashId) || byId(last) || atlas[0];
    if (start) showCountry(start, byId(hashId) ? (+hashIdx || 0) : 0);
    samplePromise.then((s) => { if (!s) $('genNote').textContent = ''; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
