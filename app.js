const PROXY_BASE = '/api/proxy?url=';
let SITE_URL = localStorage.getItem('PETA2_SITE_URL') || 'https://11210.peta2.jp/';

let SITE_URL_HISTORY = [];
try {
    SITE_URL_HISTORY = JSON.parse(localStorage.getItem('PETA2_URL_HISTORY') || '[]');
} catch (e) { }

if (!SITE_URL_HISTORY.includes(SITE_URL)) {
    SITE_URL_HISTORY.push(SITE_URL);
    localStorage.setItem('PETA2_URL_HISTORY', JSON.stringify(SITE_URL_HISTORY));
}

let isExtracting = false;
let isAutoFetching = false;
let activeThreadUrl = null;

// ソート用の状態管理
let currentSortMode = 'default';
let currentThreads = []; 

// ライトボックス用の状態管理
let currentGalleryImages = []; // 現在ギャラリーに表示中の全画像データ
let currentLightboxIndex = -1; // ライトボックスで表示中の画像のインデックス

// キャッシュをローカルストレージから初期化
let initialCache = [];
try {
    initialCache = JSON.parse(localStorage.getItem('peta2_thread_cache') || '[]');
} catch (e) {
    console.warn("キャッシュの復元に失敗しました:", e);
}
const threadCache = new Map(initialCache);

// スクラップの読み込み
let scraps = [];
try {
    scraps = JSON.parse(localStorage.getItem('peta2_scraps') || '[]');
} catch (e) {}

// スレッドお気に入りの読み込み
let favThreads = [];
try {
    favThreads = JSON.parse(localStorage.getItem('peta2_fav_threads') || '[]');
} catch (e) {}

