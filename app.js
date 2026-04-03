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

// --- 認証管理用の状態 ---
let ACCESS_KEY = localStorage.getItem('PETA2_ACCESS_KEY') || '';
const threadKeys = new Map();     // スレッドごとのパスワード (threadId -> key)

// ロックされているスレッドURLのセット（localStorageから復元）
let savedLocked = [];
try {
    savedLocked = JSON.parse(localStorage.getItem('peta2_locked_threads') || '[]');
} catch (e) {}
const lockedThreads = new Set(savedLocked);

function saveLockedThreads() {
    try {
        localStorage.setItem('peta2_locked_threads', JSON.stringify(Array.from(lockedThreads)));
    } catch (e) {}
}

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

// --- 認証付きFetch共通関数 ---
async function authedFetch(url, options = {}) {
    if (!options.headers) options.headers = {};
    options.headers['X-Access-Key'] = ACCESS_KEY;

    // スレIDを特定して、保存された鍵があればヘッダーに追加
    try {
        const urlObj = new URL(url.startsWith('/') ? window.location.origin + url : url);
        const targetUrlStr = urlObj.searchParams.get('url');
        if (targetUrlStr) {
            const targetUrl = new URL(targetUrlStr);
            const tId = targetUrl.searchParams.get('t');
            if (tId && threadKeys.has(tId)) {
                options.headers['X-Peta2-Item-Key'] = threadKeys.get(tId);
            }
        }
    } catch (e) {}

    const response = await fetch(url, options);
    
    if (response.status === 401) {
        // 認証エラー時はキーを破棄してログイン画面を表示
        ACCESS_KEY = '';
        localStorage.removeItem('PETA2_ACCESS_KEY');
        showAuthOverlay();
        throw new Error('Unauthorized');
    }
    
    return response;
}

