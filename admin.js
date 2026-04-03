// admin.js
// 管理画面のフロントエンドロジック

document.addEventListener('DOMContentLoaded', () => {
    const loginSection = document.getElementById('login-section');
    const managementSection = document.getElementById('management-section');
    const adminPasswordInput = document.getElementById('admin-password');
    const loginBtn = document.getElementById('login-btn');
    const loginMsg = document.getElementById('login-msg');

    const keyListUl = document.getElementById('key-list-ul');
    const newKeyInput = document.getElementById('new-key-input');
    const addBtn = document.getElementById('add-btn');
    const refreshBtn = document.getElementById('refresh-btn');
    const manageMsg = document.getElementById('manage-msg');
    const logoutBtn = document.getElementById('logout-btn');

    let adminPassword = sessionStorage.getItem('adminPassword') || '';

    // 初期化: すでにパスワードがある場合は一覧取得を試みる
    if (adminPassword) {
        showManagement();
        refreshKeys();
    }

    // ログイン処理
    loginBtn.addEventListener('click', async () => {
        const pw = adminPasswordInput.value.trim();
        if (!pw) return showMsg(loginMsg, 'パスワードを入力してください', 'error');

        adminPassword = pw;
        const success = await refreshKeys(true);
        if (success) {
            sessionStorage.setItem('adminPassword', pw);
            showManagement();
        }
    });

    // ログアウト処理
    logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        sessionStorage.removeItem('adminPassword');
        location.reload();
    });

    // 合言葉の追加
    addBtn.addEventListener('click', async () => {
        const key = newKeyInput.value.trim();
        if (!key) return showMsg(manageMsg, '合言葉を入力してください', 'error');

        const res = await callAdminApi('add', key);
        if (res.ok) {
            newKeyInput.value = '';
            showMsg(manageMsg, '新しい合言葉を追加しました', 'success');
            refreshKeys();
        } else {
            const data = await res.json();
            showMsg(manageMsg, `エラー: ${data.error}`, 'error');
        }
    });

    // 更新ボタン
    refreshBtn.addEventListener('click', () => refreshKeys());

    // 一覧更新
    async function refreshKeys(isInitial = false) {
        const res = await callAdminApi('list');
        if (res.ok) {
            const data = await res.json();
            renderKeys(data.keys);
            return true;
        } else {
            if (isInitial) {
                showMsg(loginMsg, '認証に失敗しました。正しいパスワードを入力してください。', 'error');
            } else if (res.status === 401) {
                alert('セッションが切れました。再ログインしてください。');
                location.reload();
            }
            return false;
        }
    }

    // 合言葉の削除
    async function deleteKey(key) {
        if (!confirm(`合言葉「${key}」を削除してもよろしいですか？`)) return;

        const res = await callAdminApi('delete', key);
        if (res.ok) {
            showMsg(manageMsg, '合言葉を削除しました', 'success');
            refreshKeys();
        } else {
            const data = await res.json();
            showMsg(manageMsg, `エラー: ${data.error}`, 'error');
        }
    }

    // API呼び出し共通関数
    async function callAdminApi(action, key = null) {
        return fetch('/api/admin', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Password': adminPassword
            },
            body: JSON.stringify({ action, key })
        });
    }

    // 描画処理
    function renderKeys(keys) {
        keyListUl.innerHTML = '';
        if (keys.length === 0) {
            keyListUl.innerHTML = '<li class="subtitle">有効な合言葉はありません</li>';
            return;
        }

        keys.forEach(k => {
            const li = document.createElement('li');
            li.className = 'key-item';
            li.innerHTML = `
                <span class="key-text">${escapeHtml(k)}</span>
                <button class="del-btn">削除</button>
            `;
            li.querySelector('.del-btn').addEventListener('click', () => deleteKey(k));
            keyListUl.appendChild(li);
        });
    }

    function showManagement() {
        loginSection.classList.add('hidden');
        managementSection.classList.remove('hidden');
    }

    function showMsg(el, text, type) {
        el.textContent = text;
        el.className = `msg ${type}`;
        el.classList.remove('hidden');
        if (type === 'success') {
            setTimeout(() => el.classList.add('hidden'), 3000);
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});