document.addEventListener('DOMContentLoaded', () => {
    // 掲示板URL設定
    const urlInput = document.getElementById('target-site-url');
    if (urlInput) urlInput.value = SITE_URL;
    
    function renderUrlHistory() {
        const container = document.getElementById('url-history-container');
        const chipsObj = document.getElementById('url-history-chips');
        if (!container || !chipsObj) return;
        if (!SITE_URL_HISTORY || SITE_URL_HISTORY.length === 0) {
            container.classList.add('hidden');
            return;
        }
        container.classList.remove('hidden');
        chipsObj.innerHTML = '';
        
        [...SITE_URL_HISTORY].reverse().forEach(url => {
            const chip = document.createElement('div');
            chip.className = 'url-history-chip';
            chip.textContent = url.replace('https://', '').replace(/\/$/, ''); // 短く表示
            chip.title = url;
            chip.onclick = () => {
                urlInput.value = url;
            };
            chipsObj.appendChild(chip);
        });
    }
    renderUrlHistory();
    
    document.getElementById('config-btn').addEventListener('click', () => {
        document.getElementById('settings-panel').classList.toggle('hidden');
    });
    
    document.getElementById('save-site-url').addEventListener('click', () => {
        let url = urlInput.value.trim();
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }
        if (!url.endsWith('/')) {
            url += '/';
        }
        
        // 履歴を更新 (最大20件)
        SITE_URL_HISTORY = SITE_URL_HISTORY.filter(u => u !== url);
        SITE_URL_HISTORY.push(url);
        if (SITE_URL_HISTORY.length > 20) SITE_URL_HISTORY.shift();
        localStorage.setItem('PETA2_URL_HISTORY', JSON.stringify(SITE_URL_HISTORY));
        renderUrlHistory();

        localStorage.setItem('PETA2_SITE_URL', url);
        SITE_URL = url;
        
        // ツールの状態をリセット
        threadCache.clear();
        saveThreadCache();
        activeThreadUrl = null;
        document.getElementById('gallery-container').innerHTML = '';
        
        alert(`対象掲示板を\n${SITE_URL}\nへ変更しました。一覧を再取得します。`);
        document.getElementById('settings-panel').classList.add('hidden');
        fetchThreads();
    });

    fetchThreads();
    
    document.getElementById('reload-threads-btn').addEventListener('click', fetchThreads);
    document.getElementById('open-scrap-btn').addEventListener('click', openScrapPage);
    
    // ソートメニューのイベント
    document.getElementById('thread-sort-select').addEventListener('change', (e) => {
        currentSortMode = e.target.value;
        renderThreadList();
    });

    // スレッドお気に入りボタン
    document.getElementById('thread-fav-btn').addEventListener('click', () => {
        if (!activeThreadUrl || activeThreadUrl === 'SCRAP_PAGE') return;
        toggleFavThread(activeThreadUrl);
    });
    
    // お気に入り巡回ボタン
    const patrolBtn = document.getElementById('patrol-favs-btn');
    if (patrolBtn) patrolBtn.addEventListener('click', patrolFavThreads);
    
    // スクロールイベント (無限スクロール)
    const gallery = document.getElementById('gallery-container');
    gallery.addEventListener('scroll', () => {
        if (!activeThreadUrl || activeThreadUrl === 'SCRAP_PAGE') return; 
        const cache = threadCache.get(activeThreadUrl);
        if (cache && cache.nextUrlToFetch && !isExtracting && !isAutoFetching) {
            if (gallery.scrollHeight - gallery.scrollTop - gallery.clientHeight < 100) {
                loadNextPage(false);
            }
        }
    });

    // 「全ページ自動取得」ボタン
    document.getElementById('auto-fetch-all-btn').addEventListener('click', async () => {
        if (!activeThreadUrl || activeThreadUrl === 'SCRAP_PAGE') return;
        const cache = threadCache.get(activeThreadUrl);
        if (!cache || !cache.nextUrlToFetch) return;
        
        isAutoFetching = true;
        const btn = document.getElementById('auto-fetch-all-btn');
        btn.disabled = true;
        btn.textContent = "自動取得中...";
        
        while (threadCache.get(activeThreadUrl).nextUrlToFetch && isAutoFetching) {
            await loadNextPage(false);
        }
        
        btn.textContent = "全ページ取得完了";
    });

    // グリッド列数の初期化とイベント設定
    const gridSelect = document.getElementById('grid-columns-select');
    if (gridSelect) {
        const savedCols = localStorage.getItem('peta2_grid_columns') || 'auto';
        gridSelect.value = savedCols;
        applyGridColumns(savedCols);

        gridSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            applyGridColumns(val);
            localStorage.setItem('peta2_grid_columns', val);
        });
    }

    // ライトボックスの初期化
    const lightbox = document.getElementById('lightbox-overlay');
    const lightboxImg = document.getElementById('lightbox-img');
    
    const closeLightbox = () => {
        lightbox.classList.add('hidden');
        currentLightboxIndex = -1;
        setTimeout(() => {
            lightboxImg.src = '';
            const openOrigBtn = document.getElementById('lightbox-open-original');
            if (openOrigBtn) openOrigBtn.classList.add('hidden');
            const openThreadBtn = document.getElementById('lightbox-open-thread');
            if (openThreadBtn) openThreadBtn.classList.add('hidden');
        }, 200); 
    };

    // ナビゲーション関数
    const navigateLightbox = (direction) => {
        // direction: -1 = 新着側（←）, +1 = 過去側（→）
        const newIndex = currentLightboxIndex + direction;
        if (newIndex < 0 || newIndex >= currentGalleryImages.length) return;
        openLightbox(newIndex);
    };
    
    // 背景クリックで閉じる（ナビゾーン・ツールバー以外）
    lightbox.addEventListener('click', (e) => {
        const tag = e.target;
        if (tag.id === 'lightbox-overlay') {
            closeLightbox();
        }
    });

    // ✕ボタンで閉じる
    document.getElementById('lightbox-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeLightbox();
    });

    // 左右クリックゾーン
    document.getElementById('lightbox-nav-left').addEventListener('click', (e) => {
        e.stopPropagation();
        navigateLightbox(-1);
    });
    document.getElementById('lightbox-nav-right').addEventListener('click', (e) => {
        e.stopPropagation();
        navigateLightbox(1);
    });
    
    // キーボードナビゲーション
    document.addEventListener('keydown', (e) => {
        if (lightbox.classList.contains('hidden')) return;
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') navigateLightbox(-1);
        if (e.key === 'ArrowRight') navigateLightbox(1);
    });

    // ライトボックス内ハートボタン
    document.getElementById('lightbox-fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentLightboxIndex < 0 || currentLightboxIndex >= currentGalleryImages.length) return;
        const imgData = currentGalleryImages[currentLightboxIndex];
        
        // ギャラリー内の対応するカードのハートボタンを探してクリックを模倣
        const gallery = document.getElementById('gallery-container');
        const targetCard = gallery.querySelector(`[data-src="${imgData.src}"]`)?.closest('.image-card');
        if (targetCard) {
            const cardFavBtn = targetCard.querySelector('.favorite-btn');
            if (cardFavBtn) cardFavBtn.click();
        }
        
        // ライトボックス内ハートの表示も更新
        updateLightboxFavBtn(imgData);
    });

});