// --- スレッドロック判定用ヘルパー ---
function isThreadLocked(html, resUrl = '') {
    if (!html) return false;
    
    // 1. URLによる判定：thread_key.php へのリダイレクトを最優先
    if (resUrl && resUrl.includes('thread_key.php')) {
        return true;
    }

    // 2. HTML構造による判定
    // 入力フォームの name="thread_key" が確実に存在するかをチェック
    // <input ... name="thread_key" ...> の形式を厳格に正規表現で判定
    const hasThreadKeyInput = /<input[^>]+name\s*=\s*["']?thread_key["']?/i.test(html);
    
    // 判定結果を明示的に返す（タイトル検索は誤爆の元なので削除）
    return hasThreadKeyInput;
}

function updateThreadLockState(url, isLocked) {
    if (isLocked) {
        lockedThreads.add(url);
    } else {
        lockedThreads.delete(url);
    }
    saveLockedThreads(); // 状態が変わるたびに保存
    updateSidebarThreadStats(url);
}

function showAuthOverlay() {
    const overlay = document.getElementById('auth-overlay');
    if (overlay) overlay.classList.remove('hidden');
}

function hideAuthOverlay() {
    const overlay = document.getElementById('auth-overlay');
    if (overlay) overlay.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    // 掲示板URL設定
    const urlInput = document.getElementById('target-site-url');
    if (urlInput) urlInput.value = SITE_URL;
    
    // --- 認証UIの初期化 ---
    const authSubmitBtn = document.getElementById('auth-submit-btn');
    const authInput = document.getElementById('access-key-input');
    const authErrorMsg = document.getElementById('auth-error-msg');

    const handleAuthSubmit = async () => {
        const key = authInput.value.trim();
        if (!key) return;
        
        authSubmitBtn.disabled = true;
        authSubmitBtn.textContent = "認証中...";
        authErrorMsg.classList.add('hidden');
        
        try {
            // 仮の通信（スレッド取得）でキーの有効性を確認
            const tempAccessKey = ACCESS_KEY;
            ACCESS_KEY = key;
            
            const res = await fetch(PROXY_BASE + encodeURIComponent(SITE_URL), {
                headers: { 'X-Access-Key': key }
            });

            if (res.ok) {
                // 認証成功
                localStorage.setItem('PETA2_ACCESS_KEY', key);
                hideAuthOverlay();
                fetchThreads(); // メイン処理開始
            } else {
                ACCESS_KEY = tempAccessKey;
                authErrorMsg.textContent = "合言葉が正しくありません。";
                authErrorMsg.classList.remove('hidden');
            }
        } catch (e) {
            authErrorMsg.textContent = "通信エラーが発生しました。";
            authErrorMsg.classList.remove('hidden');
        } finally {
            authSubmitBtn.disabled = false;
            authSubmitBtn.textContent = "認証して開始";
        }
    };

    authSubmitBtn.addEventListener('click', handleAuthSubmit);
    authInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAuthSubmit(); });

    // --- スレッド入室鍵（パスワード）UIの初期化 ---
    const threadAuthOverlay = document.getElementById('thread-auth-overlay');
    const threadKeyInput = document.getElementById('thread-key-input');
    const threadAuthSubmit = document.getElementById('thread-auth-submit');
    const threadAuthCancel = document.getElementById('thread-auth-cancel');
    let pendingThreadId = null;

    const showThreadAuthOverlay = (tId) => {
        console.log('[UI] showThreadAuthOverlay called for tId:', tId);
        pendingThreadId = tId;
        threadKeyInput.value = '';
        threadAuthOverlay.style.display = 'flex';
        threadKeyInput.focus();
    };

    const hideThreadAuthOverlay = () => {
        threadAuthOverlay.style.display = 'none';
        pendingThreadId = null;
    };

    threadAuthSubmit.onclick = () => {
        const key = threadKeyInput.value.trim();
        if (key && pendingThreadId) {
            threadKeys.set(pendingThreadId, key);
            hideThreadAuthOverlay();
            // 現在開こうとしているスレッドを再読み込み
            if (activeThreadUrl) {
                const title = document.getElementById('current-thread-title').textContent;
                // キャッシュを一旦消して再取得
                threadCache.delete(activeThreadUrl);
                initThread(activeThreadUrl, title);
            }
        }
    };

    threadAuthCancel.onclick = hideThreadAuthOverlay;
    threadKeyInput.onkeypress = (e) => { if (e.key === 'Enter') threadAuthSubmit.click(); };

    // スレッド入室鍵のUIを外部から呼べるようにグローバルに公開（一時的）
    window.showThreadAuthOverlay = showThreadAuthOverlay;

    // 初期起動チェック
    if (!ACCESS_KEY) {
        showAuthOverlay();
    } else {
        fetchThreads();
    }
    
    // --- 以下、既存の初期化処理のラップ ---

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
            chip.textContent = url.replace('https://', '').replace(/\/$/, '');
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
        
        SITE_URL_HISTORY = SITE_URL_HISTORY.filter(u => u !== url);
        SITE_URL_HISTORY.push(url);
        if (SITE_URL_HISTORY.length > 20) SITE_URL_HISTORY.shift();
        localStorage.setItem('PETA2_URL_HISTORY', JSON.stringify(SITE_URL_HISTORY));
        renderUrlHistory();

        localStorage.setItem('PETA2_SITE_URL', url);
        SITE_URL = url;
        
        threadCache.clear();
        saveThreadCache();
        activeThreadUrl = null;
        document.getElementById('gallery-container').innerHTML = '';
        
        alert(`対象掲示板を\n${SITE_URL}\nへ変更しました。一覧を再取得します。`);
        document.getElementById('settings-panel').classList.add('hidden');
        fetchThreads();
    });

    document.getElementById('reload-threads-btn').addEventListener('click', fetchThreads);
    document.getElementById('open-scrap-btn').addEventListener('click', openScrapPage);
    
    document.getElementById('thread-sort-select').addEventListener('change', (e) => {
        currentSortMode = e.target.value;
        renderThreadList();
    });

    document.getElementById('thread-fav-btn').addEventListener('click', () => {
        if (!activeThreadUrl || activeThreadUrl === 'SCRAP_PAGE') return;
        toggleFavThread(activeThreadUrl);
    });
    
    const patrolBtn = document.getElementById('patrol-favs-btn');
    if (patrolBtn) patrolBtn.addEventListener('click', patrolFavThreads);
    
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

    const navigateLightbox = (direction) => {
        const newIndex = currentLightboxIndex + direction;
        if (newIndex < 0 || newIndex >= currentGalleryImages.length) return;
        openLightbox(newIndex);
    };
    
    lightbox.addEventListener('click', (e) => {
        if (e.target.id === 'lightbox-overlay') closeLightbox();
    });

    document.getElementById('lightbox-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeLightbox();
    });

    document.getElementById('lightbox-nav-left').addEventListener('click', (e) => {
        e.stopPropagation();
        navigateLightbox(-1);
    });
    document.getElementById('lightbox-nav-right').addEventListener('click', (e) => {
        e.stopPropagation();
        navigateLightbox(1);
    });
    
    document.addEventListener('keydown', (e) => {
        if (lightbox.classList.contains('hidden')) return;
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') navigateLightbox(-1);
        if (e.key === 'ArrowRight') navigateLightbox(1);
    });

    document.getElementById('lightbox-fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentLightboxIndex < 0 || currentLightboxIndex >= currentGalleryImages.length) return;
        const imgData = currentGalleryImages[currentLightboxIndex];
        
        const gallery = document.getElementById('gallery-container');
        const targetCard = gallery.querySelector(`[data-src="${imgData.src}"]`)?.closest('.image-card');
        if (targetCard) {
            const cardFavBtn = targetCard.querySelector('.favorite-btn');
            if (cardFavBtn) cardFavBtn.click();
        }
        updateLightboxFavBtn(imgData);
    });
});

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
    
    counter.textContent = `${index + 1} / ${currentGalleryImages.length}`;
    
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
    
    if (imgData.fullUrl && imgData.fullUrl !== imgData.src) {
        openOrigBtn.href = imgData.fullUrl;
        openOrigBtn.classList.remove('hidden');
    } else {
        openOrigBtn.classList.add('hidden');
    }
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