// ライトボックスを指定インデックスで開く/更新する
function openLightbox(index) {
    if (index < 0 || index >= currentGalleryImages.length) return;
    currentLightboxIndex = index;
    const imgData = currentGalleryImages[index];
    
    const lightbox = document.getElementById('lightbox-overlay');
    const lightboxImg = document.getElementById('lightbox-img');
    const openOrigBtn = document.getElementById('lightbox-open-original');
    const openThreadBtn = document.getElementById('lightbox-open-thread');
    const counter = document.getElementById('lightbox-counter');
    
    lightboxImg.src = imgData.src;
    lightbox.classList.remove('hidden');
    
    // カウンター更新
    counter.textContent = `${index + 1} / ${currentGalleryImages.length}`;
    
    // 元スレッドボタンの設定
    const targetThreadUrl = imgData.threadUrl || activeThreadUrl;
    if (targetThreadUrl && targetThreadUrl !== 'SCRAP_PAGE') {
        const newOpenThreadBtn = openThreadBtn.cloneNode(true);
        openThreadBtn.parentNode.replaceChild(newOpenThreadBtn, openThreadBtn);
        
        newOpenThreadBtn.classList.remove('hidden');
        
        if (imgData.postNumber) {
            newOpenThreadBtn.textContent = `📄 前後の流れを見る(${imgData.postNumber})`;
            newOpenThreadBtn.removeAttribute('target');
            newOpenThreadBtn.removeAttribute('href');
            newOpenThreadBtn.style.cursor = 'pointer';
            newOpenThreadBtn.onclick = (e) => {
                e.preventDefault();
                openContextModal(targetThreadUrl, imgData.postNumber);
            };
        } else {
            newOpenThreadBtn.textContent = `📄 元スレッドを開く`;
            newOpenThreadBtn.href = targetThreadUrl;
            newOpenThreadBtn.target = '_blank';
            newOpenThreadBtn.onclick = null;
        }
    } else {
        openThreadBtn.classList.add('hidden');
    }
    
    // 元画像ボタンの設定
    if (imgData.fullUrl && imgData.fullUrl !== imgData.src) {
        openOrigBtn.href = imgData.fullUrl;
        openOrigBtn.classList.remove('hidden');
    } else {
        openOrigBtn.classList.add('hidden');
    }
    
    // ハートボタンの状態更新
    updateLightboxFavBtn(imgData);
}

function updateLightboxFavBtn(imgData) {
    const btn = document.getElementById('lightbox-fav-btn');
    const isScraped = scraps.some(s => s.src === imgData.src);
    btn.innerHTML = isScraped ? '♥' : '♡';
    btn.className = isScraped ? 'active' : '';
}

function applyGridColumns(val) {
    if (val === 'auto') {
        document.documentElement.style.setProperty('--grid-columns', 'repeat(auto-fill, minmax(280px, 1fr))');
    } else {
        document.documentElement.style.setProperty('--grid-columns', `repeat(${val}, 1fr)`);
    }
}

// ----------------------------------------------------
// UI 補助関数 / データ永続化
// ----------------------------------------------------

function saveScraps() {
    try {
        localStorage.setItem('peta2_scraps', JSON.stringify(scraps));
    } catch (e) {
        console.warn("Storage capacity exceeded for scraps.");
    }
}

function toggleFavThread(url) {
    const idx = favThreads.indexOf(url);
    if (idx >= 0) {
        favThreads.splice(idx, 1);
    } else {
        favThreads.push(url);
    }
    try {
        localStorage.setItem('peta2_fav_threads', JSON.stringify(favThreads));
    } catch (e) {}
    
    // 右カラムの★ボタンを更新
    const favBtn = document.getElementById('thread-fav-btn');
    const isFav = favThreads.includes(url);
    favBtn.innerHTML = isFav ? '★' : '☆';
    favBtn.className = `thread-fav-btn${isFav ? ' active' : ''}`;
    
    // サイドバーを再描画
    renderThreadList();
}

function saveThreadCache() {
    try {
        localStorage.setItem('peta2_thread_cache', JSON.stringify(Array.from(threadCache.entries())));
    } catch (e) {
        console.warn("Storage capacity exceeded for thread cache. Deleting oldest caches...");
        const entries = Array.from(threadCache.entries());
        if (entries.length > 5) {
            const newerEntries = entries.slice(Math.floor(entries.length / 2));
            threadCache.clear();
            newerEntries.forEach(([k, v]) => threadCache.set(k, v));
            try {
                localStorage.setItem('peta2_thread_cache', JSON.stringify(newerEntries));
            } catch (e2) {
                console.error("Still exceeding quota.");
            }
        }
    }
}

function updateSidebarThreadStats(url) {
    const li = document.querySelector(`.thread-item[data-url="${url}"]`);
    if (!li) return;
    
    const cacheData = threadCache.get(url);
    if (cacheData) {
        li.classList.add('read');
        const scrapCount = scraps.filter(s => s.threadUrl === url).length;
        
        // --- 新着バッジの更新 ---
        if (favThreads.includes(url)) {
            let starMarkSpan = li.querySelector('.thread-fav-star');
            if (starMarkSpan) {
                const newCount = cacheData.images.filter(i => i.isNew).length;
                let badgeHtml = '';
                if (newCount > 0) {
                    badgeHtml = `<span class="new-count-badge">新着${newCount}</span>`;
                }
                starMarkSpan.innerHTML = `${badgeHtml}★`;
            }
        }
        
        let statsDiv = li.querySelector('.thread-stats');
        if (!statsDiv) {
            statsDiv = document.createElement('div');
            statsDiv.className = 'thread-stats';
            li.appendChild(statsDiv);
        }
        
        statsDiv.innerHTML = `
            <span class="stat-badge">全 ${cacheData.totalPages || '?'}P</span>
            <span class="stat-badge">画像 ${cacheData.images.length}枚</span>
            <span class="stat-badge scrap-count">♥ ${scrapCount}</span>
        `;
    }
}

function toggleScrap(imgData, btnElement, cardElement) {
    const idx = scraps.findIndex(s => s.src === imgData.src);
    if (idx >= 0) {
        // お気に入り解除
        scraps.splice(idx, 1);
        btnElement.classList.remove('active');
        btnElement.innerHTML = '♡';
        
        if (activeThreadUrl === 'SCRAP_PAGE') {
            cardElement.remove();
            document.getElementById('total-pages-info').textContent = `全 ${scraps.length} 枚`;
        }
    } else {
        // お気に入り登録
        scraps.push({
            src: imgData.src,
            fullUrl: imgData.fullUrl,
            threadUrl: imgData.threadUrl || activeThreadUrl,
            threadTitle: document.getElementById('current-thread-title').textContent,
            postNumber: imgData.postNumber
        });
        btnElement.classList.add('active');
        btnElement.innerHTML = '♥';
    }
    saveScraps();
    
    if (activeThreadUrl !== 'SCRAP_PAGE') {
        updateSidebarThreadStats(activeThreadUrl);
    } else {
        updateSidebarThreadStats(imgData.threadUrl);
    }
}

function renderImageCard(imgData, prepend = false) {
    const gallery = document.getElementById('gallery-container');
    if(gallery.querySelector(`[data-src="${imgData.src}"]`)) return;

    const isScraped = scraps.some(s => s.src === imgData.src);

    const card = document.createElement('div');
    card.className = 'image-card';
    card.onclick = () => {
        // ギャラリー内のカード順序からインデックスを特定して開く
        const allCards = Array.from(gallery.querySelectorAll('.image-card'));
        const cardIndex = allCards.indexOf(card);
        if (cardIndex >= 0) {
            openLightbox(cardIndex);
        }
    };
    
    let innerHtml = `<img src="${imgData.src}" data-src="${imgData.src}" alt="Thread Image" loading="lazy">`;
    if (imgData.isNew) {
        innerHtml += `<div class="new-badge">NEW</div>`;
    }
    card.innerHTML = innerHtml;
    
    // スクラップ用：元スレッドへのジャンプ機能
    if (imgData.threadTitleDisplay && imgData.threadUrl) {
        const titleDiv = document.createElement('div');
        titleDiv.className = 'card-thread-name';
        titleDiv.textContent = imgData.threadTitleDisplay;
        titleDiv.title = "このスレッドを見る";
        titleDiv.onclick = (e) => {
            e.stopPropagation();
            if (isExtracting || isAutoFetching) {
                alert("現在処理中のため移動できません。");
                return;
            }
            // サイドバーのハイライトを切り替え
            document.querySelectorAll('.thread-item').forEach(el => el.classList.remove('active'));
            document.getElementById('open-scrap-btn').classList.remove('active');
            
            const targetLi = document.querySelector(`.thread-item[data-url="${imgData.threadUrl}"]`);
            if (targetLi) targetLi.classList.add('active');
            
            initThread(imgData.threadUrl, imgData.threadTitleDisplay);
        };
        card.appendChild(titleDiv);
    }
    
    const favBtn = document.createElement('button');
    favBtn.className = `favorite-btn ${isScraped ? 'active' : ''}`;
    favBtn.innerHTML = isScraped ? '♥' : '♡';
    favBtn.title = isScraped ? 'スクラップから外す' : 'スクラップに登録';
    favBtn.onclick = (e) => {
        e.stopPropagation();
        toggleScrap(imgData, favBtn, card);
    };
    card.appendChild(favBtn);
    
    if (prepend) {
        currentGalleryImages.unshift(imgData);
        gallery.prepend(card);
    } else {
        currentGalleryImages.push(imgData);
        gallery.appendChild(card);
    }
}