function saveScraps() {
    try {
        localStorage.setItem('peta2_scraps', JSON.stringify(scraps));
    } catch (e) {
        console.warn("Storage quota exceeded.");
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
    
    const favBtn = document.getElementById('thread-fav-btn');
    const isFav = favThreads.includes(url);
    favBtn.innerHTML = isFav ? '★' : '☆';
    favBtn.className = `thread-fav-btn${isFav ? ' active' : ''}`;
    renderThreadList();
}

function saveThreadCache() {
    try {
        localStorage.setItem('peta2_thread_cache', JSON.stringify(Array.from(threadCache.entries())));
    } catch (e) {
        console.warn("Cache quota exceeded. Purging...");
        // シンプルな最古5件残しパージ
        const entries = Array.from(threadCache.entries());
        if (entries.length > 5) {
            const sliced = entries.slice(-5);
            threadCache.clear();
            sliced.forEach(([k,v]) => threadCache.set(k, v));
            localStorage.setItem('peta2_thread_cache', JSON.stringify(sliced));
        }
    }
}

function updateSidebarThreadStats(url) {
    const li = document.querySelector(`.thread-item[data-url="${url}"]`);
    if (!li) return;
    
    // 常に最新の状態を反映
    const isFav = favThreads.includes(url);
    const isLocked = lockedThreads.has(url);
    const cacheData = threadCache.get(url);

    // お気に入りマーク（★）の制御：以前の状態を尊重
    let starMark = li.querySelector('.thread-fav-star');
    if (isFav) {
        if (!starMark) {
            starMark = document.createElement('span');
            starMark.className = 'thread-fav-star';
            li.appendChild(starMark);
        }
        let badge = '';
        if (cacheData) {
            const newCount = cacheData.images.filter(i => i.isNew).length;
            if (newCount > 0) badge = `<span class="new-count-badge">新着${newCount}</span>`;
        }
        starMark.innerHTML = `${badge}★`;
    } else if (starMark) {
        starMark.remove();
    }

    // 鍵マーク（🔒）の制御：最前面に挿入
    let lockMark = li.querySelector('.lock-icon');
    if (isLocked) {
        if (!lockMark) {
            lockMark = document.createElement('span');
            lockMark.className = 'lock-icon';
            lockMark.textContent = '🔒';
            li.prepend(lockMark);
        }
    } else if (lockMark) {
        lockMark.remove();
    }

    if (cacheData) {
        li.classList.add('read');
        const scrapCount = scraps.filter(s => s.threadUrl === url).length;
        
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
        scraps.splice(idx, 1);
        btnElement.classList.remove('active');
        btnElement.innerHTML = '♡';
        if (activeThreadUrl === 'SCRAP_PAGE') {
            cardElement.remove();
            document.getElementById('total-pages-info').textContent = `全 ${scraps.length} 枚`;
        }
    } else {
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
    updateSidebarThreadStats(activeThreadUrl === 'SCRAP_PAGE' ? imgData.threadUrl : activeThreadUrl);
}

function renderImageCard(imgData, prepend = false) {
    const gallery = document.getElementById('gallery-container');
    if(gallery.querySelector(`[data-src="${imgData.src}"]`)) return;

    const isScraped = scraps.some(s => s.src === imgData.src);
    const card = document.createElement('div');
    card.className = 'image-card';
    card.onclick = () => {
        const allCards = Array.from(gallery.querySelectorAll('.image-card'));
        const idx = allCards.indexOf(card);
        if (idx >= 0) openLightbox(idx);
    };
    
    let innerHtml = `<img src="${imgData.src}" data-src="${imgData.src}" alt="Image" loading="lazy">`;
    if (imgData.isNew) innerHtml += `<div class="new-badge">NEW</div>`;
    card.innerHTML = innerHtml;
    
    if (imgData.threadTitleDisplay && imgData.threadUrl) {
        const titleDiv = document.createElement('div');
        titleDiv.className = 'card-thread-name';
        titleDiv.textContent = imgData.threadTitleDisplay;
        titleDiv.onclick = (e) => {
            e.stopPropagation();
            if (isExtracting || isAutoFetching) return;
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

function openScrapPage() {
    activeThreadUrl = 'SCRAP_PAGE';
    isAutoFetching = false;
    document.querySelectorAll('.thread-item').forEach(el => el.classList.remove('active'));
    document.getElementById('open-scrap-btn').classList.add('active');
    document.getElementById('current-thread-title').textContent = "💖 スクラップブック";
    document.getElementById('total-pages-info').textContent = `全 ${scraps.length} 枚`;
    document.getElementById('auto-fetch-all-btn').classList.add('hidden');
    document.getElementById('thread-fav-btn').classList.add('hidden');
    
    const gallery = document.getElementById('gallery-container');
    gallery.innerHTML = '';
    currentGalleryImages = [];
    
    if (scraps.length === 0) {
        gallery.innerHTML = `<div class="empty-state"><p>スクラップは空です。</p></div>`;
        return;
    }
    
    [...scraps].reverse().forEach(s => {
        renderImageCard({
            src: s.src, fullUrl: s.fullUrl, isNew: false,
            threadTitleDisplay: s.threadTitle, threadUrl: s.threadUrl, postNumber: s.postNumber
        }, false);
    });
}

// --- 認証済みデータ取得 ---
async function fetchThreads() {
    const listContainer = document.getElementById('thread-list');
    listContainer.innerHTML = '<li class="loading-text">スレッドを取得中...</li>';

    try {
        const response = await authedFetch(PROXY_BASE + encodeURIComponent(SITE_URL));
        const contentType = response.headers.get('content-type') || '';
        const charset = contentType.toLowerCase().includes('utf-8') ? 'utf-8' : 'shift-jis';
        
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder(charset);
        const doc = new DOMParser().parseFromString(decoder.decode(buffer), 'text/html');
        
        const listItems = doc.querySelectorAll('.thread-list .list-group-item, #owl-carousel .list-group-item');
        if (listItems.length === 0) {
            listContainer.innerHTML = '<li class="loading-text">スレッドが見つかりません。</li>';
            return;
        }

        const uniqueThreads = [];
        const threadSet = new Set();
        listItems.forEach(item => {
            const aTag = item.querySelector('a');
            if (aTag) {
                let countStr = '';
                const match = item.innerHTML.match(/<\/a>[\s\S]*?\((\d+)\)/i);
                if (match) countStr = match[1];
                
                const url = new URL(aTag.getAttribute('href'), SITE_URL).href;
                if (!threadSet.has(url)) {
                    threadSet.add(url);
                    uniqueThreads.push({
                        url, title: aTag.textContent.trim(), postCount: countStr,
                        meta: item.querySelector('p')?.textContent.trim() || ''
                    });
                }
            }
        });
        currentThreads = uniqueThreads;
        renderThreadList();
    } catch (e) {
        if (e.message !== 'Unauthorized') {
            listContainer.innerHTML = `<li class="loading-text">取得失敗: ${escapeHTML(e.message)}</li>`;
        }
    }
}

function renderThreadList() {
    const listContainer = document.getElementById('thread-list');
    listContainer.innerHTML = '';
    let sorted = [...currentThreads];
    
    if (currentSortMode === 'fav') sorted.sort((a,b) => (favThreads.includes(b.url)?1:0) - (favThreads.includes(a.url)?1:0));
    else if (currentSortMode === 'read') sorted.sort((a,b) => (threadCache.has(b.url)?1:0) - (threadCache.has(a.url)?1:0));
    else if (currentSortMode === 'hearts') sorted.sort((a,b) => scraps.filter(s=>s.threadUrl===b.url).length - scraps.filter(s=>s.threadUrl===a.url).length);
    
    sorted.forEach(data => {
        const li = document.createElement('li');
        li.className = 'thread-item';
        li.setAttribute('data-url', data.url);
        
        li.innerHTML = `<div class="thread-title">${escapeHTML(data.title)} (${data.postCount || '?'})</div><div class="thread-meta">${escapeHTML(data.meta)}</div>`;
        if (data.url === activeThreadUrl) li.classList.add('active');
        
        li.onclick = () => {
            if (isExtracting || isAutoFetching) return;
            document.querySelectorAll('.thread-item').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
            initThread(data.url, data.title);
        };
        listContainer.appendChild(li);
        updateSidebarThreadStats(data.url);
    });
}

function initThread(url, title) {
    document.getElementById('current-thread-title').textContent = title;
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
        
        // ロック中のスレッドを再表示する場合
        if (lockedThreads.has(url)) {
            const tId = new URL(url).searchParams.get('t');
            if (tId && !threadKeys.has(tId)) {
                gallery.innerHTML = '<div style="padding:40px; text-align:center; color:#ff4757; font-size:1.2rem;">🔒 このスレッドの閲覧には「入室鍵」が必要です。</div>';
                if (window.showThreadAuthOverlay) window.showThreadAuthOverlay(tId);
            }
        }

        cache.images.forEach(imgData => {
            renderImageCard(imgData, false);
            imgData.isNew = false;
        });
        saveThreadCache();
        updateSidebarThreadStats(url);
        checkForNewImages(url, cache);
        if (!cache.nextUrlToFetch) {
            autoBtn.disabled = true;
            autoBtn.textContent = "完了";
        }
    } else {
        document.getElementById('total-pages-info').textContent = "読込中...";
        threadCache.set(url, { images: [], nextUrlToFetch: url, totalPages: 1 });
        loadNextPage(true);
    }
}

async function loadNextPage(isFirstPage = false) {
    if (!activeThreadUrl || activeThreadUrl === 'SCRAP_PAGE' || isExtracting) return;
    const cache = threadCache.get(activeThreadUrl);
    if (!cache || !cache.nextUrlToFetch) return;
    isExtracting = true;
    
    const indicator = document.getElementById('loading-indicator');
    const status = document.getElementById('loading-status');
    indicator.classList.remove('hidden');
    status.textContent = `読込中...`;
    
    try {
        const response = await authedFetch(PROXY_BASE + encodeURIComponent(cache.nextUrlToFetch));
        const contentType = response.headers.get('content-type') || '';
        const charset = contentType.toLowerCase().includes('utf-8') ? 'utf-8' : 'shift-jis';

        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder(charset);
        const html = decoder.decode(buffer);
        const resUrl = response.headers.get('x-res-url') || '';
        const doc = new DOMParser().parseFromString(html, 'text/html');
        
        let tId = new URL(cache.nextUrlToFetch).searchParams.get('t');
        if (!tId && resUrl) {
            try { tId = new URL(resUrl).searchParams.get('t'); } catch(e) {}
        }
        if (!tId) {
            const tInput = doc.querySelector('input[name="t"]');
            if (tInput) tId = tInput.value;
        }

        const locked = isThreadLocked(html, resUrl);
        console.log(`[LockCheck] URL: ${cache.nextUrlToFetch} | resUrl: ${resUrl} | locked: ${locked} | tId: ${tId}`);
        updateThreadLockState(activeThreadUrl, locked);

        if (locked) {
            if (window.showThreadAuthOverlay) {
                window.showThreadAuthOverlay(tId || 'UNKNOWN');
                isExtracting = false;
                indicator.classList.add('hidden');
                return;
            }
        }

        if (isFirstPage) {
            let maxP = 1;
            doc.querySelectorAll('a[href*="_ASC.html"], a[href*="_DESC.html"]').forEach(a => {
                const m = a.getAttribute('href').match(/_([0-9]+)_(ASC|DESC)\.html/);
                if (m && parseInt(m[1]) > maxP) maxP = parseInt(m[1]);
            });
            cache.totalPages = maxP;
            document.getElementById('total-pages-info').textContent = maxP > 1 ? `(全 ${maxP} ページ)` : '';
        }
        
        const images = doc.querySelectorAll('a[href*="comment_img.php"] img, .picture, img[src*="/upload/"]');
        images.forEach(img => {
            const src = img.getAttribute('src');
            if (!src) return;
            const imgSrcUrl = new URL(src, SITE_URL).href;
            const parentA = img.closest('a');
            const fullImgUrl = parentA ? new URL(parentA.getAttribute('href'), SITE_URL).href : imgSrcUrl;
            
            const result = doc.evaluate("preceding::a[contains(@href, 'cid=') and contains(text(), '[')][1]", img, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const anchor = result.singleNodeValue;
            let postNum = "";
            if (anchor) {
                const m = anchor.textContent.match(/\[\d+\]/);
                if (m) postNum = m[0];
            }
            
            if (!cache.images.find(i => i.src === imgSrcUrl)) {
                const imgData = { src: imgSrcUrl, fullUrl: fullImgUrl, isNew: false, threadUrl: activeThreadUrl, postNumber: postNum };
                cache.images.push(imgData);
                renderImageCard(imgData, false);
            }
        });
        
        cache.nextUrlToFetch = getNextPageLink(doc);
        if (!cache.nextUrlToFetch) {
            const autoBtn = document.getElementById('auto-fetch-all-btn');
            autoBtn.disabled = true;
            autoBtn.textContent = "完了";
        }
        saveThreadCache();
        updateSidebarThreadStats(activeThreadUrl);
        
    } catch (e) {
        if (e.message !== 'Unauthorized') console.error(e);
    } finally {
        isExtracting = false;
        if (!isAutoFetching) indicator.classList.add('hidden');
    }
}

async function patrolFavThreads() {
    const btn = document.getElementById('patrol-favs-btn');
    if (btn && btn.disabled) return;
    if (favThreads.length === 0) return alert("お気に入りがありません。");
    
    btn.disabled = true; btn.textContent = '巡回中...';
    for (const url of favThreads) {
        const cache = threadCache.get(url);
        if (cache) await checkForNewImages(url, cache, true);
    }
    btn.textContent = '🔄巡回'; btn.disabled = false;
}

async function checkForNewImages(url, cache, isBackground = false) {
    // 画像が0枚でも、ロックされている可能性や初回失敗の可能性があるためチェックを続行する
    const topSrc = cache.images.length > 0 ? cache.images[0].src : null;
    let isChecking = true, currentUrl = url, newImgs = [];
    
    if (!isBackground) {
        document.getElementById('loading-indicator').classList.remove('hidden');
        document.getElementById('loading-status').textContent = `新着チェック...`;
    }
    
    try {
        while (isChecking && currentUrl) {
            const response = await authedFetch(PROXY_BASE + encodeURIComponent(currentUrl));
            const contentType = response.headers.get('content-type') || '';
            const charset = contentType.toLowerCase().includes('utf-8') ? 'utf-8' : 'shift-jis';

            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder(charset);
            const html = decoder.decode(buffer);
            const resUrl = response.headers.get('x-res-url') || '';

            // ロック判定 (最終URLによるリダイレクト検知を含む)
            const locked = isThreadLocked(html, resUrl);
            updateThreadLockState(url, locked);
            if (locked) {
                if (url === activeThreadUrl) {
                    const tId = new URL(currentUrl).searchParams.get('t');
                    if (tId && !threadKeys.has(tId)) {
                        if (window.showThreadAuthOverlay) window.showThreadAuthOverlay(tId);
                        isChecking = false;
                        if (!isBackground) document.getElementById('loading-indicator').classList.add('hidden');
                        return;
                    }
                }
                isChecking = false;
                break;
            }

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const imgs = doc.querySelectorAll('a[href*="comment_img.php"] img, .picture, img[src*="/upload/"]');
            
            for (let i = 0; i < imgs.length; i++) {
                const src = new URL(imgs[i].getAttribute('src'), SITE_URL).href;
                if (src === topSrc) { isChecking = false; break; }
                const parentA = imgs[i].closest('a');
                const full = parentA ? new URL(parentA.getAttribute('href'), SITE_URL).href : src;
                const r = doc.evaluate("preceding::a[contains(@href, 'cid=') and contains(text(), '[')][1]", imgs[i], null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                let pNum = r.singleNodeValue ? (r.singleNodeValue.textContent.match(/\[\d+\]/)||[ ""])[0] : "";
                newImgs.push({ src, fullUrl: full, isNew: true, threadUrl: url, postNumber: pNum });
            }
            if (isChecking) {
                currentUrl = getNextPageLink(doc);
                if (currentUrl) await new Promise(r => setTimeout(r, 1000));
            }
        }
        if (newImgs.length > 0) {
            cache.images = [...newImgs, ...cache.images];
            saveThreadCache();
            updateSidebarThreadStats(url);
            if (url === activeThreadUrl) {
                newImgs.reverse().forEach(d => { renderImageCard(d, true); d.isNew = false; });
                saveThreadCache();
                updateSidebarThreadStats(url);
            }
        }
    } catch (e) {} finally {
        if (!isBackground) document.getElementById('loading-indicator').classList.add('hidden');
    }
}

function getNextPageLink(doc) {
    const next = doc.querySelector('link[rel="next"]');
    if (next && next.getAttribute('href')) return new URL(next.getAttribute('href'), SITE_URL).href;
    const node = Array.from(doc.querySelectorAll('a')).find(a => a.textContent.includes('▶') && !(a.getAttribute('href')||'').startsWith('javascript:'));
    return node ? new URL(node.getAttribute('href'), SITE_URL).href : null;
}

function escapeHTML(str) {
    return (str||'').replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t]));
}

document.getElementById('close-context-modal').onclick = () => {
    document.getElementById('context-modal').classList.add('hidden');
    document.getElementById('context-iframe').src = 'about:blank';
};

async function openContextModal(baseUrl, postNumber) {
    const modal = document.getElementById('context-modal');
    const loading = document.getElementById('context-loading');
    const iframe = document.getElementById('context-iframe');
    modal.classList.remove('hidden');
    loading.style.display = 'flex';
    iframe.style.display = 'none';
    
    try {
        let scanUrl = baseUrl, found = null;
        for (let i = 0; i < 50; i++) {
            const res = await authedFetch(PROXY_BASE + encodeURIComponent(scanUrl));
            const txt = new TextDecoder('shift-jis').decode(await res.arrayBuffer());
            if (txt.includes(`class="submit">${postNumber}</a>`) || txt.includes(postNumber)) {
                found = scanUrl; break;
            }
            const d = new DOMParser().parseFromString(txt, 'text/html');
            const n = getNextPageLink(d);
            if (!n) break;
            scanUrl = n;
        }
        if (found) {
            iframe.onload = () => {
                loading.style.display = 'none'; iframe.style.display = 'block';
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    const res = doc.evaluate(`//a[contains(text(), '${postNumber}') and contains(@class, 'submit')]`, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    let target = res.singleNodeValue || doc.evaluate(`//*[text()='${postNumber}']`, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (target) {
                        const focus = target.closest('li') || target.parentElement || target;
                        focus.style.border = '4px solid #ff4757';
                        focus.style.backgroundColor = 'rgba(255, 71, 87, 0.1)';
                        focus.scrollIntoView({ behavior: 'auto', block: 'center' });
                    }
                } catch(e) {}
            };
            iframe.src = PROXY_BASE + encodeURIComponent(found);
        } else {
            alert("見つかりませんでした。"); modal.classList.add('hidden');
        }
    } catch (e) {
        alert(e.message); modal.classList.add('hidden');
    } finally { loading.style.display = 'none'; }
}