// ----------------------------------------------------
// スクラップブックページ展開
// ----------------------------------------------------
function openScrapPage() {
    activeThreadUrl = 'SCRAP_PAGE';
    isAutoFetching = false;
    
    document.querySelectorAll('.thread-item').forEach(el => el.classList.remove('active'));
    document.getElementById('open-scrap-btn').classList.add('active');
    
    document.getElementById('current-thread-title').textContent = "💖 スクラップブック";
    document.getElementById('total-pages-info').textContent = `全 ${scraps.length} 枚`;
    
    const autoBtn = document.getElementById('auto-fetch-all-btn');
    autoBtn.classList.add('hidden');
    
    // スクラップページではお気に入りボタンを非表示
    document.getElementById('thread-fav-btn').classList.add('hidden');
    
    const gallery = document.getElementById('gallery-container');
    gallery.innerHTML = '';
    currentGalleryImages = [];
    
    if (scraps.length === 0) {
        gallery.innerHTML = `<div class="empty-state">
            <p>まだスクラップ（お気に入り）に登録された画像はありません。<br><br>
            スレッドの画像右上にある ♡ をクリックすると、<br>ここに集めて自分だけの画集を作ることができます。</p></div>`;
        return;
    }
    
    const reversedScraps = [...scraps].reverse();
    
    reversedScraps.forEach(s => {
        const fakeImgData = {
            src: s.src,
            fullUrl: s.fullUrl,
            isNew: false,
            threadTitleDisplay: s.threadTitle,
            threadUrl: s.threadUrl,
            postNumber: s.postNumber
        };
        renderImageCard(fakeImgData, false);
    });
}

// ----------------------------------------------------
// データ取得とスレッドリスト構築 (ソート対応)
// ----------------------------------------------------

async function fetchThreads() {
    const listContainer = document.getElementById('thread-list');
    listContainer.innerHTML = '<li class="loading-text">スレッドを取得中...</li>';

    try {
        const response = await fetch(PROXY_BASE + encodeURIComponent(SITE_URL));
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder('shift-jis');
        const doc = new DOMParser().parseFromString(decoder.decode(buffer), 'text/html');
        
        const listItems = doc.querySelectorAll('.thread-list .list-group-item, #owl-carousel .list-group-item');
        
        if (listItems.length === 0) {
            listContainer.innerHTML = '<li class="loading-text">スレッドが見つかりませんでした。</li>';
            return;
        }

        const uniqueThreads = [];
        const threadSet = new Set();
        
        listItems.forEach(item => {
            const aTag = item.querySelector('a');
            if (aTag) {
                // <a>タグの直後にある (183) などの投稿数を正規表現で取得
                let countStr = '';
                const match = item.innerHTML.match(/<\/a>[\s\S]*?\((\d+)\)/i);
                if (match) {
                    countStr = match[1]; 
                }
                
                const url = new URL(aTag.getAttribute('href'), SITE_URL).href;
                if (!threadSet.has(url)) {
                    threadSet.add(url);
                    uniqueThreads.push({
                        url: url,
                        title: aTag.textContent.trim(),
                        postCount: countStr,
                        meta: item.querySelector('p')?.textContent.trim() || ''
                    });
                }
            }
        });
        
        currentThreads = uniqueThreads;
        renderThreadList();
        
    } catch (error) {
        listContainer.innerHTML = `<li class="loading-text" style="color: #ff5252;">取得失敗。<br>${escapeHTML(error.message)}</li>`;
    }
}

// ソート条件に基づいてリストを描画する
function renderThreadList() {
    const listContainer = document.getElementById('thread-list');
    listContainer.innerHTML = '';
    
    let sorted = [...currentThreads];
    
    if (currentSortMode === 'fav') {
        sorted.sort((a, b) => {
            const aFav = favThreads.includes(a.url) ? 1 : 0;
            const bFav = favThreads.includes(b.url) ? 1 : 0;
            return bFav - aFav; // お気に入りが上
        });
    } else if (currentSortMode === 'read') {
        sorted.sort((a, b) => {
            const aRead = threadCache.has(a.url) ? 1 : 0;
            const bRead = threadCache.has(b.url) ? 1 : 0;
            return bRead - aRead; // 降順（既読が上）
        });
    } else if (currentSortMode === 'hearts') {
        sorted.sort((a, b) => {
            const aHearts = scraps.filter(s => s.threadUrl === a.url).length;
            const bHearts = scraps.filter(s => s.threadUrl === b.url).length;
            return bHearts - aHearts; // 降順（数が多いものが上）
        });
    }
    
    sorted.forEach(data => {
        const li = document.createElement('li');
        li.className = 'thread-item';
        li.setAttribute('data-url', data.url);
        li.style.position = 'relative'; // ★マークの絶対配置用
        
        let starMark = '';
        if (favThreads.includes(data.url)) {
            const cacheForBadge = threadCache.get(data.url);
            let badgeHtml = '';
            if (cacheForBadge) {
                const newCount = cacheForBadge.images.filter(i => i.isNew).length;
                if (newCount > 0) {
                    badgeHtml = `<span class="new-count-badge">新着${newCount}</span>`;
                }
            }
            starMark = `<span class="thread-fav-star">${badgeHtml}★</span>`;
        }
        let countHtml = '';
        if (data.postCount) {
            countHtml = `<span class="thread-post-count">(${escapeHTML(data.postCount)})</span>`;
        }
        li.innerHTML = `${starMark}<div class="thread-title">${escapeHTML(data.title)} ${countHtml}</div><div class="thread-meta">${escapeHTML(data.meta)}</div>`;
        
        if (data.url === activeThreadUrl) {
            li.classList.add('active');
        }
        
        // クリックイベント
        li.addEventListener('click', () => {
            if (isExtracting || isAutoFetching) {
                alert("現在処理中です。お待ち下さい。");
                return;
            }
            document.querySelectorAll('.thread-item').forEach(el => el.classList.remove('active'));
            document.getElementById('open-scrap-btn').classList.remove('active');
            li.classList.add('active');
            initThread(data.url, data.title);
        });
        listContainer.appendChild(li);
        
        // 既読や統計バッジを反映
        updateSidebarThreadStats(data.url);
    });
}

// ----------------------------------------------------
// スレッド閲覧のロジック
// ----------------------------------------------------

async function initThread(url, title) {
    document.getElementById('current-thread-title').textContent = title;
    
    // ★ボタンを更新・表示
    const favBtn = document.getElementById('thread-fav-btn');
    favBtn.classList.remove('hidden');
    const isFav = favThreads.includes(url);
    favBtn.innerHTML = isFav ? '★' : '☆';
    favBtn.className = `thread-fav-btn${isFav ? ' active' : ''}`;
    const gallery = document.getElementById('gallery-container');
    gallery.innerHTML = ''; 
    currentGalleryImages = [];
    
    activeThreadUrl = url;
    isAutoFetching = false;
    
    const autoBtn = document.getElementById('auto-fetch-all-btn');
    autoBtn.classList.remove('hidden');
    autoBtn.disabled = false;
    autoBtn.textContent = "全ページ自動取得";

    if (threadCache.has(url)) {
        const cache = threadCache.get(url);
        document.getElementById('total-pages-info').textContent = cache.totalPages > 1 ? `(全 ${cache.totalPages} ページ)` : '';
        
        if (cache.images.length === 0) {
            gallery.innerHTML = '<div class="empty-state"><p>このスレッドには画像が見つかりませんでした。</p></div>';
        } else {
            cache.images.forEach(imgData => {
                renderImageCard(imgData, false);
                imgData.isNew = false; // 表示したらクリア
            });
            saveThreadCache();
            updateSidebarThreadStats(url); // バッジを即座に消す
        }
        checkForNewImages(url, cache);
        if (!cache.nextUrlToFetch) {
            autoBtn.disabled = true;
            autoBtn.textContent = "最後のページまで取得済み";
        }
    } 
    else {
        document.getElementById('total-pages-info').textContent = "ページ数計算中...";
        threadCache.set(url, { images: [], nextUrlToFetch: url, totalPages: 1 });
        await loadNextPage(true);
    }
}

async function loadNextPage(isFirstPage = false) {
    if (!activeThreadUrl || activeThreadUrl === 'SCRAP_PAGE' || isExtracting) return;
    
    const cache = threadCache.get(activeThreadUrl);
    if (!cache || !cache.nextUrlToFetch) return;

    isExtracting = true;
    
    const indicator = document.getElementById('loading-indicator');
    const loadingStatus = document.getElementById('loading-status');
    indicator.classList.remove('hidden');
    loadingStatus.textContent = `画像を読み込み中...`;
    
    try {
        const response = await fetch(PROXY_BASE + encodeURIComponent(cache.nextUrlToFetch));
        if (!response.ok) throw new Error('HTTP Error: ' + response.status);
        
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder('shift-jis');
        const doc = new DOMParser().parseFromString(decoder.decode(buffer), 'text/html');
        
        if (isFirstPage) {
            let maxPage = 1;
            const pageLinks = Array.from(doc.querySelectorAll('a[href*="_ASC.html"], a[href*="_DESC.html"]'));
            pageLinks.forEach(a => {
                const match = a.getAttribute('href').match(/_([0-9]+)_(ASC|DESC)\.html/);
                if (match && parseInt(match[1]) > maxPage) maxPage = parseInt(match[1]);
            });
            cache.totalPages = maxPage;
            document.getElementById('total-pages-info').textContent = cache.totalPages > 1 ? `(全 ${cache.totalPages} ページ)` : '';
        }
        
        const images = doc.querySelectorAll('a[href*="comment_img.php"] img, .picture, img[src*="/upload/"]');
        images.forEach(img => {
            const src = img.getAttribute('src');
            if (!src) return;
            const imgSrcUrl = new URL(src, SITE_URL).href;
            const parentA = img.closest('a');
            const fullImgUrl = parentA ? new URL(parentA.getAttribute('href'), SITE_URL).href : imgSrcUrl;
            const grandparent = parentA ? parentA.parentElement : img.parentElement;
            let postNumber = "";
            if (grandparent) {
                const result = doc.evaluate("preceding::a[contains(@href, 'cid=') and contains(text(), '[')][1]", img, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const anchor = result.singleNodeValue;
                if (anchor) {
                    const match = anchor.textContent.match(/\[\d+\]/);
                    if (match) {
                        postNumber = match[0];
                    }
                }
            }
            
            if (!cache.images.find(i => i.src === imgSrcUrl)) {
                const imgData = { src: imgSrcUrl, fullUrl: fullImgUrl, isNew: false, threadUrl: activeThreadUrl, postNumber: postNumber };
                cache.images.push(imgData);
                renderImageCard(imgData, false);
            }
        });
        
        const gallery = document.getElementById('gallery-container');
        if (isFirstPage && cache.images.length === 0) {
            gallery.innerHTML = '<div class="empty-state"><p>このスレッドには画像が見つかりませんでした。</p></div>';
        }
        
        cache.nextUrlToFetch = getNextPageLink(doc);
        
        if (cache.nextUrlToFetch) {
            if (isAutoFetching) await new Promise(r => setTimeout(r, 1000));
        } else {
            const autoBtn = document.getElementById('auto-fetch-all-btn');
            autoBtn.disabled = true;
            autoBtn.textContent = "最後のページまで取得済み";
        }
        
        saveThreadCache();
        updateSidebarThreadStats(activeThreadUrl);
        
    } catch (error) {
        console.error(error);
        loadingStatus.textContent = 'エラーが発生しました';
        cache.nextUrlToFetch = null;
        isAutoFetching = false;
        saveThreadCache();
        updateSidebarThreadStats(activeThreadUrl);
    } finally {
        isExtracting = false;
        if (!isAutoFetching) indicator.classList.add('hidden');
    }
}

async function patrolFavThreads() {
    const btn = document.getElementById('patrol-favs-btn');
    if (btn && btn.disabled) return;
    
    if (favThreads.length === 0) {
        alert("お気に入り(★)に登録されたスレッドがありません。");
        return;
    }
    
    if (btn) {
        btn.disabled = true;
        btn.textContent = '巡回中...';
    }
    
    for (const threadUrl of favThreads) {
        if (!threadCache.has(threadUrl)) continue; 
        const cache = threadCache.get(threadUrl);
        await checkForNewImages(threadUrl, cache, true);
    }
    
    if (btn) {
        btn.textContent = '🔄 巡回';
        btn.disabled = false;
    }
}

async function checkForNewImages(threadUrl, cache, isBackground = false) {
    if (cache.images.length === 0) return; 
    const topCachedImageSrc = cache.images[0].src;
    
    let isChecking = true;
    let currentCheckUrl = threadUrl;
    let newlyFoundImages = [];
    
    const indicator = document.getElementById('loading-indicator');
    const loadingStatus = document.getElementById('loading-status');
    
    if (!isBackground) {
        indicator.classList.remove('hidden');
        loadingStatus.textContent = `新着をチェック中...`;
    }
    
    try {
        while (isChecking && currentCheckUrl) {
            const response = await fetch(PROXY_BASE + encodeURIComponent(currentCheckUrl));
            if (!response.ok) break;
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('shift-jis');
            const doc = new DOMParser().parseFromString(decoder.decode(buffer), 'text/html');
            
            const images = doc.querySelectorAll('a[href*="comment_img.php"] img, .picture, img[src*="/upload/"]');
            
            for (let i = 0; i < images.length; i++) {
                const img = images[i];
                const src = img.getAttribute('src');
                if (!src) continue;
                const imgSrcUrl = new URL(src, SITE_URL).href;
                
                if (imgSrcUrl === topCachedImageSrc) {
                    isChecking = false;
                    break;
                }
                
                const parentA = img.closest('a');
                const fullImgUrl = parentA ? new URL(parentA.getAttribute('href'), SITE_URL).href : imgSrcUrl;
                
                const result = doc.evaluate("preceding::a[contains(@href, 'cid=') and contains(text(), '[')][1]", img, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const anchor = result.singleNodeValue;
                let postNumber = "";
                if (anchor) {
                    const match = anchor.textContent.match(/\[\d+\]/);
                    if (match) {
                        postNumber = match[0];
                    }
                }
                
                newlyFoundImages.push({ src: imgSrcUrl, fullUrl: fullImgUrl, isNew: true, threadUrl: threadUrl, postNumber: postNumber });
            }
            
            if (isChecking) {
                currentCheckUrl = getNextPageLink(doc);
                if (currentCheckUrl) await new Promise(r => setTimeout(r, 1000));
            }
        }
        
        if (newlyFoundImages.length > 0) {
            cache.images = [...newlyFoundImages, ...cache.images];
            saveThreadCache();
            updateSidebarThreadStats(threadUrl); // サイドバーバッジ更新
            
            if (threadUrl === activeThreadUrl) {
                newlyFoundImages.reverse().forEach(imgData => {
                    renderImageCard(imgData, true);
                    imgData.isNew = false; // 表示したのでクリア
                });
                saveThreadCache(); // isNew変更を保存
                updateSidebarThreadStats(threadUrl); // バッジを消す
                
                if (!isBackground) {
                    loadingStatus.textContent = `${newlyFoundImages.length}件の新着を追加しました！`;
                    setTimeout(() => { indicator.classList.add('hidden'); }, 3000);
                }
            }
        } else {
            if (!isBackground) indicator.classList.add('hidden');
        }
        
    } catch (error) {
        console.error("新着チェック中にエラー", error);
        indicator.classList.add('hidden');
    }
}

function getNextPageLink(doc) {
    const nextLinkTag = doc.querySelector('link[rel="next"]');
    if (nextLinkTag && nextLinkTag.getAttribute('href')) {
        return new URL(nextLinkTag.getAttribute('href'), SITE_URL).href;
    }
    const allLinks = Array.from(doc.querySelectorAll('a'));
    const nextLinkNode = allLinks.find(a => {
        const href = a.getAttribute('href') || '';
        return a.textContent.includes('▶') && !href.startsWith('javascript:');
    });
    if (nextLinkNode) {
        return new URL(nextLinkNode.getAttribute('href'), SITE_URL).href;
    }
    return null;
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag])
    );
}

/* --- 内蔵コンテキストビューアー機能 --- */
document.getElementById('close-context-modal').addEventListener('click', () => {
    document.getElementById('context-modal').classList.add('hidden');
    document.getElementById('context-iframe').src = 'about:blank'; // 読み込み停止
});

async function openContextModal(baseThreadUrl, postNumber) {
    const modal = document.getElementById('context-modal');
    const loading = document.getElementById('context-loading');
    const loadingText = document.getElementById('context-loading-text');
    const iframe = document.getElementById('context-iframe');
    
    modal.classList.remove('hidden');
    loading.style.display = 'flex';
    loadingText.textContent = `🔍 ${postNumber} の属するページを探索中...`;
    iframe.style.display = 'none';
    iframe.src = 'about:blank';
    
    try {
        let currentScanUrl = baseThreadUrl;
        let foundUrl = null;
        
        for (let i = 0; i < 50; i++) { // 最大50ページ探索
            const response = await fetch(PROXY_BASE + encodeURIComponent(currentScanUrl));
            if (!response.ok) break;
            
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('shift-jis');
            const htmlText = decoder.decode(buffer);
            
            if (htmlText.indexOf(`class="submit">${postNumber}</a>`) !== -1 || htmlText.indexOf(postNumber) !== -1) {
                foundUrl = currentScanUrl;
                break;
            }
            
            const doc = new DOMParser().parseFromString(htmlText, 'text/html');
            const nextUrl = getNextPageLink(doc);
            if (!nextUrl) break;
            currentScanUrl = nextUrl;
            loadingText.textContent = `🔍 ${postNumber} 探索中... (${i + 2}ページ目)`;
        }
        
        if (foundUrl) {
            loadingText.textContent = `🎯 ページを発見！ 描画中...`;
            iframe.onload = () => {
                loading.style.display = 'none';
                iframe.style.display = 'block';
                
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    // xpathで投稿を探す
                    const result = iframeDoc.evaluate(`//a[contains(text(), '${postNumber}') and contains(@class, 'submit')]`, iframeDoc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    let target = result.singleNodeValue;
                    
                    if (!target) {
                        const r2 = iframeDoc.evaluate(`//*[text()='${postNumber}']`, iframeDoc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        target = r2.singleNodeValue;
                    }
                    
                    if (target) {
                        // ツールの力で強制スクロール
                        const focusElem = target.closest('li') || target.parentElement || target;
                        focusElem.style.border = '4px solid #ff4757';
                        focusElem.style.backgroundColor = 'rgba(255, 71, 87, 0.1)';
                        focusElem.scrollIntoView({ behavior: 'auto', block: 'center' });
                    }
                } catch(e) {
                    console.log('Iframe access error:', e);
                }
            };
            // iframeにプロキシURLとして流し込む
            iframe.src = PROXY_BASE + encodeURIComponent(foundUrl);
        } else {
            loading.style.display = 'none';
            alert(`${postNumber} が見つかりませんでした。削除された可能性があります。`);
            modal.classList.add('hidden');
        }
    } catch (e) {
        loading.style.display = 'none';
        alert(`エラーが発生しました: ${e.message}`);
        modal.classList.add('hidden');
    }
}
